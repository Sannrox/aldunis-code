import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSplitPercent,
  normalizeSplitWorkspaceState,
} from "../src/split-workspace.ts";

test("split workspace clamps persisted divider sizes", () => {
  assert.equal(clampSplitPercent(10), 30);
  assert.equal(clampSplitPercent(55), 55);
  assert.equal(clampSplitPercent(90), 70);
  assert.equal(clampSplitPercent(Number.NaN), 50);
});

test("split workspace recovers a primary and never duplicates it beside itself", () => {
  assert.deepEqual(normalizeSplitWorkspaceState({
    primaryId: "conversation-1",
    secondaryId: "conversation-1",
    splitPercent: 60,
  }, "fallback"), {
    primaryId: "conversation-1",
    secondaryId: null,
    splitPercent: 60,
  });
  assert.deepEqual(normalizeSplitWorkspaceState({}, "fallback"), {
    primaryId: "fallback",
    secondaryId: null,
    splitPercent: 50,
  });
  assert.deepEqual(normalizeSplitWorkspaceState({
    primaryId: 1,
    secondaryId: { stale: true },
    splitPercent: "wide",
  }, "fallback"), {
    primaryId: "fallback",
    secondaryId: null,
    splitPercent: 50,
  });
});
