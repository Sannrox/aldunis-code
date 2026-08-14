import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.match(CURRENT_WORKSPACE_RECOVERY_COPY.detail, /clean index/);
  assert.match(CURRENT_WORKSPACE_RECOVERY_COPY.detail, /keep staged local changes/);
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

test("in-flight workspace creation cannot dismiss the overlay", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    "conversation-workspace-dialog.tsx",
    "start-delegated-conversation-dialog.tsx",
    "fork-conversation-dialog.tsx",
  ].map((name) => readFileSync(join(here, name), "utf8"));
  for (const source of sources) {
    assert.match(source, /dismissible=\{!busy\}/);
    assert.doesNotMatch(source, /onClose=\{busy \? \(\) => undefined : onClose\}/);
  }
});
