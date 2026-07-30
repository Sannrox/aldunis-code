import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationSummary,
  DelegatedConversationRelationship,
} from "../../types";
import {
  isQuietDelegatedChild,
  shouldNotifyForRestoredTurn,
  summarizeDelegatedOutcomes,
} from "./delegated-outcomes";

function conversation(
  id: string,
  status: ConversationSummary["status"],
): ConversationSummary {
  return {
    id,
    projectId: "project",
    projectName: "Project",
    title: id,
    worktree: `/repo/${id}`,
    provider: "codex-cli",
    updatedAt: "2026-07-30T10:00:00.000Z",
    status,
  };
}

const relationships: DelegatedConversationRelationship[] = [
  {
    id: "later",
    parentThreadId: "parent",
    childThreadId: "completed",
    createdAt: "2026-07-30T10:02:00.000Z",
  },
  {
    id: "earlier",
    parentThreadId: "parent",
    childThreadId: "approval",
    createdAt: "2026-07-30T10:01:00.000Z",
  },
  {
    id: "other-parent",
    parentThreadId: "other",
    childThreadId: "running",
    createdAt: "2026-07-30T10:00:00.000Z",
  },
];

test("delegated outcomes keep relationship chronology and aggregate blocking states", () => {
  const summary = summarizeDelegatedOutcomes("parent", [
    conversation("completed", "completed"),
    conversation("approval", "pending_approval"),
    conversation("running", "running"),
  ], relationships);

  assert.deepEqual(summary.outcomes.map(({ child }) => child.id), ["approval", "completed"]);
  assert.deepEqual({
    running: summary.running,
    approvals: summary.approvals,
    inputs: summary.inputs,
    failures: summary.failures,
    completed: summary.completed,
  }, {
    running: 0,
    approvals: 1,
    inputs: 0,
    failures: 0,
    completed: 1,
  });
});

test("only a child of the focused parent receives quiet notification policy", () => {
  assert.equal(isQuietDelegatedChild("approval", "parent", relationships), true);
  assert.equal(isQuietDelegatedChild("approval", "other", relationships), false);
  assert.equal(isQuietDelegatedChild(null, "parent", relationships), false);
});

test("quiet delegated children notify only for blocking decisions and failures", () => {
  assert.equal(shouldNotifyForRestoredTurn("completed", true, "hidden", true), false);
  assert.equal(shouldNotifyForRestoredTurn("interrupted", true, "hidden", true), false);
  assert.equal(shouldNotifyForRestoredTurn("waiting_for_approval", true, "hidden", true), true);
  assert.equal(shouldNotifyForRestoredTurn("waiting_for_user", true, "hidden", true), true);
  assert.equal(shouldNotifyForRestoredTurn("failed", true, "hidden", true), true);
  assert.equal(shouldNotifyForRestoredTurn("completed", true, "hidden", false), true);
  assert.equal(shouldNotifyForRestoredTurn("failed", false, "hidden", true), false);
  assert.equal(shouldNotifyForRestoredTurn("failed", true, "visible", true), false);
});
