import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreviousWorktreeSeed } from "./previous-worktree";

test("previous worktree prefers latest non-current, non-archived path in the project", () => {
  const seed = resolvePreviousWorktreeSeed({
    projectId: "p1",
    currentWorktreePath: "/repo",
    conversations: [
      {
        projectId: "p1",
        worktree: "/repo/.aldunis/wt/old",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        projectId: "p1",
        worktree: "/repo/.aldunis/wt/new",
        updatedAt: "2026-04-03T00:00:00.000Z",
      },
      {
        projectId: "p1",
        worktree: "/repo",
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
      {
        projectId: "p2",
        worktree: "/other/.aldunis/wt/x",
        updatedAt: "2026-04-05T00:00:00.000Z",
      },
      {
        projectId: "p1",
        worktree: "/repo/.aldunis/wt/archived",
        updatedAt: "2026-04-06T00:00:00.000Z",
        archivedAt: "2026-04-06T01:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(seed, {
    worktreePath: "/repo/.aldunis/wt/new",
    updatedAt: "2026-04-03T00:00:00.000Z",
  });
});

test("previous worktree is null without project, peers, or alternatives", () => {
  assert.equal(
    resolvePreviousWorktreeSeed({
      projectId: null,
      currentWorktreePath: "/repo",
      conversations: [],
    }),
    null,
  );
  assert.equal(
    resolvePreviousWorktreeSeed({
      projectId: "p1",
      currentWorktreePath: "/repo",
      conversations: [
        { projectId: "p1", worktree: "/repo", updatedAt: "2026-04-01T00:00:00.000Z" },
      ],
    }),
    null,
  );
});
