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
    turns: [
      {
        schemaVersion: 2,
        id: "turn-child",
        threadId: "child",
        status: "waiting_for_user",
        providerRunId: "run-child",
        createdAt: request.createdAt,
        completedAt: null,
      },
    ],
    messages: [],
    activities: [],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [
      {
        schemaVersion: 2,
        id: "relationship-1",
        parentThreadId: "parent",
        childThreadId: "child",
        createdAt: request.createdAt,
      },
    ],
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

test("delegated input projection indexes only candidate turn identities", () => {
  const state = projection();
  state.turns.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({
      ...state.turns[0],
      id: `unrelated-turn-${index}`,
      threadId: `unrelated-thread-${index}`,
      providerRunId: `unrelated-run-${index}`,
    })),
  );
  state.turns = new Proxy(state.turns, {
    get(target, property, receiver) {
      if (property === Symbol.iterator || property === "map") {
        throw new Error("delegated input projection must not materialize the complete turn ledger");
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(projectDelegatedInputs(state).length, 1);
});

test("delegated input projection skips retained history without a candidate request", () => {
  const state = projection();
  state.inputRequests = [{ ...request, state: "answered", answeredAt: request.createdAt }];
  const inaccessible = new Proxy(state.turns, {
    get() {
      throw new Error("retained turns must stay untouched without candidate input");
    },
  });
  state.turns = inaccessible;

  assert.deepEqual(projectDelegatedInputs(state), []);
});

test("pending native resume does not project a terminal turn while resume remains available", () => {
  const state = projection();
  state.inputRequests = [
    {
      ...request,
      responseMode: "native_resume",
      providerRequestId: "provider-request",
      resumeState: "available",
      resumeError: null,
    },
  ];
  state.turns[0] = { ...state.turns[0], status: "interrupted" };

  assert.deepEqual(projectDelegatedInputs(state), []);
  state.inputRequests[0] = {
    ...state.inputRequests[0],
    state: "cancelled",
    resumeState: "unavailable",
    resumeError: "Native resume is unavailable.",
  };
  assert.equal(projectDelegatedInputs(state).length, 1);
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
