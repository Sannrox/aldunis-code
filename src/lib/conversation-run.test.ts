import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../types";
import { initialConversationRunState, reduceConversationRun } from "./conversation-run";

const at = "2026-08-10T18:30:00.000Z";

test("one run moves through start, streaming, and completion", () => {
  let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
  state = reduceConversationRun(state, { type: "stream_opened", epoch: 1 });
  state = reduceConversationRun(state, {
    type: "provider_event",
    epoch: 1,
    occurredAt: at,
    event: { kind: "assistant_text", text: "Done" },
  });
  state = reduceConversationRun(state, {
    type: "provider_event",
    epoch: 1,
    occurredAt: at,
    event: { kind: "turn_completed", sessionId: "session-1", costUsd: null },
  });
  assert.equal(state.providerState, "completed");
  assert.equal(state.sessionId, "session-1");
  assert.equal(state.assistantTurnAt, at);
  assert.deepEqual(
    state.events.map((event) => event.kind),
    ["assistant_text", "turn_completed"],
  );
});

test("stale run events cannot overwrite the active run", () => {
  let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
  state = reduceConversationRun(state, { type: "start", epoch: 2 });
  const next = reduceConversationRun(state, {
    type: "provider_event",
    epoch: 1,
    occurredAt: at,
    event: { kind: "failed", message: "late failure" },
  });
  assert.strictEqual(next, state);
  assert.equal(next.providerState, "starting");
  assert.deepEqual(next.events, []);
});

test("reset invalidates events from the prior conversation scope", () => {
  let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
  state = reduceConversationRun(state, { type: "reset", epoch: 2 });
  const next = reduceConversationRun(state, {
    type: "provider_event",
    epoch: 1,
    occurredAt: at,
    event: { kind: "assistant_text", text: "wrong conversation" },
  });
  assert.strictEqual(next, state);
  assert.equal(next.providerState, "idle");
  assert.deepEqual(next.events, []);
});

test("interaction failures stay visible without terminating the provider run", () => {
  let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
  state = reduceConversationRun(state, { type: "stream_opened", epoch: 1 });
  state = reduceConversationRun(state, { type: "interaction_failed", message: "Decision failed" });
  assert.equal(state.providerState, "streaming");
  assert.deepEqual(state.events.at(-1), { kind: "failed", message: "Decision failed" });
});

test("cancellation and failure close pending approvals", () => {
  const approval = {
    kind: "approval_pending",
    id: "approval-1",
    runId: "run-1",
    conversationId: "thread-1",
    repository: "/repo",
    worktree: "/repo",
    provider: "codex-cli",
    toolCallId: "tool-1",
    toolName: "write",
    scope: { summary: "Write", target: "file", details: [] },
    state: "pending",
    expiresAt: at,
  } satisfies ProviderEvent;
  for (const terminal of [
    { kind: "cancelled" } as const,
    { kind: "failed", message: "nope" } as const,
  ]) {
    let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
    state = reduceConversationRun(state, {
      type: "provider_event",
      epoch: 1,
      occurredAt: at,
      event: approval,
    });
    state = reduceConversationRun(state, {
      type: "provider_event",
      epoch: 1,
      occurredAt: at,
      event: terminal,
    });
    const pending = state.events.find((event) => event.kind === "approval_pending");
    assert.equal(pending?.state, terminal.kind === "cancelled" ? "cancelled" : "provider_failed");
    assert.equal(state.providerState, terminal.kind === "cancelled" ? "cancelled" : "failed");
  }
});

test("input resolution and transient browser frames stay normalized", () => {
  let state = reduceConversationRun(initialConversationRunState(), { type: "start", epoch: 1 });
  const events: ProviderEvent[] = [
    {
      kind: "browser_observation",
      provider: "codex-cli",
      observationId: "one",
      imageData: "data:image/jpeg;base64,AA==",
      mediaType: "image/jpeg",
    },
    {
      kind: "browser_observation",
      provider: "codex-cli",
      observationId: "two",
      imageData: "data:image/jpeg;base64,AQ==",
      mediaType: "image/jpeg",
    },
    { kind: "input_resolved", id: "input-1", state: "answered" },
  ];
  for (const event of events)
    state = reduceConversationRun(state, {
      type: "provider_event",
      epoch: 1,
      occurredAt: at,
      event,
    });
  assert.equal(state.events.filter((event) => event.kind === "browser_observation").length, 1);
  assert.equal(state.providerState, "streaming");
});
