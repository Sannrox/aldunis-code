import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_PR_BATCH_LIMIT,
  BRANCH_PR_CACHE_LIMIT,
  BRANCH_PR_CACHE_TTL_MS,
  BranchPrResultCache,
  clearBranchPrCache,
  normalizeBranchPrState,
  parseBranchPrPayload,
} from "./branch-pr.ts";

function lookup(index: number) {
  return { worktree: `/wt/${index}`, branch: `codex/${index}`, pr: null };
}

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

test("branch PR cache bounds one complete inbox and promotes hits", () => {
  const cache = new BranchPrResultCache();
  for (let index = 0; index < BRANCH_PR_CACHE_LIMIT; index += 1) {
    const value = lookup(index);
    cache.set(value.worktree, value, 1_000);
  }
  assert.equal(cache.size, BRANCH_PR_CACHE_LIMIT);

  assert.equal(cache.get(lookup(0).worktree, 1_001)?.branch, "codex/0");
  const overflow = lookup(BRANCH_PR_CACHE_LIMIT);
  cache.set(overflow.worktree, overflow, 1_002);
  assert.equal(cache.size, BRANCH_PR_CACHE_LIMIT);
  assert.ok(cache.get(lookup(0).worktree, 1_003));
  assert.equal(cache.get(lookup(1).worktree, 1_003), null);
});

test("branch PR cache purges expired entries across unrelated keys", () => {
  const cache = new BranchPrResultCache();
  const first = lookup(1);
  const second = lookup(2);
  cache.set(first.worktree, first, 1_000);
  cache.set(second.worktree, second, 2_000);

  assert.equal(cache.get("/unrelated", 1_000 + BRANCH_PR_CACHE_TTL_MS), null);
  assert.equal(cache.size, 1);
  assert.equal(cache.get(first.worktree, 1_000 + BRANCH_PR_CACHE_TTL_MS), null);
  assert.ok(cache.get(second.worktree, 1_000 + BRANCH_PR_CACHE_TTL_MS));
});
