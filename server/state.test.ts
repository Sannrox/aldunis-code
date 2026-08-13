import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  coalesceConsecutiveAssistantMessages,
  LocalStateError,
  LocalStateStore,
  MAX_EVENT_ENVELOPE_BYTES,
  MAX_EVENT_HISTORY_WRITE_BUFFER_BYTES,
  MAX_THREADS_PER_PROJECT,
  projectDelegatedConversationOutcomes,
  projectThreadStatus,
  projectThreadStatuses,
  type StateProjection,
  writeEventHistory,
} from "./state.ts";
import { projectConversationHistory } from "./state-projection.ts";

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
    kind: "context_usage",
    usedTokens: 900,
    maxTokens: 200_000,
    totalProcessedTokens: 1_200,
    inputTokens: 1_000,
    outputTokens: 200,
    cachedInputTokens: 100,
    cacheWriteInputTokens: 20,
    reasoningOutputTokens: 30,
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
  assert.deepEqual(
    rebuilt.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(rebuilt.activities[0].name, "Read");
  assert.deepEqual(rebuilt.usageReceipts, [
    {
      schemaVersion: 2,
      id: `usage:${turn.id}`,
      threadId: thread.id,
      turnId: turn.id,
      provider: "claude-code",
      model: "sonnet",
      status: "completed",
      inputTokens: 1_000,
      outputTokens: 200,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
      reasoningOutputTokens: 30,
      totalProcessedTokens: null,
      reportedCostUsd: 0.01,
      createdAt: rebuilt.usageReceipts[0].createdAt,
      updatedAt: rebuilt.usageReceipts[0].updatedAt,
    },
  ]);
  assert.notEqual(rebuilt.usageReceipts[0].createdAt, rebuilt.usageReceipts[0].updatedAt);
  assert.ok(
    rebuilt.messages[1]!.eventSequence! < rebuilt.activities[0]!.eventSequence!,
    "provider records retain their shared event-log order across collections",
  );
  assert.equal(rebuilt.providerSessions[0].sessionId, "session-1");
});

test("provider events read thread-local indexes without cloning the full projection", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const codex = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/codex",
    prompt: "Exercise indexed provider context",
    mode: "build",
    provider: "codex-cli",
  });
  const shikigami = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/shikigami",
    prompt: "Exercise indexed governance context",
    mode: "build",
    provider: "shikigami",
  });
  await store.bindProviderRun(codex.turn.id, "codex-run");

  class NoProjectionCloneStore extends LocalStateStore {
    override async load(): Promise<StateProjection> {
      throw new Error("provider event cloned the full projection");
    }
  }
  const indexed = new NoProjectionCloneStore(directory);
  await indexed.saveContextReceipt({
    threadId: codex.thread.id,
    turnId: codex.turn.id,
    pins: [],
    entries: [],
    totalBytes: 0,
    estimatedTokens: 0,
    digest: "c".repeat(64),
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "session_started",
    sessionId: "codex-session",
    model: "gpt-test",
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "input_requested",
    id: "indexed-input",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    providerRequestId: null,
    expiresAt: null,
    allowFreeForm: true,
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "input_resolved",
    id: "indexed-input",
    state: "cancelled",
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "approval_pending",
    id: "indexed-approval",
    runId: "codex-run",
    conversationId: codex.thread.id,
    repository: "/fixture",
    worktree: "/fixture/codex",
    toolCallId: "tool-1",
    toolName: "Write",
    scope: { summary: "Write a file", target: "fixture.ts", details: [] },
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "approval_resolved",
    id: "indexed-approval",
    state: "allowed_once",
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "plan_updated",
    artifact: { id: "indexed-plan", provider: "codex-cli", body: "Verify" },
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "context_usage",
    usedTokens: 10,
    maxTokens: 100,
    totalProcessedTokens: 10,
    inputTokens: 8,
    outputTokens: 2,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
  });
  const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await indexed.recordProviderEvent(shikigami.thread.id, shikigami.turn.id, "shikigami", {
    kind: "governance_correlation",
    governance: "sekai-chisei",
    runId,
    operationId: runId,
  });
  await indexed.recordProviderEvent(codex.thread.id, codex.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "codex-session",
    costUsd: 0.01,
  });

  const projection = await new LocalStateStore(directory).load();
  assert.equal(projection.turns.find((turn) => turn.id === codex.turn.id)?.status, "completed");
  assert.equal(projection.providerSessions[0]?.model, "gpt-test");
  assert.equal(projection.inputRequests[0]?.state, "cancelled");
  assert.equal(projection.contextReceipts[0]?.digest, "c".repeat(64));
  assert.equal(projection.plans[0]?.body, "Verify");
  assert.equal(projection.usageReceipts[0]?.status, "completed");
  assert.equal(projection.governanceCorrelations[0]?.runId, runId);
});

test("terminal events without usage do not create empty receipts", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Complete without provider usage",
    mode: "ask",
    provider: "claude-code",
  });

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "context_usage",
    usedTokens: 100,
    maxTokens: 200_000,
    totalProcessedTokens: 100,
    inputTokens: null,
    outputTokens: null,
  });

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: null,
  });

  const projection = await store.load();
  assert.equal(projection.turns[0].status, "completed");
  assert.deepEqual(projection.usageReceipts, []);
});

test("usage receipts reject out-of-bound provider metrics", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Reject oversized provider usage",
    mode: "ask",
    provider: "claude-code",
  });

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "context_usage",
    usedTokens: Number.MAX_VALUE,
    maxTokens: null,
    totalProcessedTokens: Number.MAX_VALUE,
    inputTokens: Number.MAX_VALUE,
    outputTokens: Number.MAX_VALUE,
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: Number.MAX_VALUE,
  });

  assert.deepEqual((await store.load()).usageReceipts, []);
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
  assert.equal(
    projection.messages.some((message) => message.text.includes("private reasoning sentinel")),
    false,
  );
  assert.doesNotMatch(
    await readFile(join(directory, "events.v1.jsonl"), "utf8"),
    /private reasoning sentinel/,
  );
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
  assert.equal(
    (await readFile(join(directory, "events.v1.jsonl"), "utf8")).includes("browser_observation"),
    false,
  );
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
    [
      [turn.id, "First final"],
      [next.turn.id, "Second turn"],
    ],
  );
  await assert.rejects(
    () =>
      store.recordProviderEvent(thread.id, turn.id, "codex-cli", {
        kind: "plan_updated",
        artifact: { id: "spoof", provider: "claude-code", body: "wrong provider" },
      }),
    /does not match/,
  );
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
    entries: [
      {
        path: "src/main.ts",
        type: "text",
        source: "aldunis_folder",
        bytes: 24,
        truncated: false,
        digest: "a".repeat(64),
        omissionReason: null,
      },
    ],
    totalBytes: 24,
    estimatedTokens: 6,
    digest: "b".repeat(64),
  });
  const rebuilt = await new LocalStateStore(directory).load();
  assert.deepEqual(rebuilt.threads[0].contextPins, [{ path: "src", kind: "folder" }]);
  assert.equal(rebuilt.contextReceipts.length, 1);
  assert.equal(rebuilt.contextReceipts[0].entries[0].digest, "a".repeat(64));
  await assert.rejects(
    () =>
      store.saveContextReceipt({
        threadId: "other-thread",
        turnId: turn.id,
        pins: [],
        entries: [],
        totalBytes: 0,
        estimatedTokens: 0,
        digest: "c".repeat(64),
      }),
    (error: unknown) => error instanceof LocalStateError && error.status === 404,
  );
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
  assert.deepEqual(rebuilt.automationFires, [
    {
      ...rebuilt.automationFires[0],
      status: "completed",
      turnId: started.turn.id,
      providerRunId: "provider-run-1",
      error: null,
    },
  ]);
  assert.equal(
    (await store.latestAutomationFire("automation-1"))?.key,
    "scheduled:2026-01-01T00:01:00.000Z",
  );

  const originalInspect = store.inspect.bind(store);
  let projectionInspections = 0;
  store.load = async () => {
    throw new Error("batch latest-fire projection must not clone full state");
  };
  store.inspect = async () => {
    projectionInspections += 1;
    const projection = structuredClone(await originalInspect());
    const template = projection.automationFires[0];
    projection.automationFires = [
      {
        ...template,
        id: "automation-1-old",
        automationId: "automation-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        ...template,
        id: "automation-1-latest-first",
        automationId: "automation-1",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        ...template,
        id: "automation-1-latest-tied",
        automationId: "automation-1",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        ...template,
        id: "automation-2-only",
        automationId: "automation-2",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    return projection;
  };
  const latest = await store.latestAutomationFires([
    "automation-1",
    "automation-2",
    "automation-3",
    "automation-1",
  ]);
  assert.equal(projectionInspections, 1);
  assert.equal(latest.get("automation-1")?.id, "automation-1-latest-first");
  assert.equal(latest.get("automation-2")?.id, "automation-2-only");
  assert.equal(latest.has("automation-3"), false);
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
  assert.deepEqual(rebuilt.governanceCorrelations, [
    {
      schemaVersion: 2,
      id: rebuilt.governanceCorrelations[0].id,
      provider: "shikigami",
      governance: "sekai-chisei",
      threadId: thread.id,
      turnId: turn.id,
      runId,
      operationId: runId,
      createdAt: rebuilt.governanceCorrelations[0].createdAt,
    },
  ]);
  const journal = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  const correlationLine = journal
    .split("\n")
    .find((line) => line.includes("governance_correlation_saved"));
  assert.ok(correlationLine);
  assert.doesNotMatch(correlationLine, /sensitive prompt sentinel|\/fixture/);
  await assert.rejects(
    () =>
      store.recordProviderEvent(thread.id, turn.id, "shikigami", {
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
  assert.deepEqual(
    rebuilt.activities.map((activity) => activity.message),
    [
      "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
      "Provider failed.",
      "Codex app-server emitted an unsupported notification.",
      "Provider failed.",
      "Claude Code authentication failed. Re-authenticate in Claude Code and try again.",
    ],
  );
});

test("failed provider cost remains a bounded usage observation", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Fail after partial provider work",
    mode: "ask",
    provider: "claude-code",
  });

  await store.recordProviderEvent(started.thread.id, started.turn.id, "claude-code", {
    kind: "failed",
    costUsd: 0.04,
    message: "untrusted provider text",
  });

  const receipt = (await store.load()).usageReceipts[0];
  assert.equal(receipt?.status, "failed");
  assert.equal(receipt?.reportedCostUsd, 0.04);
});

test("provider mode rejections retain a safe actionable diagnostic", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const first = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Attempt a plan-only run",
    mode: "plan",
    provider: "shikigami",
  });
  const expected = "Shikigami requested mutating tool write_file while plan mode was active.";
  await store.recordProviderEvent(first.thread.id, first.turn.id, "shikigami", {
    kind: "failed",
    code: "provider_mode_violation",
    message: expected,
    toolName: "write_file",
    mode: "plan",
  });
  const second = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Attempt a forged diagnostic",
    mode: "plan",
    provider: "shikigami",
    threadId: first.thread.id,
  });
  await store.recordProviderEvent(second.thread.id, second.turn.id, "shikigami", {
    kind: "failed",
    code: "provider_mode_violation",
    message: "Shikigami requested mutating tool token=secret while plan mode was active.",
    toolName: "token=secret",
    mode: "plan",
  });

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.activities.at(-2)?.message, expected);
  assert.equal(rebuilt.activities.at(-1)?.message, "Provider failed.");
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
  assert.deepEqual(
    projection.turns.map((turn) => turn.status),
    ["interrupted", "interrupted"],
  );
  assert.ok(projection.turns.every((turn) => turn.completedAt));
});

test("concurrent writes remain strictly ordered and crash-safe", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.startTurn({
        projectId: "project-1",
        worktree: "/fixture",
        prompt: `Turn ${index}`,
        mode: "ask",
        provider: "claude-code",
      }),
    ),
  );

  const projection = await new LocalStateStore(directory).load();
  const contents = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  const sequences = contents
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  );
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
  assert.deepEqual(
    repaired,
    Array.from({ length: repaired.length }, (_, index) => index + 1),
  );
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

test("extreme sequence gaps fail without scanning the numeric range", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const eventPath = join(directory, "events.v1.jsonl");
  const envelope = JSON.parse((await readFile(eventPath, "utf8")).trim());
  envelope.sequence = Number.MAX_SAFE_INTEGER;
  await writeFile(eventPath, `${JSON.stringify(envelope)}\n`, "utf8");

  await assert.rejects(
    () => new LocalStateStore(directory).load(),
    /not ordered at event 9007199254740991; expected 1/,
  );
});

test("concurrent first loads share one initialization and keep append order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  const seed = new LocalStateStore(directory);
  await seed.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });

  let releaseRead!: () => void;
  const holdRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let markWaiting!: () => void;
  const sawWaiting = new Promise<void>((resolve) => {
    markWaiting = resolve;
  });
  let waiting = 0;
  const store = new LocalStateStore(directory, {
    holdHistoryRead: async () => {
      waiting += 1;
      markWaiting();
      await holdRead;
    },
  });

  const firstLoad = store.load();
  const secondLoad = store.inspect();
  await sawWaiting;
  assert.equal(waiting, 1);
  releaseRead();
  await firstLoad;
  await store.saveProject({ id: "project-2", name: "second", root: "/second" });
  await secondLoad;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const projection = await store.inspect();
  assert.equal(projection.projects.length, 2);
  const sequences = (await readFile(join(directory, "events.v1.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  );
});

test("oversized history events fail closed before parsing envelope JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  const padding = "x".repeat(MAX_EVENT_ENVELOPE_BYTES + 1);
  await writeFile(
    join(directory, "events.v1.jsonl"),
    `{"schemaVersion":2,"sequence":1,"id":"event-1","recordedAt":"2026-08-12T00:00:00.000Z","event":{"type":"project_saved","project":{"schemaVersion":2,"id":"project-1","name":"${padding}","root":"/fixture","createdAt":"2026-08-12T00:00:00.000Z","updatedAt":"2026-08-12T00:00:00.000Z"}}}\n`,
    "utf8",
  );

  await assert.rejects(
    () => new LocalStateStore(directory).load(),
    (error: unknown) =>
      error instanceof LocalStateError &&
      /exceeds the supported size at line 1/.test(error.message),
  );
});

test("history replay assembles a large envelope across stream chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-state-"));
  const name = "x".repeat(256 * 1024);
  await writeFile(
    join(directory, "events.v1.jsonl"),
    `${JSON.stringify({
      schemaVersion: 2,
      sequence: 1,
      id: "event-1",
      recordedAt: "2026-08-13T00:00:00.000Z",
      event: {
        type: "project_saved",
        project: {
          schemaVersion: 2,
          id: "project-1",
          name,
          root: "/fixture",
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      },
    })}\r\n`,
    "utf8",
  );

  const projection = await new LocalStateStore(directory).load();
  assert.equal(projection.projects[0]?.name, name);
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
    () =>
      store.startTurn({
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
  await assert.rejects(
    () =>
      store.startTurn({
        projectId: "project-1",
        worktree: "/repo/worktree-b",
        prompt: "Move silently",
        mode: "ask",
        provider: "claude-code",
        threadId: first.thread.id,
      }),
    /bound to a different canonical worktree/,
  );
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
  await assert.rejects(
    () =>
      store.startTurn({
        projectId: "project-1",
        worktree: "/repo/managed",
        prompt: "Switch to shared",
        mode: "ask",
        provider: "codex-cli",
        threadId: first.thread.id,
        workspaceMode: "shared",
      }),
    /different workspace mode/,
  );
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
  await writeFile(join(corrupt.directory, "events.v1.jsonl"), '{"schemaVersion":1', "utf8");
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
    (error: unknown) =>
      error instanceof LocalStateError && /incompatible schema/.test(error.message),
  );
});

test("streamed history reports physical corruption lines across blank records", async () => {
  const { directory } = await fixtureStore();
  await writeFile(join(directory, "events.v1.jsonl"), '\n\n{"schemaVersion":1', "utf8");

  await assert.rejects(
    () => new LocalStateStore(directory).load(),
    (error: unknown) => error instanceof LocalStateError && /corrupt at line 3/.test(error.message),
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
    usageReceipts: [],
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
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  });
  assert.equal(
    (await readFile(join(deleted.directory, "events.v1.jsonl"), "utf8")).includes("sentinel"),
    false,
  );

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
  assert.equal(
    (await readFile(join(retained.directory, "events.v1.jsonl"), "utf8")).includes("sensitive"),
    false,
  );
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
  await assert.rejects(
    () => store.previewConversationDeletion(thread.id),
    /provider work is active/,
  );
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
    usageReceipts: 1,
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
  assert.deepEqual(
    (await store.inspectWorkbenchProjection()).conversationHistory.conversationDeletionByThread.get(
      thread.id,
    ),
    deletion,
  );

  const rebuiltStore = new LocalStateStore(directory);
  const rebuilt = await rebuiltStore.load();
  assert.equal(rebuilt.projects.length, 1);
  assert.equal(rebuilt.projects[0].root, "/fixture");
  assert.equal(rebuilt.threads.length, 0);
  assert.equal(rebuilt.turns.length, 0);
  assert.equal(rebuilt.messages.length, 0);
  assert.equal(rebuilt.providerSessions.length, 0);
  assert.equal(rebuilt.automationFires.length, 0);
  assert.equal(rebuilt.conversationDeletions[0].status, "completed");
  assert.deepEqual(
    (
      await rebuiltStore.inspectWorkbenchProjection()
    ).conversationHistory.conversationDeletionByThread.get(thread.id),
    deletion,
  );
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
  assert.deepEqual(
    (await store.inspectWorkbenchProjection()).conversationHistory.delegatedRelationshipByChild.get(
      child.id,
    ),
    relationship,
  );
  const replayedStore = new LocalStateStore(directory);
  assert.equal((await replayedStore.load()).delegatedRelationships.length, 1);
  assert.deepEqual(
    (
      await replayedStore.inspectWorkbenchProjection()
    ).conversationHistory.delegatedRelationshipByChild.get(child.id),
    relationship,
  );
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
  const rebuiltStore = new LocalStateStore(directory);
  const rebuilt = await rebuiltStore.load();
  assert.equal(rebuilt.delegatedRelationships.length, 0);
  assert.equal(
    (
      await rebuiltStore.inspectWorkbenchProjection()
    ).conversationHistory.delegatedRelationshipByChild.has(child.id),
    false,
  );
  assert.equal(
    rebuilt.threads.some((thread) => thread.id === child.id),
    true,
  );
});

test("delegated conversation relationships remain an acyclic forest", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const createConversation = async (name: string) =>
    (
      await store.startTurn({
        projectId: "project-1",
        worktree: `/fixture/${name}`,
        prompt: name,
        mode: "ask",
        provider: "codex-cli",
      })
    ).thread;
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
  const first = (
    await store.startTurn({
      projectId: "project-1",
      worktree: "/fixture/first",
      prompt: "first",
      mode: "ask",
      provider: "codex-cli",
    })
  ).thread;
  const second = (
    await store.startTurn({
      projectId: "project-1",
      worktree: "/fixture/second",
      prompt: "second",
      mode: "ask",
      provider: "codex-cli",
    })
  ).thread;

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
  // Stream tokens buffer into one durable segment with literal concatenation
  // (plus markdown block-boundary breaks), matching the stored transcript.
  assert.equal(outcomes[0].summary, "Result\n Details");
  assert.deepEqual(
    projectDelegatedConversationOutcomes(await store.load(), await store.turnsByThreadIndex()),
    outcomes,
  );
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

  const resolved = await store.resolveInputRequest("request-1", "Continue", parent.thread.id);
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

test("native Shikigami resume claims the exact parked turn once and never stores the answer", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Park this run",
    mode: "build",
    provider: "shikigami",
    model: "scripted",
  });
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await store.bindProviderRun(started.turn.id, runId);
  await store.recordProviderEvent(started.thread.id, started.turn.id, "shikigami", {
    kind: "input_requested",
    id: "native-resume-request",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "native_resume",
    providerRequestId: runId,
    expiresAt: null,
    allowFreeForm: true,
  });
  await store.saveCheckpoint({
    id: "checkpoint-native-resume",
    turnId: started.turn.id,
    threadId: started.thread.id,
    worktree: "/fixture",
    gitDirectory: null,
    baselineHead: "before",
    baselineIdentity: "before",
    baselineIndexIdentity: null,
    completedIdentity: null,
    completedIndexIdentity: null,
    completedHead: null,
    state: "baseline",
    message: null,
    createdAt: new Date().toISOString(),
  });
  await store.resolveInputRequest("native-resume-request", "secret answer", null);
  const claimed = await store.claimNativeShikigamiResume(
    "native-resume-request",
    started.thread.id,
    runId,
  );
  assert.equal(claimed.request.resumeState, "claimed");
  assert.equal(claimed.checkpoint.id, "checkpoint-native-resume");
  await assert.rejects(
    () => store.claimNativeShikigamiResume("native-resume-request", started.thread.id, runId),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
  await store.markNativeShikigamiResumeStarted("native-resume-request");
  await store.markNativeShikigamiResumeUnavailable("native-resume-request");
  const projection = await store.load();
  assert.equal(projection.inputRequests[0].resumeState, "unavailable");
  assert.equal(projection.inputRequests[0].resumeError, "Native Shikigami resume is unavailable.");
  assert.equal(projection.turns[0].status, "active");
  assert.doesNotMatch(await readFile(join(directory, "events.v1.jsonl"), "utf8"), /secret answer/);
});

test("restart marks Shikigami parked requests unavailable without cancelling the visible request", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Park this run",
    mode: "build",
    provider: "shikigami",
  });
  await store.bindProviderRun(started.turn.id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await store.recordProviderEvent(started.thread.id, started.turn.id, "shikigami", {
    kind: "input_requested",
    id: "native-restart-request",
    question: "Continue after restart?",
    choices: [],
    recommendation: null,
    responseMode: "native_resume",
    providerRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    expiresAt: null,
    allowFreeForm: true,
  });
  await store.recoverInterruptedTurns();
  const projection = await store.load();
  assert.equal(projection.inputRequests[0].state, "pending");
  assert.equal(projection.inputRequests[0].resumeState, "unavailable");
  assert.equal(
    projection.inputRequests[0].resumeError,
    "Native Shikigami resume is unavailable after the host restarted.",
  );
  assert.equal(projection.turns[0].status, "interrupted");
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
  const nativeRequests = projection.inputRequests.filter(
    (request) => request.responseMode === "native_resume",
  );
  const followUpRequest = projection.inputRequests.find(
    (request) => request.responseMode === "child_follow_up",
  );
  assert.equal(nativeRequests.length, 2);
  assert.ok(nativeRequests.every((request) => request.state === "cancelled"));
  assert.equal(
    projection.turns.find((turn) => turn.id === nativeRequests[0].turnId)?.status,
    "interrupted",
  );
  assert.equal(followUpRequest?.state, "pending");
  assert.equal(
    projection.turns.find((turn) => turn.id === followUpRequest?.turnId)?.status,
    "waiting_for_user",
  );
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

test("recovery retains a claimed child answer with its exact persisted follow-up", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const started = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Work",
    mode: "plan",
    provider: "shikigami",
  });
  await store.bindProviderRun(started.turn.id, "run-persisted");
  await store.recordProviderEvent(started.thread.id, started.turn.id, "shikigami", {
    kind: "input_requested",
    id: "request-persisted",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    providerRequestId: null,
    expiresAt: null,
    allowFreeForm: true,
  });
  await store.resolveInputRequest("request-persisted", "Continue", null);
  await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Operator response to child input request request-persisted:\nContinue?\n\nContinue",
    mode: "plan",
    provider: "shikigami",
    threadId: started.thread.id,
  });

  await store.recoverInterruptedTurns();
  const projection = await store.load();
  assert.equal(projection.inputRequests[0].state, "answered");
  assert.equal(projection.inputReceipts.length, 1);
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
    files: [
      {
        path: "created.txt",
        state: "added",
        previousPath: null,
        additions: 2,
        deletions: 0,
      },
    ],
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
  assert.deepEqual(rebuilt.checkpoints[0].files, [
    {
      path: "created.txt",
      state: "added",
      previousPath: null,
      additions: 2,
      deletions: 0,
    },
  ]);
  assert.equal(rebuilt.checkpoints[1].state, "completed");

  await store.deleteProject("project-1");
  assert.equal((await store.load()).checkpoints.length, 0);
  assert.equal(
    (await readFile(join(directory, "events.v1.jsonl"), "utf8")).includes("baseline-tree"),
    false,
  );
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
    () =>
      store.startTurn({
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
  assert.deepEqual(
    preview.messages.map((message) => message.text),
    ["Inspect the boundary", "The boundary is explicit."],
  );
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
  class ForkIndexOnlyStore extends LocalStateStore {
    override async load(): Promise<never> {
      throw new Error("fork startup must not clone the full projection");
    }
  }
  const forkIndexStore = new ForkIndexOnlyStore(directory);
  assert.equal(await forkIndexStore.pendingForkPrompt(created.thread.id), preview.prompt);
  assert.deepEqual((await store.load()).threads[0], sourceBefore);

  await forkIndexStore.markForkStarted(created.thread.id);
  assert.equal(await forkIndexStore.pendingForkPrompt(created.thread.id), null);
  const rebuiltStore = new LocalStateStore(directory);
  const rebuilt = await rebuiltStore.load();
  assert.equal(rebuilt.forks[0].status, "started");
  await rebuiltStore.deleteConversation(created.thread.id);
  const afterDeletion = await rebuiltStore.load();
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
    () =>
      store.createFork({
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

test("snooze is visibility-only, clears settle, and rejects unresolved operator blocks", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/worktree-must-remain",
    prompt: "Keep running under snooze",
    mode: "build",
    provider: "claude-code",
  });

  // Running work may be snoozed — visibility only.
  const wake = new Date(Date.now() + 3_600_000).toISOString();
  const snoozedWhileRunning = await store.snoozeConversation(thread.id, wake);
  assert.equal(snoozedWhileRunning.snoozedUntil, wake);
  assert.ok(snoozedWhileRunning.snoozedAt);
  assert.equal(snoozedWhileRunning.settledAt ?? null, null);
  assert.equal(snoozedWhileRunning.worktree, "/fixture/worktree-must-remain");

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_pending",
    id: "approval-snooze",
    runId: "run-snooze",
    conversationId: thread.id,
    repository: "/fixture",
    worktree: "/fixture/worktree-must-remain",
    toolCallId: "tool-1",
    toolName: "Bash",
    scope: { summary: "run", target: "shell", details: [] },
    state: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(
    () => store.snoozeConversation(thread.id, new Date(Date.now() + 7_200_000).toISOString()),
    /tool approval is unresolved/,
  );

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "approval_resolved",
    id: "approval-snooze",
    state: "denied",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "session-snooze",
    costUsd: 0,
  });

  const settled = await store.settleConversation(thread.id);
  assert.ok(settled.settledAt);
  assert.equal(settled.snoozedUntil ?? null, null);

  const later = new Date(Date.now() + 86_400_000).toISOString();
  const resnoozed = await store.snoozeConversation(thread.id, later);
  assert.equal(resnoozed.snoozedUntil, later);
  assert.equal(resnoozed.settledAt ?? null, null);

  const again = await store.snoozeConversation(thread.id, later);
  assert.equal(again.snoozedUntil, later);
  assert.equal(again.snoozedAt, resnoozed.snoozedAt);

  const unsnoozed = await store.unsnoozeConversation(thread.id);
  assert.equal(unsnoozed.snoozedUntil ?? null, null);
  assert.equal(unsnoozed.snoozedAt ?? null, null);
  assert.equal((await store.unsnoozeConversation(thread.id)).snoozedUntil ?? null, null);

  await assert.rejects(
    () => store.snoozeConversation(thread.id, new Date(Date.now() - 1_000).toISOString()),
    /future/,
  );

  const rebuilt = await new LocalStateStore(directory).load();
  assert.equal(rebuilt.threads[0].snoozedUntil ?? null, null);
  assert.equal(rebuilt.threads[0].worktree, "/fixture/worktree-must-remain");
});

test("thread status projection and wokeAt track operator-attention transitions", async () => {
  const { directory, store } = await fixtureStore();
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
  assert.equal(await store.inspectThreadBusy(thread.id), true);
  assert.deepEqual(
    await store.inspectThreadStatus(thread.id),
    projectThreadStatus(projection, thread.id),
  );
  assert.deepEqual(projectThreadStatuses(projection), [projectThreadStatus(projection, thread.id)]);

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
  assert.deepEqual(await store.inspectThreadStatus(thread.id), approvalStatus);
  assert.deepEqual(projectThreadStatuses(projection), [approvalStatus]);
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
  assert.equal(await store.inspectThreadBusy(thread.id), false);
  assert.deepEqual(
    await store.inspectThreadStatus(thread.id),
    projectThreadStatus(projection, thread.id),
  );
  assert.deepEqual(projectThreadStatuses(projection), [projectThreadStatus(projection, thread.id)]);
  assert.ok(projection.threads[0].wokeAt);

  await store.markConversationVisited(thread.id);
  projection = await store.load();
  assert.ok(projection.threads[0].lastVisitedAt);
  assert.ok(projection.threads[0].lastVisitedAt! >= projection.threads[0].wokeAt!);
  assert.deepEqual(
    projectThreadStatuses(projection, await store.turnsByThreadIndex()),
    projectThreadStatuses(projection),
  );
  assert.deepEqual(
    await new LocalStateStore(directory).inspectThreadStatus(thread.id),
    projectThreadStatus(projection, thread.id),
  );
  assert.equal(await new LocalStateStore(directory).inspectThreadBusy(thread.id), false);
});

function statusFixtureThread(id: string): StateProjection["threads"][number] {
  return {
    schemaVersion: 2,
    id,
    projectId: "project-1",
    worktree: `/${id}`,
    workspaceMode: "shared",
    title: id,
    provider: "codex-cli",
    createdAt: "t0",
    updatedAt: "t1",
  };
}

function statusFixtureTurn(
  id: string,
  threadId: string,
  status: StateProjection["turns"][number]["status"],
  createdAt: string,
  completedAt: string | null = null,
): StateProjection["turns"][number] {
  return {
    schemaVersion: 2,
    id,
    threadId,
    status,
    mode: "build",
    createdAt,
    completedAt,
  };
}

function forbiddenTurns(turns: StateProjection["turns"]): StateProjection["turns"] {
  return new Proxy(turns, {
    get(target, property, receiver) {
      if (
        property === Symbol.iterator ||
        property === "filter" ||
        property === "map" ||
        property === "flatMap" ||
        property === "forEach" ||
        property === "reduce" ||
        property === "values" ||
        property === "entries" ||
        property === "keys" ||
        property === "find" ||
        property === "findIndex" ||
        property === "some" ||
        property === "every"
      ) {
        throw new Error(`scanned turns via ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("thread status selects unordered and equal-time turns without sorting indexed buckets", () => {
  const latestFailed = statusFixtureTurn("failed", "unordered", "failed", "t3", "t4");
  const unordered = [
    latestFailed,
    statusFixtureTurn("old", "unordered", "completed", "t1", "t2"),
    statusFixtureTurn("middle", "unordered", "completed", "t2", "t3"),
  ];
  const equalTime = [
    statusFixtureTurn("equal-first", "equal", "completed", "t5", "first-completion"),
    statusFixtureTurn("equal-last", "equal", "completed", "t5", "last-completion"),
  ];
  const prioritized = [
    statusFixtureTurn("approval", "priority", "waiting_for_approval", "t1"),
    statusFixtureTurn("running", "priority", "running", "t9"),
  ];
  const forbidSorting = (turns: StateProjection["turns"]): StateProjection["turns"] =>
    new Proxy(turns, {
      get(target, property, receiver) {
        if (property === "sort" || property === "slice") {
          throw new Error(`copied or sorted indexed turns via ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  const threads = [
    statusFixtureThread("unordered"),
    statusFixtureThread("equal"),
    statusFixtureThread("priority"),
  ];
  const projection = {
    threads,
    turns: [...unordered, ...equalTime, ...prioritized],
  } as StateProjection;
  const statuses = projectThreadStatuses(
    projection,
    new Map([
      ["unordered", forbidSorting(unordered)],
      ["equal", forbidSorting(equalTime)],
      ["priority", forbidSorting(prioritized)],
    ]),
  );

  assert.deepEqual(
    statuses.map(({ status, since }) => ({ status, since })),
    [
      { status: "failed", since: "t4" },
      { status: "completed", since: "last-completion" },
      { status: "pending_approval", since: "t1" },
    ],
  );
});

test("thread status and delegated outcomes use indexed turns instead of scanning all turns", () => {
  const childTurn = statusFixtureTurn("turn-child", "child", "completed", "t2", "t3");
  const parentTurn = statusFixtureTurn("turn-parent", "parent", "running", "t1");
  const foreignTurns = Array.from({ length: 4_000 }, (_, index) =>
    statusFixtureTurn(
      `foreign-${index}`,
      "other",
      "completed",
      `t${String(index).padStart(4, "0")}`,
      `t${String(index).padStart(4, "0")}`,
    ),
  );
  const turns = [...foreignTurns, parentTurn, childTurn];
  const index = new Map<string, StateProjection["turns"]>([
    ["parent", [parentTurn]],
    ["child", [childTurn]],
    ["other", foreignTurns],
  ]);
  const projection: StateProjection = {
    schemaVersion: 2,
    sequence: 1,
    projects: [
      { schemaVersion: 2, id: "project-1", name: "fixture", root: "/fixture", openedAt: "t0" },
    ],
    threads: [statusFixtureThread("parent"), statusFixtureThread("child")],
    turns: forbiddenTurns(turns),
    messages: [
      {
        schemaVersion: 2,
        id: "message-child",
        turnId: childTurn.id,
        role: "assistant",
        text: "Indexed result.",
        createdAt: "t3",
      },
    ],
    activities: [],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    governanceCorrelations: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [
      {
        schemaVersion: 2,
        id: "rel-1",
        parentThreadId: "parent",
        childThreadId: "child",
        createdAt: "t1",
      },
    ],
    inputRequests: [],
    inputReceipts: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
  const scanned: StateProjection = { ...projection, turns };
  assert.deepEqual(
    projectThreadStatus(projection, "parent", index),
    projectThreadStatus(scanned, "parent"),
  );
  assert.deepEqual(projectThreadStatuses(projection, index), projectThreadStatuses(scanned));
  assert.deepEqual(
    projectDelegatedConversationOutcomes(projection, index),
    projectDelegatedConversationOutcomes(scanned),
  );
  assert.deepEqual(
    projectThreadStatuses(projection, index).map((item) => [item.threadId, item.status]),
    [
      ["parent", "running"],
      ["child", "completed"],
    ],
  );
  assert.deepEqual(projectDelegatedConversationOutcomes(projection, index), [
    {
      childThreadId: "child",
      completedAt: "t3",
      summary: "Indexed result.",
    },
  ]);
});

test("turn index follows apply, reload, in-place completion, and compaction", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const noisy = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/noisy",
    prompt: "Noisy history",
    mode: "ask",
    provider: "codex-cli",
  });
  let currentTurnId = noisy.turn.id;
  for (let index = 0; index < 8; index += 1) {
    await store.recordProviderEvent(noisy.thread.id, currentTurnId, "codex-cli", {
      kind: "turn_completed",
      sessionId: `noisy-session-${index}`,
      costUsd: 0,
    });
    currentTurnId = (
      await store.startTurn({
        projectId: "project-1",
        worktree: "/fixture/noisy",
        prompt: `Noisy follow-up ${index}`,
        mode: "ask",
        provider: "codex-cli",
        threadId: noisy.thread.id,
      })
    ).turn.id;
  }
  const child = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture/child",
    prompt: "Deliver",
    mode: "build",
    provider: "codex-cli",
  });
  await store.linkDelegatedConversation(noisy.thread.id, child.thread.id);
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "assistant_text",
    text: "Child done.",
  });
  await store.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "turn_completed",
    sessionId: "child-session",
    costUsd: 0,
  });

  const live = await store.inspect();
  const liveSnapshot = await store.inspectWorkbenchProjection();
  const index = await store.turnsByThreadIndex();
  const messagesByTurn = await store.delegatedMessagesByTurnIndex();
  const activitiesByTurn = await store.delegatedActivitiesByTurnIndex();
  assert.equal(
    index.get(noisy.thread.id)?.length,
    live.turns.filter((turn) => turn.threadId === noisy.thread.id).length,
  );
  assert.equal(index.get(child.thread.id)?.length, 1);
  assert.equal(index.get(child.thread.id)?.[0]?.status, "completed");
  assert.deepEqual(projectThreadStatuses(live, index), projectThreadStatuses(live));
  assert.deepEqual(
    projectConversationHistory(
      live as StateProjection,
      noisy.thread.id,
      liveSnapshot.conversationHistory,
    ),
    projectConversationHistory(live as StateProjection, noisy.thread.id),
  );
  assert.equal(liveSnapshot.conversationHistory.messagesByThread.has("missing-thread"), false);
  assert.deepEqual(
    liveSnapshot.conversationHistory.usageReceiptsByThread.get(child.thread.id),
    live.usageReceipts.filter((receipt) => receipt.threadId === child.thread.id),
  );
  assert.deepEqual(
    projectDelegatedConversationOutcomes(live, index, messagesByTurn, activitiesByTurn),
    projectDelegatedConversationOutcomes(live),
  );
  assert.deepEqual(
    [...(messagesByTurn.get(child.turn.id)?.values() ?? [])],
    [...live.messages.filter((message) => message.turnId === child.turn.id)],
  );
  assert.deepEqual(
    [...(activitiesByTurn.get(child.turn.id)?.values() ?? [])],
    [...live.activities.filter((activity) => activity.turnId === child.turn.id)],
  );
  assert.equal(messagesByTurn.has(currentTurnId), false);
  assert.equal(activitiesByTurn.has(currentTurnId), false);

  const reloaded = new LocalStateStore(directory);
  const reloadedIndex = await reloaded.turnsByThreadIndex();
  const reloadedSnapshot = await reloaded.inspectWorkbenchProjection();
  assert.deepEqual(await reloaded.delegatedMessagesByTurnIndex(), messagesByTurn);
  assert.deepEqual(await reloaded.delegatedActivitiesByTurnIndex(), activitiesByTurn);
  assert.deepEqual(
    projectConversationHistory(
      reloadedSnapshot.projection as StateProjection,
      child.thread.id,
      reloadedSnapshot.conversationHistory,
    ),
    projectConversationHistory(reloadedSnapshot.projection as StateProjection, child.thread.id),
  );
  assert.deepEqual(
    reloadedSnapshot.conversationHistory.usageReceiptsByThread.get(child.thread.id),
    liveSnapshot.conversationHistory.usageReceiptsByThread.get(child.thread.id),
  );
  assert.deepEqual(
    [...reloadedIndex.entries()].map(([threadId, turns]) => [
      threadId,
      turns.map((turn) => turn.id),
    ]),
    [...index.entries()].map(([threadId, turns]) => [threadId, turns.map((turn) => turn.id)]),
  );

  await store.deleteConversation(child.thread.id);
  const afterDelete = await store.turnsByThreadIndex();
  assert.equal(afterDelete.has(child.thread.id), false);
  assert.equal((await store.delegatedMessagesByTurnIndex()).has(child.turn.id), false);
  assert.equal((await store.delegatedActivitiesByTurnIndex()).has(child.turn.id), false);
  assert.equal(
    (await store.inspectWorkbenchProjection()).conversationHistory.threadById.has(child.thread.id),
    false,
  );
  assert.equal(
    (await store.inspectWorkbenchProjection()).conversationHistory.usageReceiptsByThread.has(
      child.thread.id,
    ),
    false,
  );
  assert.ok(afterDelete.has(noisy.thread.id));
  assert.equal(await store.inspectThreadBusy(noisy.thread.id), true);
  assert.equal(await store.inspectThreadBusy(child.thread.id), false);
  assert.deepEqual(
    projectThreadStatuses(await store.inspect(), afterDelete),
    projectThreadStatuses(await store.load()),
  );
  assert.deepEqual(
    await store.inspectThreadStatus(noisy.thread.id),
    projectThreadStatus(await store.load(), noisy.thread.id),
  );
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
    () =>
      store.createFork({
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
  assert.deepEqual(
    preview.messages.map((message) => ({ role: message.role, text: message.text })),
    [
      { role: "user", text: "How to install" },
      { role: "assistant", text: "Hello world!" },
    ],
  );
  assert.equal(preview.messages.length, 2);
});

test("assistant stream tokens buffer into one durable message per segment", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Stream carefully",
    mode: "ask",
    provider: "claude-code",
  });
  for (const text of ["Hel", "lo", " ", "wor", "ld"]) {
    await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
      kind: "assistant_text",
      text,
    });
  }
  // Live projection sees the buffered segment before any durable flush.
  const live = await store.load();
  const liveAssistants = live.messages.filter(
    (message) => message.turnId === turn.id && message.role === "assistant",
  );
  assert.equal(liveAssistants.length, 1);
  assert.equal(liveAssistants[0]?.text, "Hello world");
  const liveIndexed = await store.inspectWorkbenchProjection();
  assert.equal(
    liveIndexed.conversationHistory.messagesByThread
      .get(thread.id)
      ?.find((message) => message.role === "assistant")?.text,
    "Hello world",
  );
  // Short segments stay RAM-only until a boundary (below the soft-checkpoint size).
  const midLog = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal([...midLog.matchAll(/"type":"message_saved"/g)].length, 1); // user only

  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "tool_started",
    toolCallId: "tool-1",
    name: "Read",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: "After",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: " tool.",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "stream-session",
    costUsd: 0,
  });

  const rebuilt = await new LocalStateStore(directory).load();
  const assistants = rebuilt.messages
    .filter((message) => message.turnId === turn.id && message.role === "assistant")
    .sort((left, right) => (left.eventSequence ?? 0) - (right.eventSequence ?? 0));
  assert.deepEqual(
    assistants.map((message) => message.text),
    ["Hello world", "After tool."],
  );
  const completedIndexed = await store.inspectWorkbenchProjection();
  assert.deepEqual(
    projectConversationHistory(
      completedIndexed.projection as StateProjection,
      thread.id,
      completedIndexed.conversationHistory,
    ),
    projectConversationHistory(completedIndexed.projection as StateProjection, thread.id),
  );
  const log = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  // user + two assistant segments (not one row per token)
  assert.equal([...log.matchAll(/"type":"message_saved"/g)].length, 3);
});

test("assistant streams soft-checkpoint large growth and flush on demand", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Long reply",
    mode: "ask",
    provider: "claude-code",
  });
  const chunk = "x".repeat(LocalStateStore.ASSISTANT_CHECKPOINT_CHARS);
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: chunk,
  });
  const afterCheckpoint = await readFile(join(directory, "events.v1.jsonl"), "utf8");
  assert.equal([...afterCheckpoint.matchAll(/"type":"message_saved"/g)].length, 2); // user + checkpoint
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "assistant_text",
    text: " tail",
  });
  await store.flushPendingAssistantHistory();
  const rebuilt = await new LocalStateStore(directory).load();
  const assistant = rebuilt.messages.find(
    (message) => message.turnId === turn.id && message.role === "assistant",
  );
  assert.equal(assistant?.text, `${chunk} tail`);
});

test("coalesceConsecutiveAssistantMessages merges tokens and keeps tool splits", () => {
  const turnId = "turn-1";
  const messages = [
    {
      schemaVersion: 2 as const,
      id: "user-1",
      turnId,
      role: "user" as const,
      text: "Go",
      createdAt: "2026-01-01T00:00:00.000Z",
      eventSequence: 1,
    },
    {
      schemaVersion: 2 as const,
      id: "a1",
      turnId,
      role: "assistant" as const,
      text: "Hel",
      createdAt: "2026-01-01T00:00:01.000Z",
      eventSequence: 2,
    },
    {
      schemaVersion: 2 as const,
      id: "a2",
      turnId,
      role: "assistant" as const,
      text: "lo",
      createdAt: "2026-01-01T00:00:02.000Z",
      eventSequence: 3,
    },
    {
      schemaVersion: 2 as const,
      id: "a3",
      turnId,
      role: "assistant" as const,
      text: "After",
      createdAt: "2026-01-01T00:00:04.000Z",
      eventSequence: 5,
    },
  ];
  const activities = [
    {
      schemaVersion: 2 as const,
      id: "act-1",
      turnId,
      kind: "tool_started" as const,
      toolCallId: "tool-1",
      name: "Read",
      failed: null,
      message: null,
      createdAt: "2026-01-01T00:00:03.000Z",
      eventSequence: 4,
    },
  ];
  const coalesced = coalesceConsecutiveAssistantMessages(messages, activities);
  assert.deepEqual(
    coalesced.map((message) => ({ role: message.role, text: message.text })),
    [
      { role: "user", text: "Go" },
      { role: "assistant", text: "Hello" },
      { role: "assistant", text: "After" },
    ],
  );
});

test("history serialization bounds batches and writes an oversized envelope directly", async () => {
  assert.equal(MAX_EVENT_HISTORY_WRITE_BUFFER_BYTES, 256 * 1024);
  const writes: string[] = [];
  const envelopes = [
    {
      schemaVersion: 2 as const,
      sequence: 1,
      id: "event-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      event: {
        type: "message_saved" as const,
        message: {
          schemaVersion: 2 as const,
          id: "message-1",
          turnId: "turn-1",
          role: "assistant" as const,
          text: "small",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    },
    {
      schemaVersion: 2 as const,
      sequence: 2,
      id: "event-2",
      recordedAt: "2026-01-01T00:00:01.000Z",
      event: {
        type: "message_saved" as const,
        message: {
          schemaVersion: 2 as const,
          id: "message-2",
          turnId: "turn-1",
          role: "assistant" as const,
          text: "x".repeat(200),
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      },
    },
  ];
  await writeEventHistory(
    {
      async writeFile(data) {
        writes.push(data);
      },
    },
    envelopes,
    300,
  );

  assert.equal(writes.at(-1), "\n");
  assert.ok(
    writes.slice(0, -1).every((write) => Buffer.byteLength(write) <= 300 || !write.endsWith("\n")),
  );
  assert.equal(writes.join(""), `${envelopes.map((item) => JSON.stringify(item)).join("\n")}\n`);
});

test("compactAssistantStreamHistory rewrites legacy token-per-event logs", async () => {
  const { directory, store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const { thread, turn } = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Legacy stream",
    mode: "ask",
    provider: "claude-code",
  });
  await store.recordProviderEvent(thread.id, turn.id, "claude-code", {
    kind: "turn_completed",
    sessionId: "legacy-session",
    costUsd: 0,
  });
  // Inject pre-fix token rows into the durable log.
  const eventPath = join(directory, "events.v1.jsonl");
  const existing = (await readFile(eventPath, "utf8")).trimEnd();
  const lastSequence = existing
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).sequence as number)
    .at(-1)!;
  const tokenLines = ["A", "B", "C", "D"].map((text, index) =>
    JSON.stringify({
      schemaVersion: 2,
      sequence: lastSequence + index + 1,
      id: `legacy-token-${index}`,
      recordedAt: new Date().toISOString(),
      event: {
        type: "message_saved",
        message: {
          schemaVersion: 2,
          id: `token-${index}`,
          turnId: turn.id,
          role: "assistant",
          text,
          createdAt: new Date().toISOString(),
        },
      },
    }),
  );
  await writeFile(eventPath, `${existing}\n${tokenLines.join("\n")}\n`, "utf8");

  const recovered = new LocalStateStore(directory);
  const result = await recovered.compactAssistantStreamHistory();
  assert.deepEqual(result, { before: 5, after: 2 }); // user + 4 tokens → user + 1 assistant
  const final = await recovered.load();
  const assistants = final.messages.filter(
    (message) => message.turnId === turn.id && message.role === "assistant",
  );
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0]?.text, "ABCD");
  assert.equal(await recovered.compactAssistantStreamHistory(), null);
});

test("inspect reuses the live projection while load returns an isolated clone", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const first = await store.inspect();
  const second = await store.inspect();
  assert.equal(first, second);
  assert.equal(first.projects.length, 1);

  const clone = await store.load();
  assert.notEqual(clone, first);
  assert.deepEqual(clone.projects, first.projects);
  // Mutating the load() clone must not corrupt the live projection used by
  // hot paths (status projection, wake filters, provider event loops).
  clone.projects[0] = { ...clone.projects[0]!, name: "mutated-clone" };
  clone.projects.push({
    schemaVersion: 2,
    id: "ghost",
    name: "ghost",
    root: "/ghost",
    openedAt: new Date().toISOString(),
  });
  assert.equal((await store.inspect()).projects.length, 1);
  assert.equal((await store.inspect()).projects[0]?.name, "fixture");
  assert.equal((await store.load()).projects.length, 1);
  assert.equal((await store.load()).projects[0]?.name, "fixture");
});
