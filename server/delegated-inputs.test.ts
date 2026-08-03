import assert from "node:assert/strict";
import test from "node:test";
import { assertParentRoutedInput, projectDelegatedInputs } from "./delegated-inputs.ts";
import { LocalStateError, type StateProjection } from "./state.ts";

const request = {
  schemaVersion: 2 as const,
  id: "request-1",
  threadId: "child",
  turnId: "turn-child",
  providerRunId: "run-child",
  question: "Continue?",
  choices: [],
  recommendation: null,
  responseMode: "child_follow_up" as const,
  providerRequestId: null,
  state: "pending" as const,
  createdAt: "2026-07-30T00:00:00.000Z",
  answeredAt: null,
  expiresAt: null,
  allowFreeForm: true,
};

function projection(): StateProjection {
  return {
    schemaVersion: 2,
    sequence: 0,
    projects: [],
    threads: [],
    turns: [{
      schemaVersion: 2,
      id: "turn-child",
      threadId: "child",
      status: "waiting_for_user",
      providerRunId: "run-child",
      createdAt: request.createdAt,
      completedAt: null,
    }],
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [{
      schemaVersion: 2,
      id: "relationship-1",
      parentThreadId: "parent",
      childThreadId: "child",
      createdAt: request.createdAt,
    }],
    inputRequests: [request],
    inputReceipts: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
}

test("delegated inputs project only the exact pending child turn", () => {
  assert.equal(projectDelegatedInputs(projection()).length, 1);
  const stale = projection();
  stale.turns[0].providerRunId = "other-run";
  assert.deepEqual(projectDelegatedInputs(stale), []);
});

test("parent-routed input requires the live relationship and request", () => {
  assert.equal(
    assertParentRoutedInput(projection(), "parent", "child", "request-1").id,
    "request-1",
  );
  assert.throws(
    () => assertParentRoutedInput(projection(), "other", "child", "request-1"),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
});
