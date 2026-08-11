import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleCheckpointRoute } from "./checkpoint-routes.ts";
import { RepositoryError } from "./repository.ts";
import type { StateProjection, TurnCheckpoint } from "./state.ts";

const response = {} as ServerResponse;
const checkpointId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const threadId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function checkpoint(overrides: Partial<TurnCheckpoint> = {}): TurnCheckpoint {
  return {
    schemaVersion: 2,
    id: checkpointId,
    turnId: "turn-1",
    threadId,
    worktree: "/repo/wt",
    gitDirectory: "/repo/.git",
    baselineHead: "head",
    baselineIdentity: "baseline",
    baselineIndexIdentity: "baseline-index",
    completedIdentity: "completed",
    completedIndexIdentity: "completed-index",
    completedHead: "head",
    state: "completed",
    message: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function projection(item = checkpoint()): StateProjection {
  return {
    checkpoints: [item],
    threads: [{ id: threadId, projectId: "project-1" }],
  } as StateProjection;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      inspect: async () => projection(),
      saveCheckpoint: async (item: TurnCheckpoint) => item,
    },
    activeProjects: new Set<string>(),
    activeWorktrees: new Set<string>(),
    worktreeKey: (projectId: string, worktree: string) => `${projectId}:${worktree}`,
    selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
    readJson: async () => ({ root: "/repo", worktree: "/repo/wt" }),
    sendJson: () => assert.fail("response must not be written"),
    operations: {},
    ...overrides,
  };
}

test("checkpoint module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleCheckpointRoute(
      "/api/provider/capabilities",
      request(),
      response,
      context() as never,
    ),
    false,
  );
});

test("checkpoint module previews the selected checkpoint through one interface", async () => {
  const writes: unknown[] = [];
  const files = [
    {
      path: "src/main.ts",
      state: "modified" as const,
      previousPath: null,
      additions: 2,
      deletions: 1,
    },
  ];
  assert.equal(
    await handleCheckpointRoute(
      `/api/checkpoints/${checkpointId}/preview`,
      request(),
      response,
      context({
        operations: {
          captureCheckpoint: async () => ({
            identity: "completed",
            indexIdentity: "completed-index",
            head: "head",
            gitDirectory: "/repo/.git",
          }),
          checkpointDiff: async () => files,
        },
        sendJson: (_response: ServerResponse, status: number, value: unknown) =>
          writes.push({ status, value }),
      }) as never,
    ),
    true,
  );
  assert.deepEqual(writes, [
    {
      status: 200,
      value: {
        checkpoint: checkpoint(),
        currentIdentity: "completed",
        currentIndexIdentity: "completed-index",
        files,
      },
    },
  ]);
});

test("checkpoint module rejects preview after the workspace changes", async () => {
  await assert.rejects(
    handleCheckpointRoute(
      `/api/checkpoints/${checkpointId}/preview`,
      request(),
      response,
      context({
        operations: {
          captureCheckpoint: async () => ({
            identity: "changed",
            indexIdentity: "completed-index",
            head: "head",
            gitDirectory: "/repo/.git",
          }),
        },
      }) as never,
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 409 &&
      error.message.includes("workspace changed"),
  );
});

test("checkpoint module reads a persisted checkpoint diff", async () => {
  const files = [
    {
      path: "src/main.ts",
      state: "modified" as const,
      previousPath: null,
      additions: 2,
      deletions: 1,
    },
  ];
  const writes: unknown[] = [];
  await handleCheckpointRoute(
    `/api/checkpoints/${checkpointId}/diff`,
    request(),
    response,
    context({
      state: {
        inspect: async () => projection(checkpoint({ files })),
        saveCheckpoint: async (item: TurnCheckpoint) => item,
      },
      readJson: async () => ({ root: "/repo", worktree: "/repo/wt", path: "src/main.ts" }),
      operations: {
        checkpointDiff: async () => assert.fail("persisted files must be reused"),
        readCheckpointFileDiff: async (
          worktree: string,
          baseline: string,
          completed: string,
          path: string,
          receivedFiles: unknown,
        ) => {
          assert.deepEqual(
            { worktree, baseline, completed, path, receivedFiles },
            {
              worktree: "/repo/wt",
              baseline: "baseline",
              completed: "completed",
              path: "src/main.ts",
              receivedFiles: files,
            },
          );
          return { path, patch: "diff" };
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(writes, [{ status: 200, value: { path: "src/main.ts", patch: "diff" } }]);
});

test("checkpoint module holds the worktree lock through rewind persistence", async () => {
  const activeWorktrees = new Set<string>();
  const observedLocks: boolean[] = [];
  const saved: TurnCheckpoint[] = [];
  const writes: unknown[] = [];
  await handleCheckpointRoute(
    `/api/checkpoints/${checkpointId}/rewind`,
    request(),
    response,
    context({
      activeWorktrees,
      readJson: async () => ({
        root: "/repo",
        worktree: "/repo/wt",
        currentIdentity: "completed",
        currentIndexIdentity: "completed-index",
        confirm: true,
      }),
      state: {
        inspect: async () => projection(),
        saveCheckpoint: async (item: TurnCheckpoint) => {
          observedLocks.push(activeWorktrees.has("project-1:/repo/wt"));
          saved.push(item);
          return item;
        },
      },
      operations: {
        rewindCheckpoint: async () => {
          observedLocks.push(activeWorktrees.has("project-1:/repo/wt"));
          return [];
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(observedLocks, [true, true]);
  assert.equal(activeWorktrees.size, 0);
  assert.equal(saved[0]?.state, "superseded");
  assert.deepEqual(writes, [{ status: 200, value: { status: "rewound", files: [] } }]);
});

test("checkpoint module releases the worktree lock when rewind fails", async () => {
  const activeWorktrees = new Set<string>();
  await assert.rejects(
    handleCheckpointRoute(
      `/api/checkpoints/${checkpointId}/rewind`,
      request(),
      response,
      context({
        activeWorktrees,
        readJson: async () => ({
          root: "/repo",
          worktree: "/repo/wt",
          currentIdentity: "completed",
          currentIndexIdentity: "completed-index",
          confirm: true,
        }),
        operations: {
          rewindCheckpoint: async () => {
            throw new Error("rewind failed");
          },
        },
      }) as never,
    ),
    /rewind failed/,
  );
  assert.equal(activeWorktrees.size, 0);
});
