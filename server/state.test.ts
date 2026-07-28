import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalStateError,
  LocalStateStore,
  MAX_THREADS_PER_PROJECT,
  projectThreadStatus,
} from "./state.ts";

async function fixtureStore(): Promise<{ directory: string; store: LocalStateStore }> {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  return { directory, store: new LocalStateStore(directory) };
}

test("versioned projects, threads, turns, messages, activities, and sessions rebuild deterministically", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Inspect the change",
    mode: "plan",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "session_started",
    sessionId: "session-1",
    model: "sonnet",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: "The change is safe.",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: 0.01,
  });

  const first = await store.load();
  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt, first);
  assert.equal(rebuilt.schemaVersion, 2);
  assert.equal(rebuilt.projects[0].schemaVersion, 2);
  assert.equal(rebuilt.threads[0].schemaVersion, 2);
  assert.equal(rebuilt.threads[0].settledAt, null);
  assert.equal(rebuilt.threads[0].wokeAt, null);
  assert.equal(rebuilt.threads[0].lastVisitedAt, null);
  assert.equal(rebuilt.turns[0].status, "completed");
  assert.equal(rebuilt.turns[0].mode, "plan");
  assert.deepEqual(rebuilt.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(rebuilt.activities[0].name, "Read");
  assert.ok(
    rebuilt.messages[1]!.eventSequence! < rebuilt.activities[0]!.eventSequence!,
    "provider records retain their shared event-log order across collections",
  );
  assert.equal(rebuilt.providerSessions[0].sessionId, "session-1");
});

test("attention states and provider run identity survive reload", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Change the fixture",
    mode: "build",
    provider: "claude-code",
  });
  await store.bindProviderRun(turn.id, "run-1");
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_pending",
    id: "approval-1",
    runId: "run-1",
    conversationId: "conversation-1",
    repository: "/fixture",
    worktree: "/fixture",
    toolCallId: "tool-1",
    toolName: "Write",
    scope: { summary: "Write a file", target: "fixture.ts", details: [] },
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  let rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.turns[0].status, "waiting_for_approval");
  assert.equal(rebuilt.turns[0].providerRunId, "run-1");

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_resolved",
    id: "approval-1",
    state: "allowed_once",
  });
  rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.turns[0].status, "active");
});

test("typed provider failures survive reload without arbitrary error text", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const first = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Use a dynamic tool",
    mode: "build",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(first.thread.id, first.turn.id, "codex-cli", {
    kind: "failed",
    code: "unsupported_external_tool",
    message: "untrusted provider text",
  });
  const second = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Fail generically",
    mode: "build",
    provider: "codex-cli",
    threadId: first.thread.id,
  });
  await store.recordProviderEvent(second.thread.id, second.turn.id, "codex-cli", {
    kind: "failed",
    message: "secret subprocess dump",
  });
  const third = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Fail on a protocol mismatch",
    mode: "build",
    provider: "codex-cli",
    threadId: first.thread.id,
  });
  await store.recordProviderEvent(third.thread.id, third.turn.id, "codex-cli", {
    kind: "failed",
    code: "provider_protocol_error",
    message: "Codex app-server emitted an unsupported notification.",
  });
  const fourth = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Attempt forged typed diagnostics",
    mode: "build",
    provider: "codex-cli",
    threadId: first.thread.id,
  });
  await store.recordProviderEvent(fourth.thread.id, fourth.turn.id, "codex-cli", {
    kind: "failed",
    code: "provider_protocol_error",
    message: "Unsupported Codex notification: ghp_raw-secret-value.",
  });

  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.activities.map((activity) => activity.message), [
    "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
    "Provider failed.",
    "Codex app-server emitted an unsupported notification.",
    "Provider failed.",
  ]);
});

test("host restart marks orphaned active and approval turns interrupted", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const first = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Keep running",
    mode: "ask",
    provider: "claude-code",
  });
  const second = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Wait for approval",
    mode: "build",
    threadId: first.thread.id,
    provider: "claude-code",
  });
  await store.recordProviderEvent(second.thread.id, second.turn.id, "claude-code", {
    kind: "approval_pending",
    id: "approval-1",
    runId: "run-1",
    conversationId: "conversation-1",
    repository: "/fixture",
    worktree: "/fixture",
    toolCallId: "tool-1",
    toolName: "Write",
    scope: { summary: "Write a file", target: "fixture.ts", details: [] },
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const restarted = new LocalStateStore(directory);
  await restarted.recoverInterruptedTurns();
  const projection = await restarted.load();
  assert.deepEqual(projection.turns.map((turn) => turn.status), ["interrupted", "interrupted"]);
  assert.ok(projection.turns.every((turn) => turn.completedAt));
});

test("concurrent writes remain strictly ordered and crash-safe", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: `Turn ${index}`,
    mode: "ask",
    provider: "claude-code",
  })));

  const projection = await new LocalStateStore(directory).load();
  const contents = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  const sequences = contents.trim().split("\n").map((line) => JSON.parse(line).sequence);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  assert.equal(projection.threads.length, 12);
  assert.equal(projection.turns.length, 12);
  assert.equal(projection.messages.length, 12);
});

test("new conversations stop at the bounded per-project retention limit", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  for (let index = 0; index < MAX_THREADS_PER_PROJECT; index += 1) {
    await store.startTurn({
      projectId: "project-1",
      worktree: "/fixture",
      prompt: `Turn ${index}`,
      mode: "ask",
    });
  }
  await assert.rejects(
    () => store.startTurn({
      projectId: "project-1",
      worktree: "/fixture",
      prompt: "One too many",
      mode: "ask",
    }),
    (error: unknown) => error instanceof LocalStateError && error.status === 429,
  );
});

test("existing conversations cannot silently change their bound worktree", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "Fixture", root: "/repo" });
  const first = await store.startTurn({
    projectId: "project-1",
    worktree: "/repo/worktree-a",
    prompt: "Start here",
    mode: "ask",
    provider: "claude-code",
  });
  await assert.rejects(() => store.startTurn({
    projectId: "project-1",
    worktree: "/repo/worktree-b",
    prompt: "Move silently",
    mode: "ask",
    provider: "claude-code",
    threadId: first.thread.id,
  }), /bound to a different canonical worktree/);
  assert.equal((await store.load()).threads[0].worktree, "/repo/worktree-a");
});

test("corruption and incompatible schemas fail visibly without discarding history", async () => {
  const corrupt = await fixtureStore();
  await writeFile(join(corrupt.directory, "events.v1.jsonl"), "{\"schemaVersion\":1", "utf8");
  await assert.rejects(
    () => new LocalStateStore(corrupt.directory).load(),
    (error: unknown) => error instanceof LocalStateError && /corrupt at line 1/.test(error.message),
  );

  const incompatible = await fixtureStore();
  await writeFile(
    join(incompatible.directory, "events.v1.jsonl"),
    `${JSON.stringify({ schemaVersion: 3, sequence: 1, id: "event", recordedAt: "now", event: {} })}\n`,
    "utf8",
  );
  await assert.rejects(
    () => new LocalStateStore(incompatible.directory).load(),
    (error: unknown) => error instanceof LocalStateError && /incompatible schema/.test(error.message),
  );
});

test("project deletion and retention physically remove sensitive conversation data", async () => {
  const deleted = await fixtureStore();
  await deleted.store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await deleted.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "secret prompt sentinel",
    mode: "build",
    provider: "claude-code",
  });
  await deleted.store.deleteProject("project-1");
  assert.deepEqual(await deleted.store.load(), {
    schemaVersion: 2,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [],
    messages: [],
    activities: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
  });
  assert.equal((await readFile(join(deleted.directory, "events.v1.jsonl"), "utf8")).includes("sentinel"), false);

  const retained = await fixtureStore();
  await retained.store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await retained.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "expired sensitive prompt",
    mode: "build",
    provider: "claude-code",
  });
  await retained.store.enforceRetention(new Date(Date.now() + 60_000));
  const projection = await retained.store.load();
  assert.equal(projection.projects.length, 1);
  assert.equal(projection.threads.length, 0);
  assert.equal((await readFile(join(retained.directory, "events.v1.jsonl"), "utf8")).includes("sensitive"), false);
});

test("version-one history loads with null thread lifecycle timestamps", async () => {
  const { directory } = await fixtureStore();
  const recordedAt = "2026-01-01T00:00:00.000Z";
  const project = {
    schemaVersion: 1,
    id: "project-1",
    name: "fixture",
    root: "/fixture",
    openedAt: recordedAt,
  };
  const thread = {
    schemaVersion: 1,
    id: "thread-1",
    projectId: "project-1",
    title: "Legacy conversation",
    worktree: "/fixture",
    provider: "claude-code",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    pinnedAt: null,
    archivedAt: null,
  };
  const lines = [
    {
      schemaVersion: 1,
      sequence: 1,
      id: "event-1",
      recordedAt,
      event: { type: "project_saved", project },
    },
    {
      schemaVersion: 1,
      sequence: 2,
      id: "event-2",
      recordedAt,
      event: { type: "thread_saved", thread },
    },
  ].map((envelope) => JSON.stringify(envelope));
  await writeFile(join(directory, "events.v1.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const projection = await new LocalStateStore(directory).load();
  assert.equal(projection.schemaVersion, 2);
  assert.equal(projection.projects[0].schemaVersion, 2);
  assert.equal(projection.threads[0].schemaVersion, 2);
  assert.equal(projection.threads[0].id, "thread-1");
  assert.equal(projection.threads[0].title, "Legacy conversation");
  assert.equal(projection.threads[0].settledAt, null);
  assert.equal(projection.threads[0].wokeAt, null);
  assert.equal(projection.threads[0].lastVisitedAt, null);
  assert.equal(projection.threads[0].archivedAt, null);
  assert.equal(projection.threads[0].reasoningEffort, undefined);
});

test("conversation lifecycle persists and rebuilds with deterministic pin ordering fields", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Original title",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: 0,
  });
  await store.renameConversation(thread.id, "Renamed conversation");
  await store.setConversationPinned(thread.id, true);
  await store.archiveConversation(thread.id);

  let rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.threads[0].title, "Renamed conversation");
  assert.ok(rebuilt.threads[0].pinnedAt);
  assert.ok(rebuilt.threads[0].archivedAt);

  await store.restoreConversation(thread.id);
  rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.threads[0].archivedAt, null);
});

test("archive and delete reject active and unresolved conversations at the state boundary", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Keep this active",
    mode: "build",
    provider: "claude-code",
  });
  await assert.rejects(() => store.archiveConversation(thread.id), /provider work is active/);
  await assert.rejects(() => store.previewConversationDeletion(thread.id), /provider work is active/);
  await assert.rejects(() => store.deleteConversation(thread.id), /provider work is active/);
});

test("conversation deletion previews and physically compacts only conversation-owned local data", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/worktree-that-must-survive",
    prompt: "conversation secret sentinel",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: "assistant secret sentinel",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-secret-sentinel",
    costUsd: 0,
  });

  assert.deepEqual(await store.previewConversationDeletion(thread.id), {
    thread: 1,
    turns: 1,
    messages: 2,
    activities: 0,
    providerSessions: 1,
    checkpoints: 0,
    annotations: 0,
    fileReviews: 0,
    forks: 0,
  });
  const deletion = await store.deleteConversation(thread.id);
  assert.equal(deletion.status, "completed");

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.projects.length, 1);
  assert.equal(rebuilt.projects[0].root, "/fixture");
  assert.equal(rebuilt.threads.length, 0);
  assert.equal(rebuilt.turns.length, 0);
  assert.equal(rebuilt.messages.length, 0);
  assert.equal(rebuilt.providerSessions.length, 0);
  assert.equal(rebuilt.conversationDeletions[0].status, "completed");
  const persisted = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal(persisted.includes("secret sentinel"), false);
  assert.equal(persisted.includes("worktree-that-must-survive"), false);
});

test("state compaction preserves message and activity event order", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const removed = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/removed",
    prompt: "Remove this conversation",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(removed.thread.id, removed.turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "removed-session",
    costUsd: 0,
  });
  const survivor = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/survivor",
    prompt: "Keep this conversation",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(survivor.thread.id, survivor.turn.id, "claude-code", {
    kind: "assistant_text",
    text: "Before tool.",
  });
  await store.recordProviderEvent(survivor.thread.id, survivor.turn.id, "claude-code", {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(survivor.thread.id, survivor.turn.id, "claude-code", {
    kind: "assistant_text",
    text: "After tool.",
  });
  await store.recordProviderEvent(survivor.thread.id, survivor.turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "survivor-session",
    costUsd: 0,
  });

  await store.deleteConversation(removed.thread.id);
  const rebuilt = await new LocalStateStore(directory).load();
  const orderedKinds = [
    ...rebuilt.messages
      .filter((message) => message.turnId === survivor.turn.id)
      .map((message) => ({
        sequence: message.eventSequence!,
        kind: message.role === "user" ? "user" : "assistant",
      })),
    ...rebuilt.activities
      .filter((activity) => activity.turnId === survivor.turn.id)
      .map((activity) => ({ sequence: activity.eventSequence!, kind: activity.kind })),
  ]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ kind }) => kind);
  assert.deepEqual(orderedKinds, ["user", "assistant", "tool_started", "assistant"]);
});

test("only allowlisted provider fields are persisted", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "safe prompt",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "failed",
    message: "credential=raw-secret-value",
  });
  const contents = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal(contents.includes("process.env"), false);
  assert.equal(contents.includes("credential"), false);
  assert.equal(contents.includes("raw-secret-value"), false);
});

test("checkpoint states rebuild and are removed with their conversation", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Create a checkpoint",
  });
  const createdAt = new Date().toISOString();
  await store.saveCheckpoint({
    id: "checkpoint-1",
    turnId: turn.id,
    threadId: thread.id,
    worktree: "/fixture",
    gitDirectory: "/fixture/.git",
    baselineHead: "baseline-head",
    baselineIdentity: "baseline-tree",
    baselineIndexIdentity: "baseline-index",
    completedIdentity: null,
    completedIndexIdentity: null,
    completedHead: null,
    state: "baseline",
    message: null,
    createdAt,
  });
  await store.saveCheckpoint({
    ...(await store.load()).checkpoints[0],
    completedIdentity: "completed-tree",
    completedIndexIdentity: "completed-index",
    completedHead: "baseline-head",
    state: "completed",
  });
  await store.saveCheckpoint({
    ...(await store.load()).checkpoints[0],
    id: "checkpoint-2",
    worktree: "/other-worktree",
    baselineIdentity: "other-baseline",
    completedIdentity: "other-completed",
    state: "completed",
  });
  await store.supersedeCompletedCheckpoints(thread.id, "/other-worktree", "checkpoint-2");

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.checkpoints.length, 2);
  assert.equal(rebuilt.checkpoints[0].state, "completed");
  assert.equal(rebuilt.checkpoints[0].baselineIdentity, "baseline-tree");
  assert.equal(rebuilt.checkpoints[1].state, "completed");

  await store.deleteProject("project-1");
  assert.equal((await store.load()).checkpoints.length, 0);
  assert.equal((await readFile(join(directory, "events.v1.jsonl"), "utf8")).includes("baseline-tree"), false);
});

test("diff annotations survive restart, resolve explicitly, and follow conversation retention", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Review this diff",
    mode: "ask",
    provider: "claude-code",
  });
  await store.saveAnnotation({
    id: "annotation-1",
    threadId: thread.id,
    checkpointId: null,
    diffIdentity: "diff-identity",
    path: "src/example.ts",
    previousPath: null,
    targetState: "modified",
    scope: "line",
    side: "addition",
    oldLine: null,
    newLine: 4,
    text: "sensitive annotation sentinel",
    capturedContext: "+const enabled = true;",
    resolution: "unresolved",
    createdAt: new Date().toISOString(),
  });

  let restarted = new LocalStateStore(directory);
  assert.equal((await restarted.load()).annotations[0].resolution, "unresolved");
  await restarted.setAnnotationResolution("annotation-1", thread.id, "resolved");
  restarted = new LocalStateStore(directory);
  assert.equal((await restarted.load()).annotations[0].resolution, "resolved");

  await restarted.enforceRetention(new Date(Date.now() + 60_000));
  assert.equal((await restarted.load()).annotations.length, 0);
  assert.equal(
    (await readFile(join(directory, "events.v1.jsonl"), "utf8")).includes("annotation sentinel"),
    false,
  );
});

test("an existing conversation cannot silently switch provider state", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Start with Codex",
    mode: "build",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
    kind: "session_started",
    sessionId: "codex-thread",
    model: "gpt-5.6",
  });
  await assert.rejects(
    () => store.startTurn({
      projectId: "project-1",
      worktree: "/fixture",
      prompt: "Switch provider",
      mode: "build",
      threadId: thread.id,
      provider: "claude-code",
    }),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
});

test("Codex reasoning effort persists across turns and restart", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Start with low effort",
    mode: "ask",
    provider: "codex-cli",
    reasoningEffort: "low",
  });
  assert.equal(thread.reasoningEffort, "low");

  await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Continue with high effort",
    mode: "ask",
    provider: "codex-cli",
    reasoningEffort: "high",
    threadId: thread.id,
  });

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.threads[0].reasoningEffort, "high");
});

test("cross-provider fork previews and persists only allowlisted conversation context", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Inspect the boundary",
    mode: "plan",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "session_started",
    sessionId: "native-secret-session",
    model: "sonnet",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "tool_started",
    toolCallId: "raw-tool-call",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: "The boundary is explicit.",
  });

  const preview = await store.previewFork(thread.id);
  assert.deepEqual(preview.messages.map((message) => message.text), [
    "Inspect the boundary",
    "The boundary is explicit.",
  ]);
  assert.equal(preview.prompt.includes("native-secret-session"), false);
  assert.equal(preview.prompt.includes("raw-tool-call"), false);
  assert.equal(preview.files.length, 0);
  assert.equal(preview.summaries.length, 0);

  const sourceBefore = structuredClone((await store.load()).threads[0]);
  const created = await store.createFork({
    sourceThreadId: thread.id,
    provider: "codex-cli",
    profileId: null,
    model: "default",
    worktree: "/fixture",
    expectedDigest: preview.digest,
  });
  assert.equal(created.thread.parentThreadId, thread.id);
  assert.equal(created.thread.provider, "codex-cli");
  assert.equal(created.fork.status, "pending");
  assert.equal(await store.pendingForkPrompt(created.thread.id), preview.prompt);
  assert.deepEqual((await store.load()).threads[0], sourceBefore);

  await store.markForkStarted(created.thread.id);
  assert.equal(await store.pendingForkPrompt(created.thread.id), null);
  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.forks[0].status, "started");
  await store.deleteConversation(created.thread.id);
  const afterDeletion = await store.load();
  assert.equal(afterDeletion.forks.length, 0);
  assert.equal(afterDeletion.threads.length, 1);
});

test("settle and unsettle are idempotent and never archive the conversation", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/worktree-must-remain",
    prompt: "Finish this",
    mode: "ask",
    provider: "claude-code",
  });
  await assert.rejects(() => store.settleConversation(thread.id), /provider work is active/);
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: 0,
  });
  const settled = await store.settleConversation(thread.id);
  assert.ok(settled.settledAt);
  assert.equal(settled.archivedAt ?? null, null);
  const again = await store.settleConversation(thread.id);
  assert.equal(again.settledAt, settled.settledAt);
  const unsettled = await store.unsettleConversation(thread.id);
  assert.equal(unsettled.settledAt, null);
  assert.equal((await store.unsettleConversation(thread.id)).settledAt, null);
  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.threads[0].settledAt, null);
  assert.equal(rebuilt.threads[0].worktree, "/fixture/worktree-must-remain");
  assert.equal(rebuilt.threads[0].archivedAt ?? null, null);
});

test("thread status projection and wokeAt track operator-attention transitions", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Need approval",
    mode: "build",
    provider: "claude-code",
  });
  let projection = await store.load();
  assert.equal(projectThreadStatus(projection, thread.id).status, "running");

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_pending",
    id: "approval-1",
    runId: "run-1",
    conversationId: "conversation-1",
    repository: "/fixture",
    worktree: "/fixture",
    toolCallId: "tool-1",
    toolName: "Write",
    scope: { summary: "Write a file", target: "fixture.ts", details: [] },
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  projection = await store.load();
  const approvalStatus = projectThreadStatus(projection, thread.id);
  assert.equal(approvalStatus.status, "pending_approval");
  assert.ok(projection.threads[0].wokeAt);
  assert.equal(approvalStatus.since, projection.threads[0].wokeAt);

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_resolved",
    id: "approval-1",
    state: "allowed_once",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "failed",
    message: "provider blew up",
  });
  projection = await store.load();
  assert.equal(projectThreadStatus(projection, thread.id).status, "failed");
  assert.ok(projection.threads[0].wokeAt);

  await store.markConversationVisited(thread.id);
  projection = await store.load();
  assert.ok(projection.threads[0].lastVisitedAt);
  assert.ok(projection.threads[0].lastVisitedAt! >= projection.threads[0].wokeAt!);
});

test("file reviews are keyed by content identity and follow conversation retention", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Review files",
    mode: "ask",
    provider: "claude-code",
  });
  const first = await store.setFileReview({
    threadId: thread.id,
    path: "src/example.ts",
    previousPath: null,
    diffIdentity: "content-identity-a",
    reviewed: true,
  });
  assert.equal(first.reviewed, true);
  assert.ok(first.reviewedAt);
  // Same path with a new content identity is a new review row (rebase-safe).
  const afterRebase = await store.setFileReview({
    threadId: thread.id,
    path: "src/example.ts",
    previousPath: null,
    diffIdentity: "content-identity-b",
    reviewed: false,
  });
  assert.notEqual(afterRebase.id, first.id);
  const again = await store.setFileReview({
    threadId: thread.id,
    path: "src/example.ts",
    previousPath: null,
    diffIdentity: "content-identity-a",
    reviewed: false,
  });
  assert.equal(again.id, first.id);
  assert.equal(again.reviewed, false);
  assert.equal(again.reviewedAt, null);

  let rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.fileReviews.length, 2);

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: 0,
  });
  await store.deleteConversation(thread.id);
  rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.fileReviews.length, 0);
});

test("cross-provider fork fails closed when reviewed context changes", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Initial context",
    mode: "ask",
    provider: "claude-code",
  });
  const preview = await store.previewFork(thread.id);
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: "Context changed.",
  });
  await assert.rejects(
    () => store.createFork({
      sourceThreadId: thread.id,
      provider: "codex-cli",
      profileId: null,
      model: "default",
      worktree: "/fixture",
      expectedDigest: preview.digest,
    }),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
  assert.equal((await store.load()).forks.length, 0);
  assert.equal((await store.load()).threads.length, 1);
});

test("fork preview coalesces consecutive assistant stream chunks", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "How to install",
    mode: "ask",
    provider: "claude-code",
  });
  for (const text of ["Hello", " ", "world", "!"]) {
    await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
      kind: "assistant_text",
      text,
    });
  }
  const preview = await store.previewFork(thread.id);
  assert.deepEqual(preview.messages.map((message) => ({ role: message.role, text: message.text })), [
    { role: "user", text: "How to install" },
    { role: "assistant", text: "Hello world!" },
  ]);
  assert.equal(preview.messages.length, 2);
});
