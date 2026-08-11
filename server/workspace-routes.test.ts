import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { RepositoryError } from "./repository.ts";
import { handleWorkspaceRoute } from "./workspace-routes.ts";

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function response(): ServerResponse {
  const value = new EventEmitter() as ServerResponse;
  Object.defineProperty(value, "writableEnded", { value: false, writable: true });
  return value;
}

const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { inspect: unused, saveProject: unused },
    preferences: { load: unused },
    worktrees: {
      list: unused,
      previewCreate: unused,
      create: unused,
      creationPlan: () => assert.fail("dependency must not be called"),
      previewRemove: unused,
      removalPlan: () => assert.fail("dependency must not be called"),
      remove: unused,
      discardPlan: () => assert.fail("dependency must not be called"),
    },
    directories: { browse: unused },
    activeProjects: new Set<string>(),
    remoteRequest: false,
    remoteHost: false,
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    operations: {},
    ...overrides,
  };
}

test("workspace module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleWorkspaceRoute("/api/state/load", request(), response(), context() as never),
    false,
  );
});

test("workspace module denies remote directory browsing before reading local input", async () => {
  await assert.rejects(
    handleWorkspaceRoute(
      "/api/directories/browse",
      request(),
      response(),
      context({ remoteHost: true }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 403,
  );
});

test("workspace module registers an opened repository through its dispatch interface", async () => {
  const writes: unknown[] = [];
  const saved: unknown[] = [];
  const opened = {
    name: "repo",
    root: "/canonical/repo",
    selectedWorktree: "/canonical/repo",
    defaultBranch: "main",
    worktrees: [],
  };
  assert.equal(
    await handleWorkspaceRoute(
      "/api/repositories/open",
      request(),
      response(),
      context({
        readJson: async () => ({ path: "/repo" }),
        state: {
          inspect: async () => ({ projects: [] }),
          saveProject: async (project: unknown) => {
            saved.push(project);
            return project;
          },
        },
        worktrees: { list: async () => [{ path: "/canonical/repo" }] },
        operations: {
          openRepository: async () => ({ ...opened }),
          repositoryCommonDir: async () => "/git",
          randomUUID: () => "project-1",
        },
        sendJson: (_response: ServerResponse, status: number, value: unknown) =>
          writes.push({ status, value }),
      }) as never,
    ),
    true,
  );
  assert.deepEqual(saved, [{ id: "project-1", name: "repo", root: "/canonical/repo" }]);
  assert.deepEqual(writes, [
    {
      status: 200,
      value: {
        ...opened,
        worktrees: [{ path: "/canonical/repo" }],
        projectId: "project-1",
      },
    },
  ]);
});

test("workspace module preserves repository identity across worktree paths", async () => {
  const saved: unknown[] = [];
  await handleWorkspaceRoute(
    "/api/repositories/open",
    request(),
    response(),
    context({
      readJson: async () => ({ path: "/repo/worktree" }),
      state: {
        inspect: async () => ({
          projects: [{ id: "existing", name: "repo", root: "/repo", openedAt: "2026-01-01" }],
        }),
        saveProject: async (project: unknown) => {
          saved.push(project);
          return project;
        },
      },
      worktrees: { list: async () => [] },
      operations: {
        openRepository: async () => ({
          name: "repo",
          root: "/repo/worktree",
          selectedWorktree: "/repo/worktree",
          defaultBranch: "main",
          worktrees: [],
        }),
        repositoryCommonDir: async () => "/repo/.git",
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.deepEqual(saved, [
    {
      id: "existing",
      name: "repo",
      root: "/repo/worktree",
      openedAt: "2026-01-01",
    },
  ]);
});

test("workspace module forwards the managed worktree limit into create preview", async () => {
  const previews: unknown[] = [];
  await handleWorkspaceRoute(
    "/api/worktrees/create/preview",
    request(),
    response(),
    context({
      readJson: async () => ({ root: "/repo", base: "main", branch: "codex/task" }),
      preferences: { load: async () => ({ preferences: { managedWorktreeLimit: 7 } }) },
      worktrees: {
        previewCreate: async (input: unknown) => {
          previews.push(input);
          return { id: "plan" };
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.deepEqual(previews, [
    { repository: "/repo", base: "main", branch: "codex/task", limit: 7 },
  ]);
});

test("workspace module rejects removal while a conversation owns the worktree", async () => {
  await assert.rejects(
    handleWorkspaceRoute(
      "/api/worktrees/remove/preview",
      request(),
      response(),
      context({
        readJson: async () => ({ root: "/repo", path: "/repo/wt" }),
        selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
        state: { inspect: async () => ({ threads: [{ worktree: "/repo/wt" }] }) },
      }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 409,
  );
});

test("workspace module always discards a removal plan when an active operation blocks it", async () => {
  const discarded: string[] = [];
  await assert.rejects(
    handleWorkspaceRoute(
      "/api/worktrees/remove",
      request(),
      response(),
      context({
        readJson: async () => ({ planId: "plan-1", confirm: true }),
        state: {
          inspect: async () => ({ projects: [{ id: "project-1", root: "/repo" }] }),
        },
        activeProjects: new Set(["project-1"]),
        worktrees: {
          removalPlan: () => ({ repository: "/repo", path: "/repo/wt" }),
          discardPlan: (planId: string) => discarded.push(planId),
        },
      }) as never,
    ),
    (error: unknown) => error instanceof Error && error.message.includes("active conversation"),
  );
  assert.deepEqual(discarded, ["plan-1"]);
});
