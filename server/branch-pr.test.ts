import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_PR_BATCH_LIMIT,
  clearBranchPrCache,
  normalizeBranchPrState,
  parseBranchPrPayload,
} from "./branch-pr.ts";

test("normalizeBranchPrState accepts GitHub PR state labels", () => {
  assert.equal(normalizeBranchPrState("OPEN"), "open");
  assert.equal(normalizeBranchPrState("merged"), "merged");
  assert.equal(normalizeBranchPrState(" Closed "), "closed");
  assert.equal(normalizeBranchPrState("draft"), null);
  assert.equal(normalizeBranchPrState(1), null);
});

test("parseBranchPrPayload requires number, title, state, and https URL", () => {
  assert.deepEqual(
    parseBranchPrPayload("/wt", "codex/feature", {
      number: 42,
      title: "Add feature",
      state: "OPEN",
      url: "https://github.com/org/repo/pull/42",
    }),
    {
      worktree: "/wt",
      branch: "codex/feature",
      number: 42,
      title: "Add feature",
      state: "open",
      url: "https://github.com/org/repo/pull/42",
    },
  );
  assert.equal(
    parseBranchPrPayload("/wt", "codex/feature", {
      number: 42,
      title: "Add feature",
      state: "OPEN",
      url: "http://evil.example/pull/42",
    }),
    null,
  );
  assert.equal(
    parseBranchPrPayload("/wt", "codex/feature", {
      number: 0,
      title: "x",
      state: "open",
      url: "https://x",
    }),
    null,
  );
  assert.equal(parseBranchPrPayload("/wt", "codex/feature", null), null);
});

test("batch limit is bounded for inbox-scale lookups", () => {
  assert.ok(BRANCH_PR_BATCH_LIMIT >= 8);
  assert.ok(BRANCH_PR_BATCH_LIMIT <= 32);
  clearBranchPrCache();
});
