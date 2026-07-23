import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStateError, LocalStateStore, MAX_THREADS_PER_PROJECT } from "./state.ts";

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
  assert.equal(rebuilt.schemaVersion, 1);
  assert.equal(rebuilt.projects[0].schemaVersion, 1);
  assert.equal(rebuilt.threads[0].schemaVersion, 1);
  assert.equal(rebuilt.turns[0].status, "completed");
  assert.equal(rebuilt.turns[0].mode, "plan");
  assert.deepEqual(rebuilt.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(rebuilt.activities[0].name, "Read");
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
    `${JSON.stringify({ schemaVersion: 2, sequence: 1, id: "event", recordedAt: "now", event: {} })}\n`,
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
    schemaVersion: 1,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [],
    messages: [],
    activities: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
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
