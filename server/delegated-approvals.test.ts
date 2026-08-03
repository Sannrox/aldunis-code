import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalSnapshot } from "./permission.ts";
import {
  assertParentRoutedApproval,
  projectDelegatedApprovals,
} from "./delegated-approvals.ts";
import type { StateProjection } from "./state.ts";

function fixture(): StateProjection {
  return {
    schemaVersion: 2,
    sequence: 1,
    projects: [],
    threads: [],
    turns: [{
      schemaVersion: 2,
      id: "turn-child",
      threadId: "child",
      status: "waiting_for_approval",
      createdAt: "2026-07-30T10:00:00.000Z",
      completedAt: null,
      providerRunId: "run-child",
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
      id: "relationship",
      parentThreadId: "parent",
      childThreadId: "child",
      createdAt: "2026-07-30T09:00:00.000Z",
    }],
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
}

function approval(overrides: Partial<ApprovalSnapshot> = {}): ApprovalSnapshot {
  return {
    id: "approval",
    runId: "run-child",
    conversationId: "child",
    repository: "/repo",
    worktree: "/repo/child",
    provider: "codex-cli",
    toolCallId: "tool",
    toolName: "Edit",
    scope: { summary: "Edit a file", target: "path: src/a.ts", details: [] },
    state: "pending",
    expiresAt: "2026-07-30T10:05:00.000Z",
    ...overrides,
  };
}

test("delegated approvals project only current pending child authority", () => {
  const state = fixture();
  assert.deepEqual(projectDelegatedApprovals(state, [approval()]), [{
    parentThreadId: "parent",
    childThreadId: "child",
    approval: approval(),
  }]);
  assert.deepEqual(projectDelegatedApprovals(state, [approval({ state: "denied" })]), []);
  assert.deepEqual(projectDelegatedApprovals(state, [approval({ conversationId: "other" })]), []);
  assert.deepEqual(projectDelegatedApprovals(state, [approval({ runId: "stale-run" })]), []);
});

test("parent-routed approval requires the exact live relationship and approval", () => {
  const state = fixture();
  assert.doesNotThrow(() => assertParentRoutedApproval(state, [approval()], {
    parentThreadId: "parent",
    childThreadId: "child",
    approvalId: "approval",
  }));
  assert.doesNotThrow(() => assertParentRoutedApproval(
    state,
    [approval({ state: "denied" })],
    {
      parentThreadId: "parent",
      childThreadId: "child",
      approvalId: "approval",
    },
  ));
  for (const binding of [
    { parentThreadId: "other", childThreadId: "child", approvalId: "approval" },
    { parentThreadId: "parent", childThreadId: "other", approvalId: "approval" },
    { parentThreadId: "parent", childThreadId: "child", approvalId: "other" },
  ]) {
    assert.throws(
      () => assertParentRoutedApproval(state, [approval()], binding),
      (error: unknown) => (
        error instanceof Error
        && "status" in error
        && error.status === 403
      ),
    );
  }
});

test("a concurrent pending approval remains projected after its sibling resolves", () => {
  const state = fixture();
  state.turns[0] = { ...state.turns[0], status: "active" };
  assert.deepEqual(
    projectDelegatedApprovals(state, [
      approval({ id: "resolved", state: "denied" }),
      approval({ id: "still-pending", toolCallId: "tool-2" }),
    ]).map((item) => item.approval.id),
    ["still-pending"],
  );
});
