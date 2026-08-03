import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalStateError,
  LocalStateStore,
  MAX_THREADS_PER_PROJECT,
  projectDelegatedConversationOutcomes,
  projectThreadStatus,
} from "./state.ts";

async function fixtureStore(): Promise<{ directory: string; store: LocalStateStore }> {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  return { directory, store: new LocalStateStore(directory) };
}

test("fresh stores create a missing state directory before the first write", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-state-parent-"));
  const directory = join(parent, "state");
  const store = new LocalStateStore(directory);
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  assert.equal((await store.load()).projects[0].id, "project-1");
});

test("versioned projects, threads, turns, messages, activities, and sessions rebuild deterministically", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Inspect the change",
    mode: "plan",
    provider: "claude-code",
    model: "claude-sonnet-5",
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
  assert.equal(rebuilt.threads[0].workspaceMode, "shared");
  assert.equal(rebuilt.threads[0].model, "claude-sonnet-5");
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

test("provider thinking stays live-only and is excluded from local history", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Inspect the change",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "thinking",
    text: "private reasoning sentinel",
  });

  const projection = await store.load();
  assert.equal(projection.messages.some((message) => message.text.includes("private reasoning sentinel")), false);
  assert.doesNotMatch(await readFile(join(directory, "events.v1.jsonl"), "utf8"), /private reasoning sentinel/);
});

test("browser observations never enter local history or activity projections", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Observe the provider view",
    mode: "ask",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
    kind: "browser_observation",
    provider: "codex-cli",
    observationId: "frame-1",
    imageData: "data:image/png;base64,AAAA",
    mediaType: "image/png",
  });
  const projection = await new LocalStateStore(directory).load();
  assert.equal(projection.activities.length, 0);
  assert.equal(JSON.stringify(projection).includes("data:image"), false);
  assert.equal((await readFile(join(directory, "events.v1.jsonl"), "utf8")).includes("browser_observation"), false);
});

test("project Chisei namespace bindings persist locally and validate their bounded identity", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const bound = await store.bindProjectChiseiNamespace("project-1", "team/project");
  assert.equal(bound.chiseiNamespace, "team/project");
  assert.equal(
    (await new LocalStateStore(directory).load()).projects[0].chiseiNamespace,
    "team/project",
  );
  await assert.rejects(
    () => store.bindProjectChiseiNamespace("project-1", "../other project"),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
  const unbound = await store.bindProjectChiseiNamespace("project-1", null);
  assert.equal(unbound.chiseiNamespace, null);
});

test("project saves and Chisei binding updates serialize without losing either field", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "before", root: "/fixture" });
  await Promise.all([
    store.bindProjectChiseiNamespace("project-1", "team/project"),
    store.saveProject({ id: "project-1", name: "after", root: "/fixture" }),
  ]);
  const project = (await store.load()).projects[0];
  assert.equal(project.name, "after");
  assert.equal(project.chiseiNamespace, "team/project");
});

test("provider plans update one persisted artifact and survive restart without duplication", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Plan the work",
    mode: "plan",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
    kind: "plan_updated",
    artifact: { id: "item:plan-1", provider: "codex-cli", body: "First" },
    bodyMode: "append",
  });
  await store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
    kind: "plan_updated",
    artifact: {
      id: "item:plan-1",
      provider: "codex-cli",
      body: " final",
      steps: [{ content: "Verify", status: "active" }],
    },
    bodyMode: "append",
  });
  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.plans.length, 1);
  assert.equal(rebuilt.plans[0].body, "First final");
  assert.deepEqual(rebuilt.plans[0].steps, [{ content: "Verify", status: "active" }]);
  const next = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Plan the next turn",
    mode: "plan",
    provider: "codex-cli",
    threadId: thread.id,
  });
  await store.recordProviderEvent(thread.id, next.turn.id, "codex-cli", {
    kind: "plan_updated",
    artifact: { id: "item:plan-1", provider: "codex-cli", body: "Second turn" },
  });
  const afterSecondTurn = await new LocalStateStore(directory).load();
  assert.equal(afterSecondTurn.plans.length, 2);
  assert.deepEqual(
    afterSecondTurn.plans.map((plan) => [plan.turnId, plan.body]),
    [[turn.id, "First final"], [next.turn.id, "Second turn"]],
  );
  await assert.rejects(() => store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
    kind: "plan_updated",
    artifact: { id: "spoof", provider: "claude-code", body: "wrong provider" },
  }), /does not match/);
});

test("context receipts retain immutable metadata without repository content", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Use bounded context",
    mode: "ask",
    provider: "codex-cli",
    contextPins: [{ path: "src", kind: "folder" }],
  });
  await store.saveContextReceipt({
    threadId: thread.id,
    turnId: turn.id,
    pins: [{ path: "src", kind: "folder" }],
    entries: [{
      path: "src/main.ts",
      type: "text",
      source: "aldunis_folder",
      bytes: 24,
      truncated: false,
      digest: "a".repeat(64),
      omissionReason: null,
    }],
    totalBytes: 24,
    estimatedTokens: 6,
    digest: "b".repeat(64),
  });
  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.threads[0].contextPins, [{ path: "src", kind: "folder" }]);
  assert.equal(rebuilt.contextReceipts.length, 1);
  assert.equal(rebuilt.contextReceipts[0].entries[0].digest, "a".repeat(64));
  const journal = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal(journal.includes("repository source sentinel"), false);
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

test("automation fires are durable, idempotent, and bind turn and provider identities", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const key = {
    automationId: "automation-1",
    key: "scheduled:2026-01-01T00:01:00.000Z",
    kind: "scheduled" as const,
    scheduledAt: "2026-01-01T00:01:00.000Z",
    requestedAt: "2026-01-01T00:00:00.000Z",
    retryOf: null,
  };
  const skipped = await store.recordAutomationFireSkippedBusy(key);
  const claimed = await store.claimAutomationFire(key);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.fire.id, skipped.id);
  const duplicate = await store.claimAutomationFire(key);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.fire.id, skipped.id);

  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "automation prompt",
    mode: "ask",
    provider: "claude-code",
  });
  await store.bindAutomationFireTurn(claimed.fire.id, started.turn.id);
  await store.bindProviderRun(started.turn.id, "provider-run-1");
  await store.recordProviderEvent(started.thread.id, started.turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "provider-session-1",
    costUsd: null,
  });
  await store.finishAutomationFire(claimed.fire.id, "completed");

  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.automationFires, [{
    ...rebuilt.automationFires[0],
    status: "completed",
    turnId: started.turn.id,
    providerRunId: "provider-run-1",
    error: null,
  }]);
  assert.equal(
    (await store.latestAutomationFire("automation-1"))?.key,
    "scheduled:2026-01-01T00:01:00.000Z",
  );
});

test("automation fires become explicit unknown after an interrupted host", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "may have mutated the worktree",
    mode: "build",
    provider: "claude-code",
  });
  const claim = await store.claimAutomationFire({
    automationId: "automation-1",
    key: "scheduled:2026-01-01T00:01:00.000Z",
    kind: "scheduled",
    scheduledAt: "2026-01-01T00:01:00.000Z",
    requestedAt: "2026-01-01T00:01:00.000Z",
    retryOf: null,
  });
  await store.bindAutomationFireTurn(claim.fire.id, started.turn.id);
  await store.recoverInterruptedTurns();
  await store.reconcileAutomationFires();
  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.turns[0].status, "interrupted");
  assert.equal(rebuilt.automationFires[0].status, "unknown");
  assert.match(rebuilt.automationFires[0].error ?? "", /could not be proven/);
});

test("governed Shikigami correlation receipts survive restart without sensitive run content", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "sensitive prompt sentinel",
    mode: "build",
    provider: "shikigami",
  });
  const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await store.recordProviderEvent(thread.id, turn.id, "shikigami", {
    kind: "governance_correlation",
    governance: "sekai-chisei",
    runId,
    operationId: runId,
  });
  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.governanceCorrelations, [{
    schemaVersion: 2,
    id: rebuilt.governanceCorrelations[0].id,
    provider: "shikigami",
    governance: "sekai-chisei",
    threadId: thread.id,
    turnId: turn.id,
    runId,
    operationId: runId,
    createdAt: rebuilt.governanceCorrelations[0].createdAt,
  }]);
  const journal = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  const correlationLine = journal.split("\n").find((line) => line.includes("governance_correlation_saved"));
  assert.ok(correlationLine);
  assert.doesNotMatch(correlationLine, /sensitive prompt sentinel|\/fixture/);
  await assert.rejects(
    () => store.recordProviderEvent(thread.id, turn.id, "shikigami", {
      kind: "governance_correlation",
      governance: "sekai-chisei",
      runId,
      operationId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    }),
    /incompatible/,
  );
  await store.recordProviderEvent(thread.id, turn.id, "shikigami", {
    kind: "turn_completed",
    sessionId: runId,
    costUsd: null,
  });
  await store.deleteConversation(thread.id);
  assert.equal((await store.load()).governanceCorrelations.length, 0);
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
  const fifth = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Fail authentication",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(fifth.thread.id, fifth.turn.id, "claude-code", {
    kind: "failed",
    code: "provider_authentication",
    message: "untrusted authentication diagnostics",
  });

  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.activities.map((activity) => activity.message), [
    "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
    "Provider failed.",
    "Codex app-server emitted an unsupported notification.",
    "Provider failed.",
    "Claude Code authentication failed. Re-authenticate in Claude Code and try again.",
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

test("one host holds the local history writer lease until release", async () => {
  const { directory, store } = await fixtureStore();
  const release = await store.acquireWriterLease();
  await assert.rejects(
    () => new LocalStateStore(directory).acquireWriterLease(),
    /already using this local state directory/,
  );
  await release();
  const releaseRestarted = await new LocalStateStore(directory).acquireWriterLease();
  await releaseRestarted();
});

test("intact forked history is renumbered in physical append order", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Preserve every intact event",
    mode: "ask",
    provider: "claude-code",
  });
  const eventPath = join(directory, "events.v1.jsonl");
  const lines = (await readFile(eventPath, "utf8")).trim().split("\n");
  const forked = lines.map((line, index) => {
    const envelope = JSON.parse(line);
    if (index >= 2) envelope.sequence -= 1;
    return JSON.stringify(envelope);
  });
  await writeFile(eventPath, `${forked.join("\n")}\n`, "utf8");

  const projection = await new LocalStateStore(directory).load();
  assert.equal(projection.projects.length, 1);
  assert.equal(projection.threads.length, 1);
  assert.equal(projection.turns.length, 1);
  assert.equal(projection.messages[0].text, "Preserve every intact event");

  const repaired = (await readFile(eventPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).sequence);
  assert.deepEqual(repaired, Array.from({ length: repaired.length }, (_, index) => index + 1));
});

test("forward sequence gaps still fail visibly without rewriting history", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Do not hide missing events",
    mode: "ask",
    provider: "claude-code",
  });
  const eventPath = join(directory, "events.v1.jsonl");
  const lines = (await readFile(eventPath, "utf8")).trim().split("\n");
  const missing = lines.filter((_, index) => index !== 1);
  await writeFile(eventPath, `${missing.join("\n")}\n`, "utf8");

  await assert.rejects(
    () => new LocalStateStore(directory).load(),
    /not ordered at event 3; expected 2/,
  );
  assert.equal(await readFile(eventPath, "utf8"), `${missing.join("\n")}\n`);
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

test("workspace mode persists and cannot be changed on an existing conversation", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "Fixture", root: "/repo" });
  const first = await store.startTurn({
    projectId: "project-1",
    worktree: "/repo/managed",
    prompt: "Build in isolation",
    mode: "build",
    provider: "codex-cli",
    workspaceMode: "aldunis-managed",
  });
  assert.equal(first.thread.workspaceMode, "aldunis-managed");
  const continued = await store.startTurn({
    projectId: "project-1",
    worktree: "/repo/managed",
    prompt: "Continue in isolation",
    mode: "build",
    provider: "codex-cli",
    threadId: first.thread.id,
    workspaceMode: "aldunis-managed",
  });
  assert.equal(continued.thread.workspaceMode, "aldunis-managed");
  await assert.rejects(() => store.startTurn({
    projectId: "project-1",
    worktree: "/repo/managed",
    prompt: "Switch to shared",
    mode: "ask",
    provider: "codex-cli",
    threadId: first.thread.id,
    workspaceMode: "shared",
  }), /different workspace mode/);
});

test("concurrent managed conversation starts claim one worktree", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "Fixture", root: "/repo" });
  const results = await Promise.allSettled([
    store.startTurn({
      projectId: "project-1",
      worktree: "/repo/managed",
      prompt: "First concurrent build",
      mode: "build",
      provider: "codex-cli",
      workspaceMode: "aldunis-managed",
    }),
    store.startTurn({
      projectId: "project-1",
      worktree: "/repo/managed",
      prompt: "Second concurrent build",
      mode: "build",
      provider: "codex-cli",
      workspaceMode: "aldunis-managed",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.load()).threads.length, 1);
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
  const deletedTurn = await deleted.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "secret prompt sentinel",
    mode: "build",
    provider: "claude-code",
  });
  const deletedFire = await deleted.store.claimAutomationFire({
    automationId: "automation-project-delete",
    key: "manual:project-delete",
    kind: "manual",
    scheduledAt: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    retryOf: null,
  });
  await deleted.store.bindAutomationFireTurn(deletedFire.fire.id, deletedTurn.turn.id);
  await deleted.store.deleteProject("project-1");
  assert.deepEqual(await deleted.store.load(), {
    schemaVersion: 2,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [],
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    governanceCorrelations: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [],
    inputRequests: [],
    inputReceipts: [],
    automationFires: [],
  });
  assert.equal((await readFile(join(deleted.directory, "events.v1.jsonl"), "utf8")).includes("sentinel"), false);

  const retained = await fixtureStore();
  await retained.store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const retainedTurn = await retained.store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "expired sensitive prompt",
    mode: "build",
    provider: "claude-code",
  });
  const retainedFire = await retained.store.claimAutomationFire({
    automationId: "automation-retention",
    key: "manual:retention",
    kind: "manual",
    scheduledAt: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    retryOf: null,
  });
  await retained.store.bindAutomationFireTurn(retainedFire.fire.id, retainedTurn.turn.id);
  await retained.store.enforceRetention(new Date(Date.now() + 60_000));
  const projection = await retained.store.load();
  assert.equal(projection.projects.length, 1);
  assert.equal(projection.threads.length, 0);
  assert.equal(projection.automationFires.length, 0);
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
  assert.equal(projection.threads[0].workspaceMode, "shared");
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
  const fire = await store.claimAutomationFire({
    automationId: "automation-conversation-delete",
    key: "manual:conversation-delete",
    kind: "manual",
    scheduledAt: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    retryOf: null,
  });
  await store.bindAutomationFireTurn(fire.fire.id, turn.id);

  assert.deepEqual(await store.previewConversationDeletion(thread.id), {
    thread: 1,
    turns: 1,
    messages: 2,
    activities: 0,
    plans: 0,
    contextReceipts: 0,
    governanceCorrelations: 0,
    providerSessions: 1,
    checkpoints: 0,
    annotations: 0,
    fileReviews: 0,
    forks: 0,
    delegatedRelationships: 0,
    inputRequests: 0,
    inputReceipts: 0,
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
  assert.equal(rebuilt.automationFires.length, 0);
  assert.equal(rebuilt.conversationDeletions[0].status, "completed");
  const persisted = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal(persisted.includes("secret sentinel"), false);
  assert.equal(persisted.includes("worktree-that-must-survive"), false);
});

test("delegated conversation relationships persist, enforce one parent, and detach on deletion", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const createConversation = async (prompt: string) => {
    const created = await store.startTurn({
      projectId: "project-1",
      worktree: `/fixture/${prompt}`,
      prompt,
      mode: "ask",
      provider: "codex-cli",
    });
    await store.recordProviderEvent(created.thread.id, created.turn.id, "codex-cli", {
      kind: "turn_completed",
      sessionId: `session-${prompt}`,
      costUsd: 0,
    });
    return created.thread;
  };
  const firstParent = await createConversation("parent-a");
  const secondParent = await createConversation("parent-b");
  const child = await createConversation("child");

  const relationship = await store.linkDelegatedConversation(firstParent.id, child.id);
  assert.equal(relationship.parentThreadId, firstParent.id);
  assert.equal((await new LocalStateStore(directory).load()).delegatedRelationships.length, 1);
  await assert.rejects(
    () => store.linkDelegatedConversation(secondParent.id, child.id),
    /already has a delegated parent/,
  );
  await assert.rejects(
    () => store.linkDelegatedConversation(child.id, child.id),
    /cannot be delegated to itself/,
  );

  assert.equal((await store.previewConversationDeletion(firstParent.id)).delegatedRelationships, 1);
  await store.deleteConversation(firstParent.id);
  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.delegatedRelationships.length, 0);
  assert.equal(rebuilt.threads.some((thread) => thread.id === child.id), true);
});

test("delegated conversation relationships remain an acyclic forest", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const createConversation = async (name: string) => (await store.startTurn({
    projectId: "project-1",
    worktree: `/fixture/${name}`,
    prompt: name,
    mode: "ask",
    provider: "codex-cli",
  })).thread;
  const parent = await createConversation("parent");
  const child = await createConversation("child");
  const grandchild = await createConversation("grandchild");
  const sibling = await createConversation("sibling");

  await store.linkDelegatedConversation(parent.id, child.id);
  await store.linkDelegatedConversation(child.id, grandchild.id);
  await store.linkDelegatedConversation(parent.id, sibling.id);
  await assert.rejects(
    () => store.linkDelegatedConversation(child.id, parent.id),
    /would create a cycle/,
  );
  await assert.rejects(
    () => store.linkDelegatedConversation(grandchild.id, parent.id),
    /would create a cycle/,
  );

  const projection = await store.load();
  assert.deepEqual(
    projection.delegatedRelationships.map((relationship) => [
      relationship.parentThreadId,
      relationship.childThreadId,
    ]),
    [
      [parent.id, child.id],
      [child.id, grandchild.id],
      [parent.id, sibling.id],
    ],
  );
});

test("concurrent inverse delegated links cannot race into a cycle", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const first = (await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/first",
    prompt: "first",
    mode: "ask",
    provider: "codex-cli",
  })).thread;
  const second = (await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/second",
    prompt: "second",
    mode: "ask",
    provider: "codex-cli",
  })).thread;

  const results = await Promise.allSettled([
    store.linkDelegatedConversation(first.id, second.id),
    store.linkDelegatedConversation(second.id, first.id),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await store.load()).delegatedRelationships.length, 1);
});

test("delegated completion outcomes project only the latest bounded child result", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const parent = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/parent",
    prompt: "Coordinate",
    mode: "ask",
    provider: "codex-cli",
  });
  const child = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Deliver",
    mode: "build",
    provider: "codex-cli",
  });
  await store.linkDelegatedConversation(parent.thread.id, child.thread.id);
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "Result ",
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "ready.",
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "##",
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: " Verified",
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "child-session",
    costUsd: 0,
  });

  let outcomes = projectDelegatedConversationOutcomes(await store.load());
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].childThreadId, child.thread.id);
  assert.equal(outcomes[0].summary, "Result ready.\n## Verified");
  assert.ok(outcomes[0].completedAt);

  const latest = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Deliver the follow-up",
    mode: "build",
    provider: "codex-cli",
    threadId: child.thread.id,
  });
  await store.recordProviderEvent(child.thread.id, latest.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "x".repeat(501),
  });
  await store.recordProviderEvent(child.thread.id, latest.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "latest-child-session",
    costUsd: 0,
  });
  outcomes = projectDelegatedConversationOutcomes(await store.load());
  assert.equal(outcomes[0].summary, `…${"x".repeat(500)}`);
  assert.equal(outcomes[0].completedAt, (await store.load()).turns.at(-1)?.completedAt);

  const finalSegment = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Deliver after inspection",
    mode: "build",
    provider: "codex-cli",
    threadId: child.thread.id,
  });
  await store.recordProviderEvent(child.thread.id, finalSegment.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "Progress before the tool.",
  });
  await store.recordProviderEvent(child.thread.id, finalSegment.turn.id, "codex-cli", {
    kind: "tool_started",
    toolCallId: "tool-final",
    name: "Read",
  });
  await store.recordProviderEvent(child.thread.id, finalSegment.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "Final outcome after the tool.",
  });
  await store.recordProviderEvent(child.thread.id, finalSegment.turn.id, "codex-cli", {
    kind: "tool_finished",
    toolCallId: "tool-final",
    failed: false,
  });
  await store.recordProviderEvent(child.thread.id, finalSegment.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "final-child-session",
    costUsd: 0,
  });
  outcomes = projectDelegatedConversationOutcomes(await store.load());
  assert.equal(outcomes[0].summary, "Final outcome after the tool.");

  const whitespaceFallback = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Complete without a post-tool summary",
    mode: "build",
    provider: "codex-cli",
    threadId: child.thread.id,
  });
  await store.recordProviderEvent(child.thread.id, whitespaceFallback.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: `Meaningful pre-tool result.${"\n".repeat(600)}`,
  });
  await store.recordProviderEvent(child.thread.id, whitespaceFallback.turn.id, "codex-cli", {
    kind: "tool_started",
    toolCallId: "tool-whitespace",
    name: "Read",
  });
  await store.recordProviderEvent(child.thread.id, whitespaceFallback.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "\n".repeat(600),
  });
  await store.recordProviderEvent(child.thread.id, whitespaceFallback.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "whitespace-child-session",
    costUsd: 0,
  });
  outcomes = projectDelegatedConversationOutcomes(await store.load());
  assert.equal(outcomes[0].summary, "Meaningful pre-tool result.");

  const splitWhitespace = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Preserve streamed formatting",
    mode: "build",
    provider: "codex-cli",
    threadId: child.thread.id,
  });
  for (const text of ["Result\n", " ", "Details"]) {
    await store.recordProviderEvent(child.thread.id, splitWhitespace.turn.id, "codex-cli", {
      kind: "assistant_text",
      text,
    });
  }
  await store.recordProviderEvent(child.thread.id, splitWhitespace.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "split-whitespace-session",
    costUsd: 0,
  });
  outcomes = projectDelegatedConversationOutcomes(await store.load());
  assert.equal(outcomes[0].summary, "Result\n\nDetails");
});

test("child input requests and parent coordination receipts persist and resolve once", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const parent = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/parent",
    prompt: "Coordinate",
    mode: "ask",
    provider: "codex-cli",
  });
  const child = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Work",
    mode: "build",
    provider: "shikigami",
  });
  await store.linkDelegatedConversation(parent.thread.id, child.thread.id);
  await store.bindProviderRun(child.turn.id, "provider-run-1");
  await store.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
    kind: "input_requested",
    id: "request-1",
    question: "Continue with migration?",
    choices: [{ id: "continue", label: "Continue", description: null }],
    recommendation: "Continue",
    responseMode: "native_resume",
    providerRequestId: "native-request-1",
    expiresAt: null,
    allowFreeForm: false,
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
    kind: "input_requested",
    id: "request-2",
    question: "Choose a migration window.",
    choices: [{ id: "later", label: "Later", description: null }],
    recommendation: "Later",
    responseMode: "native_resume",
    providerRequestId: "native-request-2",
    expiresAt: null,
    allowFreeForm: false,
  });
  assert.equal((await store.load()).inputRequests.length, 2);
  assert.equal(projectThreadStatus(await store.load(), child.thread.id).status, "awaiting_input");

  const resolved = await store.resolveInputRequest(
    "request-1",
    "Continue",
    parent.thread.id,
  );
  assert.equal(resolved.receipt.parentThreadId, parent.thread.id);
  assert.equal(resolved.receipt.answerDigest.length, 64);
  assert.equal(projectThreadStatus(await store.load(), child.thread.id).status, "awaiting_input");
  await assert.rejects(
    () => store.resolveInputRequest("request-1", "Again", parent.thread.id),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.inputRequests[0].state, "answered");
  assert.equal(rebuilt.inputReceipts.length, 1);
});

test("failed child follow-up startup rolls back its receipt and interrupts the source turn", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const child = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Work",
    mode: "plan",
    provider: "shikigami",
  });
  await store.bindProviderRun(child.turn.id, "run-child");
  await store.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
    kind: "input_requested",
    id: "request-failed-follow-up",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    providerRequestId: null,
    expiresAt: null,
    allowFreeForm: true,
  });
  await store.resolveInputRequest("request-failed-follow-up", "Continue", null);
  await store.failInputResolution("request-failed-follow-up");
  const projection = await store.load();
  assert.equal(projection.inputRequests[0].state, "cancelled");
  assert.equal(projection.inputReceipts.length, 0);
  assert.equal(projection.turns[0].status, "interrupted");
});

test("recovery cancels dead native input RPCs but preserves child follow-up requests", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  for (const [index, responseMode] of ["native_resume", "child_follow_up"].entries()) {
    const started = await store.startTurn({
      projectId: "project-1",
      worktree: `/fixture/${index}`,
      prompt: "Work",
      mode: "plan",
      provider: responseMode === "native_resume" ? "codex-cli" : "shikigami",
    });
    await store.bindProviderRun(started.turn.id, `run-${index}`);
    await store.recordProviderEvent(started.thread.id, started.turn.id, started.thread.provider, {
      kind: "input_requested",
      id: `request-${index}`,
      question: "Continue?",
      choices: [],
      recommendation: null,
      responseMode: responseMode as "native_resume" | "child_follow_up",
      providerRequestId: null,
      expiresAt: null,
      allowFreeForm: true,
    });
    if (responseMode === "native_resume") {
      await store.recordProviderEvent(started.thread.id, started.turn.id, "codex-cli", {
        kind: "input_requested",
        id: "request-native-sibling",
        question: "And choose a window?",
        choices: [],
        recommendation: null,
        responseMode: "native_resume",
        providerRequestId: null,
        expiresAt: null,
        allowFreeForm: true,
      });
    }
  }
  await store.recoverInterruptedTurns();
  const projection = await store.load();
  const nativeRequests = projection.inputRequests.filter((request) => request.responseMode === "native_resume");
  const followUpRequest = projection.inputRequests.find((request) => request.responseMode === "child_follow_up");
  assert.equal(nativeRequests.length, 2);
  assert.ok(nativeRequests.every((request) => request.state === "cancelled"));
  assert.equal(projection.turns.find((turn) => turn.id === nativeRequests[0].turnId)?.status, "interrupted");
  assert.equal(followUpRequest?.state, "pending");
  assert.equal(projection.turns.find((turn) => turn.id === followUpRequest?.turnId)?.status, "waiting_for_user");
});

test("recovery reopens a claimed child answer when no follow-up turn was persisted", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Work",
    mode: "plan",
    provider: "shikigami",
  });
  await store.bindProviderRun(started.turn.id, "run-orphan");
  await store.recordProviderEvent(started.thread.id, started.turn.id, "shikigami", {
    kind: "input_requested",
    id: "request-orphan",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    providerRequestId: null,
    expiresAt: null,
    allowFreeForm: true,
  });
  await store.resolveInputRequest("request-orphan", "Continue", null);
  await store.recoverInterruptedTurns();
  const projection = await store.load();
  assert.equal(projection.inputRequests[0].state, "pending");
  assert.equal(projection.inputReceipts.length, 0);
  assert.equal(projection.turns[0].status, "waiting_for_user");
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
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "plan_updated",
    artifact: {
      id: "source-plan",
      provider: "claude-code",
      body: "private source plan sentinel",
    },
  });

  const preview = await store.previewFork(thread.id);
  assert.deepEqual(preview.messages.map((message) => message.text), [
    "Inspect the boundary",
    "The boundary is explicit.",
  ]);
  assert.equal(preview.prompt.includes("native-secret-session"), false);
  assert.equal(preview.prompt.includes("raw-tool-call"), false);
  assert.equal(preview.prompt.includes("private source plan sentinel"), false);
  assert.equal(preview.excluded.includes("Provider plan artifacts"), true);
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
  assert.equal(
    (await store.load()).plans.some((plan) => plan.threadId === created.thread.id),
    false,
  );
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

test("managed conversation forks require a distinct managed worktree", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread } = await store.startTurn({
    projectId: "project-1",
    worktree: "/managed/source",
    prompt: "Prepare an isolated fork",
    mode: "build",
    provider: "claude-code",
    workspaceMode: "aldunis-managed",
  });
  const preview = await store.previewFork(thread.id);
  assert.equal(preview.workspaceMode, "aldunis-managed");

  const concurrentForks = await Promise.allSettled([
    store.createFork({
      sourceThreadId: thread.id,
      provider: "codex-cli",
      profileId: null,
      model: "default",
      worktree: "/managed/source",
      destinationWorktree: "/managed/concurrent",
      workspaceMode: "aldunis-managed",
      expectedDigest: preview.digest,
    }),
    store.createFork({
      sourceThreadId: thread.id,
      provider: "codex-cli",
      profileId: null,
      model: "default",
      worktree: "/managed/source",
      destinationWorktree: "/managed/concurrent",
      workspaceMode: "aldunis-managed",
      expectedDigest: preview.digest,
    }),
  ]);
  assert.equal(concurrentForks.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentForks.filter((result) => result.status === "rejected").length, 1);

  await assert.rejects(
    () => store.createFork({
      sourceThreadId: thread.id,
      provider: "codex-cli",
      profileId: null,
      model: "default",
      worktree: "/managed/source",
      expectedDigest: preview.digest,
    }),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );

  const created = await store.createFork({
    sourceThreadId: thread.id,
    provider: "codex-cli",
    profileId: null,
    model: "default",
    worktree: "/managed/source",
    destinationWorktree: "/managed/destination",
    workspaceMode: "aldunis-managed",
    expectedDigest: preview.digest,
  });
  assert.equal(created.thread.workspaceMode, "aldunis-managed");
  assert.equal(created.thread.worktree, "/managed/destination");
  assert.equal(created.fork.worktree, "/managed/destination");
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
