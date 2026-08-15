import assert from "node:assert/strict";
import test from "node:test";
import {
  activityBucket,
  activityCounts,
  activityFilterCount,
  activityFilterLabel,
  activityNextActionLabel,
  activityStatusLabel,
  activityWorktreeLabel,
  filterActivity,
  MAX_ACTIVITY_ROWS,
  selectActivityRows,
  sortActivity,
} from "./activity-dialog";
import type { ConversationSummary } from "../../types";

function conversation(
  id: string,
  status: ConversationSummary["status"],
  settledAt: string | null = null,
): ConversationSummary {
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
  const items = [
    conversation("done", "completed"),
    conversation("running", "running"),
    conversation("failed", "failed"),
  ];
  assert.deepEqual(
    sortActivity(items).map((item) => item.id),
    ["failed", "running", "done"],
  );
});

test("activity filters preserve the full list while narrowing by status", () => {
  const items = [
    conversation("approval", "pending_approval"),
    conversation("running", "running"),
    conversation("idle", "idle"),
  ];
  assert.deepEqual(
    filterActivity(items, "all").map(({ id }) => id),
    ["approval", "running", "idle"],
  );
  assert.deepEqual(
    filterActivity(items, "attention").map(({ id }) => id),
    ["approval"],
  );
  assert.equal(activityFilterCount(items, "running"), 1);
  assert.equal(activityFilterLabel("completed"), "Completed");
});

test("activity row selection retains only the highest-priority bounded page", () => {
  const items = Array.from({ length: 1_000 }, (_, index) =>
    conversation(`item-${index.toString().padStart(4, "0")}`, index % 3 === 0 ? "failed" : "idle"),
  );
  const inventory = new Proxy(items, {
    get(target, property, receiver) {
      if (
        property === "filter" ||
        property === "map" ||
        property === "slice" ||
        property === "sort"
      ) {
        throw new Error(`activity inventory must not call ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const selected = selectActivityRows(inventory, "all");
  const expected = sortActivity(items).slice(0, MAX_ACTIVITY_ROWS);

  assert.equal(selected.total, items.length);
  assert.equal(selected.rows.length, MAX_ACTIVITY_ROWS);
  assert.deepEqual(
    selected.rows.map(({ id }) => id),
    expected.map(({ id }) => id),
  );
  assert.deepEqual(
    items.map(({ id }) => id),
    Array.from({ length: 1_000 }, (_, index) => `item-${index.toString().padStart(4, "0")}`),
  );

  const attention = selectActivityRows(inventory, "attention", 7);
  assert.equal(attention.total, 334);
  assert.equal(attention.rows.length, 7);
  assert.deepEqual(selectActivityRows(inventory, "all", 0), { rows: [], total: items.length });
  assert.equal(selectActivityRows(inventory, "all", 10_000).rows.length, MAX_ACTIVITY_ROWS);
});

test("activity rows explain the next bounded operator action", () => {
  assert.equal(
    activityNextActionLabel(conversation("approval", "pending_approval")),
    "Resolve approval",
  );
  assert.equal(activityNextActionLabel(conversation("input", "awaiting_input")), "Answer input");
  assert.equal(activityNextActionLabel(conversation("failed", "failed")), "Inspect failure");
  assert.equal(activityNextActionLabel(conversation("idle", "idle")), "Resume conversation");
  assert.equal(activityWorktreeLabel("/Users/example/project/.worktrees/feature"), "feature");
  assert.equal(activityWorktreeLabel(""), "selected worktree");
});

test("settled failed conversations leave Attention and match the Completed label", () => {
  const settledFailed = conversation("settled-failed", "failed", "2026-08-04T13:00:00.000Z");
  const openFailed = conversation("open-failed", "failed");
  const items = [settledFailed, openFailed];

  assert.equal(activityBucket(settledFailed), "completed");
  assert.equal(activityBucket(openFailed), "attention");
  assert.equal(activityStatusLabel(settledFailed.status, settledFailed.settledAt), "Completed");
  assert.equal(activityNextActionLabel(settledFailed), "Review outcome");
  assert.deepEqual(activityCounts(items), { attention: 1, running: 0, completed: 1, idle: 0 });
  assert.deepEqual(
    filterActivity(items, "attention").map(({ id }) => id),
    ["open-failed"],
  );
  assert.deepEqual(
    selectActivityRows(items, "attention").rows.map(({ id }) => id),
    ["open-failed"],
  );
});
