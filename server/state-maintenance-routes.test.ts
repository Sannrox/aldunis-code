import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleStateMaintenanceRoute } from "./state-maintenance-routes.ts";
import { LocalStateError, type StateProjection } from "./state.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function projection(): StateProjection {
  return {
    projects: [
      { id: "p1", root: "/alpha" },
      { id: "p2", root: "/beta" },
    ],
    threads: [
      { id: "t1", projectId: "p1", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "t2", projectId: "p2", updatedAt: "2026-02-01T00:00:00.000Z" },
      { id: "t3", projectId: "p1", updatedAt: "2026-08-01T00:00:00.000Z" },
    ],
    checkpoints: [
      { id: "c1", threadId: "t1", gitDirectory: "/alpha/.git", state: "available" },
      { id: "c2", threadId: "t2", state: "available" },
      { id: "c3", threadId: "t3", gitDirectory: "/alpha/.git", state: "available" },
    ],
  } as StateProjection;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      inspect: unused,
      saveCheckpoint: unused,
      deleteProject: unused,
      enforceRetention: unused,
    },
    managed: false,
    activeProjects: new Set<string>(),
    activeWorktrees: new Set<string>(),
    assertManagedProject: () => assert.fail("managed admission must not run"),
    withLock: async <T>(action: () => Promise<T>) => action(),
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    deleteCheckpointReferences: unused,
    ...overrides,
  };
}

test("state maintenance module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleStateMaintenanceRoute("/api/state/load", request, response, context() as never),
    false,
  );
});

test("project deletion admits managed scope and preserves cleanup ordering", async () => {
  const calls: string[] = [];
  const activeProjects = new Set<string>();
  await handleStateMaintenanceRoute(
    "/api/state/projects/delete",
    request,
    response,
    context({
      managed: true,
      activeProjects,
      readJson: async () => ({ projectId: "p1" }),
      assertManagedProject: (_projection: StateProjection, projectId: string) => {
        assert.equal(projectId, "p1");
        calls.push("admit");
      },
      state: {
        inspect: async () => projection(),
        saveCheckpoint: async (checkpoint: { id: string; state: string; message?: string }) => {
          assert.equal(activeProjects.has("p1"), true);
          assert.equal(checkpoint.state, "unavailable");
          assert.equal(checkpoint.message, "Checkpoint cleanup is pending project deletion.");
          calls.push(`invalidate:${checkpoint.id}`);
        },
        deleteProject: async (projectId: string) => {
          assert.equal(activeProjects.has("p1"), true);
          calls.push(`delete:${projectId}`);
        },
        enforceRetention: unused,
      },
      deleteCheckpointReferences: async (gitDirectory: string, checkpointId: string) => {
        calls.push(`refs:${gitDirectory}:${checkpointId}`);
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { status: "deleted" });
        calls.push("respond");
      },
    }) as never,
  );
  assert.deepEqual(calls, [
    "admit",
    "invalidate:c1",
    "invalidate:c3",
    "refs:/alpha/.git:c1",
    "refs:/alpha/.git:c3",
    "delete:p1",
    "respond",
  ]);
  assert.deepEqual([...activeProjects], []);
});

test("project deletion rejects active worktrees before mutation", async () => {
  await assert.rejects(
    handleStateMaintenanceRoute(
      "/api/state/projects/delete",
      request,
      response,
      context({
        readJson: async () => ({ projectId: "p1" }),
        activeWorktrees: new Set([JSON.stringify(["p1", "/alpha/worktree"])]),
        state: { inspect: async () => projection() },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
});

test("project deletion releases exclusion state when checkpoint cleanup fails", async () => {
  const activeProjects = new Set<string>();
  await assert.rejects(
    handleStateMaintenanceRoute(
      "/api/state/projects/delete",
      request,
      response,
      context({
        activeProjects,
        readJson: async () => ({ projectId: "p1" }),
        state: {
          inspect: async () => projection(),
          saveCheckpoint: async () => undefined,
          deleteProject: () => assert.fail("project must not be deleted after cleanup failure"),
          enforceRetention: unused,
        },
        deleteCheckpointReferences: async () => {
          throw new Error("git cleanup failed");
        },
      }) as never,
    ),
    /git cleanup failed/,
  );
  assert.deepEqual([...activeProjects], []);
});

test("retention invalidates all expired checkpoints before compacting", async () => {
  const calls: string[] = [];
  const activeProjects = new Set<string>();
  await handleStateMaintenanceRoute(
    "/api/state/retention",
    request,
    response,
    context({
      activeProjects,
      readJson: async () => ({ olderThan: "2026-03-01T00:00:00.000Z" }),
      state: {
        inspect: async () => projection(),
        saveCheckpoint: async (checkpoint: { id: string; state: string; message?: string }) => {
          assert.deepEqual([...activeProjects].sort(), ["p1", "p2"]);
          assert.equal(checkpoint.state, "unavailable");
          assert.equal(checkpoint.message, "Checkpoint cleanup is pending retention.");
          calls.push(`invalidate:${checkpoint.id}`);
        },
        deleteProject: unused,
        enforceRetention: async (cutoff: Date) => {
          assert.equal(cutoff.toISOString(), "2026-03-01T00:00:00.000Z");
          calls.push("compact");
        },
      },
      deleteCheckpointReferences: async (gitDirectory: string, checkpointId: string) => {
        calls.push(`refs:${gitDirectory}:${checkpointId}`);
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { status: "compacted" });
        calls.push("respond");
      },
    }) as never,
  );
  assert.deepEqual(calls, [
    "invalidate:c1",
    "invalidate:c2",
    "refs:/alpha/.git:c1",
    "compact",
    "respond",
  ]);
  assert.deepEqual([...activeProjects], []);
});

test("retention rejects managed mode and invalid cutoffs", async () => {
  await assert.rejects(
    handleStateMaintenanceRoute(
      "/api/state/retention",
      request,
      response,
      context({ managed: true }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
  await assert.rejects(
    handleStateMaintenanceRoute(
      "/api/state/retention",
      request,
      response,
      context({ readJson: async () => ({ olderThan: "not-a-date" }) }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
});

test("retention releases every affected project when persistence fails", async () => {
  const activeProjects = new Set<string>();
  await assert.rejects(
    handleStateMaintenanceRoute(
      "/api/state/retention",
      request,
      response,
      context({
        activeProjects,
        readJson: async () => ({ olderThan: "2026-03-01T00:00:00.000Z" }),
        state: {
          inspect: async () => projection(),
          saveCheckpoint: async () => undefined,
          deleteProject: unused,
          enforceRetention: async () => {
            throw new Error("retention failed");
          },
        },
        deleteCheckpointReferences: async () => undefined,
      }) as never,
    ),
    /retention failed/,
  );
  assert.deepEqual([...activeProjects], []);
});
