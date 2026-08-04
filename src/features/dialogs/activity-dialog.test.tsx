import assert from "node:assert/strict";
import test from "node:test";
import {
  activityBucket,
  activityCounts,
  activityStatusLabel,
  sortActivity,
} from "./activity-dialog";
import type { ConversationSummary } from "../../types";

function conversation(id: string, status: ConversationSummary["status"], settledAt: string | null = null): ConversationSummary {
  return {
    id,
    projectId: "project-1",
    title: id,
    worktree: `/tmp/${id}`,
    provider: "codex-cli",
    updatedAt: `2026-08-04T12:0${id.length}.000Z`,
    status,
    statusSince: `2026-08-04T12:0${id.length}.000Z`,
    settledAt,
    projectName: "Aldunis Code",
  };
}

test("activity groups expose attention, running, completed, and idle work", () => {
  const items = [
    conversation("approval", "pending_approval"),
    conversation("running", "running"),
    conversation("done", "completed", "2026-08-04T12:30:00.000Z"),
    conversation("idle", "idle"),
  ];
  assert.deepEqual(activityCounts(items), { attention: 1, running: 1, completed: 1, idle: 1 });
  assert.equal(activityBucket(items[0]!), "attention");
  assert.equal(activityStatusLabel("awaiting_input"), "Input needed");
  assert.equal(activityStatusLabel("completed"), "Completed");
});

test("activity sorting puts attention before running and settled work", () => {
  const items = [conversation("done", "completed"), conversation("running", "running"), conversation("failed", "failed")];
  assert.deepEqual(sortActivity(items).map((item) => item.id), ["failed", "running", "done"]);
});
