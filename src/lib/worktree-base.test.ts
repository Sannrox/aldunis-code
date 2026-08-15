import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWorktreeBase,
  MAX_WORKTREE_BASE_SUGGESTIONS,
  worktreeBaseBranchOptions,
} from "./worktree-base";

test("base options prefer unique local and worktree branch names", () => {
  assert.deepEqual(
    worktreeBaseBranchOptions({
      defaultBranch: "main",
      localBranches: ["main", "feature", "main"],
      worktrees: [{ branch: "hotfix" }, { branch: null }, { branch: "feature" }],
    }),
    ["feature", "hotfix", "main"],
  );
});

test("default base uses the repository default when available", () => {
  assert.equal(
    defaultWorktreeBase({
      defaultBranch: "main",
      localBranches: ["feature", "main"],
    }),
    "main",
  );
});

test("default base falls back to the first known local branch", () => {
  assert.equal(
    defaultWorktreeBase({
      defaultBranch: null,
      localBranches: ["feature", "release"],
    }),
    "feature",
  );
  assert.equal(defaultWorktreeBase({ defaultBranch: null, localBranches: [] }), "");
});

test("truncated repositories keep default and active branches within the suggestion ceiling", () => {
  const options = worktreeBaseBranchOptions({
    defaultBranch: "zz-default",
    localBranchesTruncated: true,
    localBranches: Array.from({ length: 500 }, (_, index) => `branch-${index}`),
    worktrees: [{ branch: "zz-active" }],
  });

  assert.equal(options.length, MAX_WORKTREE_BASE_SUGGESTIONS);
  assert.equal(options.includes("zz-default"), true);
  assert.equal(options.includes("zz-active"), true);
});

test("legacy repository responses cannot bypass the renderer suggestion ceiling", () => {
  const options = worktreeBaseBranchOptions({
    localBranches: Array.from({ length: 500 }, (_, index) => `branch-${index}`),
  });

  assert.equal(options.length, MAX_WORKTREE_BASE_SUGGESTIONS);
});
