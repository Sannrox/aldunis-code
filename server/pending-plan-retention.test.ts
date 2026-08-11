import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PENDING_APPROVAL_PLANS, retainBoundedPendingPlan } from "./pending-plan-retention.ts";

function plan(id: string, expiresAt: number) {
  return { id, expiresAt: new Date(expiresAt).toISOString() };
}

test("pending plan retention removes expired previews", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const plans = new Map([
    ["expired", plan("expired", now)],
    ["pending", plan("pending", now + 60_000)],
  ]);

  retainBoundedPendingPlan(plans, plan("new", now + 60_000), now);

  assert.deepEqual([...plans.keys()], ["pending", "new"]);
});

test("pending plan retention evicts the oldest preview above the limit", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const plans = new Map<string, ReturnType<typeof plan>>();
  for (let index = 0; index <= MAX_PENDING_APPROVAL_PLANS; index += 1) {
    retainBoundedPendingPlan(plans, plan(`plan-${index}`, now + 60_000), now);
  }

  assert.equal(plans.size, MAX_PENDING_APPROVAL_PLANS);
  assert.equal(plans.has("plan-0"), false);
  assert.equal(plans.has("plan-1"), true);
  assert.equal(plans.has(`plan-${MAX_PENDING_APPROVAL_PLANS}`), true);
});

test("zero retention rejects the newly created preview", () => {
  const now = Date.parse("2026-08-11T12:00:00.000Z");
  const plans = new Map<string, ReturnType<typeof plan>>();

  retainBoundedPendingPlan(plans, plan("new", now + 60_000), now, 0);

  assert.equal(plans.size, 0);
});
