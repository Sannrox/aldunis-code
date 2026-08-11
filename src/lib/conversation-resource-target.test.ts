import assert from "node:assert/strict";
import test from "node:test";
import { conversationResourceTarget } from "./conversation-resource-target";

test("equivalent projection objects preserve one primitive resource identity", () => {
  assert.deepEqual(
    conversationResourceTarget({ root: "/repo" }, { path: "/repo-worktree" }),
    conversationResourceTarget({ root: "/repo" }, { path: "/repo-worktree" }),
  );
});

test("resource identity changes with repository root or selected worktree", () => {
  const initial = conversationResourceTarget({ root: "/repo" }, { path: "/repo-worktree" });
  assert.notDeepEqual(
    initial,
    conversationResourceTarget({ root: "/other" }, { path: "/repo-worktree" }),
  );
  assert.notDeepEqual(
    initial,
    conversationResourceTarget({ root: "/repo" }, { path: "/other-worktree" }),
  );
  assert.deepEqual(conversationResourceTarget(null, null), [null, null]);
});
