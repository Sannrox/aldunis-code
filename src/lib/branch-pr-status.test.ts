import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_PR_CLIENT_BATCH_LIMIT,
  chunkWorktreeRoots,
  indexBranchPrResults,
  prStatusAriaLabel,
  prStatusLabel,
  uniqueWorktreeRoots,
} from "./branch-pr-status";
import type { BranchPrStatus } from "../types";

const sample: BranchPrStatus = {
  worktree: "/wt/a",
  branch: "codex/x",
  number: 12,
  title: "Ship feature",
  state: "open",
  url: "https://github.com/org/repo/pull/12",
};

test("pr status labels stay compact for row chrome", () => {
  assert.equal(prStatusLabel(sample), "PR #12");
  assert.equal(prStatusLabel({ ...sample, state: "merged" }), "Merged #12");
  assert.equal(prStatusLabel({ ...sample, state: "closed" }), "Closed #12");
  assert.match(prStatusAriaLabel(sample), /Ship feature/);
});

test("index and unique helpers prepare batch sidebar lookups", () => {
  const map = indexBranchPrResults([
    { worktree: "/wt/a", branch: "codex/x", pr: sample },
    { worktree: "/wt/b", branch: "main", pr: null },
  ]);
  assert.equal(map.get("/wt/a")?.number, 12);
  assert.equal(map.has("/wt/b"), false);
  assert.deepEqual(
    uniqueWorktreeRoots([
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/b" },
    ]),
    [
      { root: "/repo", worktree: "/wt/a" },
      { root: "/repo", worktree: "/wt/b" },
    ],
  );
  assert.equal(
    uniqueWorktreeRoots(
      Array.from({ length: 30 }, (_, index) => ({
        root: "/repo",
        worktree: `/wt/${index}`,
      })),
      BRANCH_PR_CLIENT_BATCH_LIMIT,
    ).length,
    BRANCH_PR_CLIENT_BATCH_LIMIT,
  );
  assert.equal(
    chunkWorktreeRoots(
      Array.from({ length: 50 }, (_, i) => i),
      24,
    ).length,
    3,
  );
});
