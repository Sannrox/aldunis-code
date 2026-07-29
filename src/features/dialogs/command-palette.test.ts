import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_WORKTREE_ACTION_COPY } from "./command-palette";

test("worktree palette action describes its create-only destination", () => {
  assert.deepEqual(CREATE_WORKTREE_ACTION_COPY, {
    label: "Create worktree",
    detail: "Create an isolated managed checkout for conversation work",
  });
  assert.match(
    `${CREATE_WORKTREE_ACTION_COPY.label} ${CREATE_WORKTREE_ACTION_COPY.detail}`,
    /worktree|checkout/i,
  );
});
