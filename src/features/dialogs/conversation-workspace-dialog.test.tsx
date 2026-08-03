import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCurrentWorkspace,
  CLEAN_REPOSITORY_ERROR,
  CURRENT_WORKSPACE_RECOVERY_COPY,
  isDirtyRepositoryError,
} from "./conversation-workspace-dialog";

const userWorktree = {
  path: "/tmp/example",
  head: "a".repeat(40),
  branch: "main",
  state: "available" as const,
  ownership: "user" as const,
  recovery: "available" as const,
  originalPath: null,
};

test("shared-workspace recovery copy explains how dirty changes are preserved", () => {
  assert.equal(CURRENT_WORKSPACE_RECOVERY_COPY.label, "Use current workspace");
  assert.match(CURRENT_WORKSPACE_RECOVERY_COPY.detail, /clean repository/);
  assert.match(CURRENT_WORKSPACE_RECOVERY_COPY.detail, /keep local changes/);
  assert.equal(isDirtyRepositoryError(CLEAN_REPOSITORY_ERROR), true);
  assert.equal(isDirtyRepositoryError("The branch name is invalid."), false);
});

test("shared-workspace recovery is available only for user-owned worktrees", () => {
  const onUseCurrentWorkspace = () => undefined;
  assert.equal(canUseCurrentWorkspace(userWorktree, onUseCurrentWorkspace, true), true);
  assert.equal(canUseCurrentWorkspace(userWorktree, onUseCurrentWorkspace, false), false);
  assert.equal(
    canUseCurrentWorkspace({ ...userWorktree, ownership: "aldunis" }, onUseCurrentWorkspace, true),
    false,
  );
  assert.equal(canUseCurrentWorkspace(userWorktree, undefined, true), false);
});
