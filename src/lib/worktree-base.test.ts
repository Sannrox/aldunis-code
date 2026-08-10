import assert from "node:assert/strict";
import test from "node:test";
import { defaultWorktreeBase, worktreeBaseBranchOptions } from "./worktree-base";

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
