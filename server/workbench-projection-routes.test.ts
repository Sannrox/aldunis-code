import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  filterManagedProjection,
  handleWorkbenchProjectionRoute,
} from "./workbench-projection-routes.ts";
import { LocalStateError, type StateProjection } from "./state.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function projection(): StateProjection {
  return {
    schemaVersion: 2,
    sequence: 1,
    projects: [
      { schemaVersion: 2, id: "p1", name: "Alpha", root: "/alpha", openedAt: "t0" },
      { schemaVersion: 2, id: "p2", name: "Hidden", root: "/hidden", openedAt: "t0" },
    ],
    threads: [
      {
        schemaVersion: 2,
        id: "active",
        projectId: "p1",
        worktree: "/alpha",
        workspaceMode: "shared",
        title: "Active work",
        provider: "claude-code",
        createdAt: "t0",
        updatedAt: "t2",
      },
      {
        schemaVersion: 2,
        id: "archived",
        projectId: "p1",
        worktree: "/alpha/archive",
        workspaceMode: "shared",
        title: "Archived work",
        provider: "codex-cli",
        createdAt: "t0",
        updatedAt: "t1",
        archivedAt: "t2",
      },
      {
        schemaVersion: 2,
        id: "hidden",
        projectId: "p2",
        worktree: "/hidden",
        workspaceMode: "shared",
        title: "Hidden work",
        provider: "claude-code",
        createdAt: "t0",
        updatedAt: "t3",
      },
    ],
    turns: [
      {
        schemaVersion: 2,
        id: "turn-active",
        threadId: "active",
        status: "completed",
        mode: "build",
        createdAt: "t0",
        completedAt: "t1",
      },
    ],
    messages: [
      {
        schemaVersion: 2,
        id: "message",
        turnId: "turn-active",
        role: "user",
        text: "local content",
        createdAt: "t0",
      },
    ],
    activities: [],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    governanceCorrelations: [],
    providerSessions: [],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [],
    inputRequests: [],
    inputReceipts: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { inspect: unused },
    preferences: { load: unused },
    permissions: { approvals: () => [] },
    worktrees: { countActiveManaged: unused, listActiveManagedPaths: unused },
    assertManagedThread: () => assert.fail("managed admission must not run"),
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    sendStatus: () => assert.fail("status response must not be written"),
    ...overrides,
  };
}

test("Workbench projection module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleWorkbenchProjectionRoute(
      "/api/preferences/load",
      request,
      response,
      context() as never,
    ),
    false,
  );
});

test("Workbench load derives one bounded response from the inspected snapshot", async () => {
  const calls: string[] = [];
  let value: Record<string, unknown> | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/load",
    request,
    response,
    context({
      preferences: {
        load: async () => {
          calls.push("preferences");
          return {
            preferences: { orchestrationThreadsBeta: false, managedWorktreeLimit: 7 },
          };
        },
      },
      state: {
        inspect: async () => {
          calls.push("inspect");
          return projection();
        },
      },
      worktrees: {
        countActiveManaged: async () => 2,
        listActiveManagedPaths: async () => ["/alpha/one", "/alpha/two"],
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        value = body as Record<string, unknown>;
      },
    }) as never,
  );
  assert.deepEqual(calls, ["preferences", "inspect"]);
  assert.equal((value?.messages as unknown[]).length, 0);
  assert.deepEqual(value?.delegatedRelationships, []);
  assert.equal(value?.managedWorktreeCount, 2);
  assert.equal(value?.managedWorktreeLimit, 7);
});

test("managed Workbench load filters projects and approvals through catalogue authority", async () => {
  let value: Record<string, unknown> | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/load",
    request,
    response,
    context({
      preferences: {
        load: async () => ({
          preferences: { orchestrationThreadsBeta: true, managedWorktreeLimit: 10 },
        }),
      },
      state: { inspect: async () => projection() },
      managedHost: {
        repositoryForRoot: (root: string) => {
          if (!root.startsWith("/alpha")) throw new Error("outside catalogue");
          return {};
        },
      },
      permissions: {
        approvals: () => [
          { repository: "/hidden", conversationId: "hidden" },
          { repository: "/alpha", conversationId: "active" },
        ],
      },
      worktrees: { countActiveManaged: async () => 0, listActiveManagedPaths: async () => [] },
      sendJson: (_response: ServerResponse, _status: number, body: unknown) => {
        value = body as Record<string, unknown>;
      },
    }) as never,
  );
  assert.deepEqual(
    (value?.projects as Array<{ id: string }>).map((project) => project.id),
    ["p1"],
  );
  assert.equal((value?.threads as unknown[]).length, 2);
  assert.deepEqual(value?.delegatedApprovals, []);
});

test("managed projection derives task visibility from one filtered run index", () => {
  const value = projection();
  value.autonomyRuns = [
    { id: "visible", projectId: "p1" },
    { id: "global", projectId: null },
    { id: "hidden", projectId: "p2" },
  ] as StateProjection["autonomyRuns"];
  value.autonomyTasks = [
    { id: "visible-task", runId: "visible" },
    { id: "global-task", runId: "global" },
    { id: "hidden-task", runId: "hidden" },
    { id: "orphan-task", runId: "missing" },
  ] as StateProjection["autonomyTasks"];

  const filtered = filterManagedProjection(value, {
    repositoryForRoot(root) {
      if (root !== "/alpha") throw new Error("outside catalogue");
      return {} as never;
    },
  });

  assert.deepEqual(
    filtered.autonomyRuns.map((run) => run.id),
    ["visible", "global"],
  );
  assert.deepEqual(
    filtered.autonomyTasks.map((task) => task.id),
    ["visible-task", "global-task"],
  );
});

test("history validates identity and applies managed admission", async () => {
  await assert.rejects(
    handleWorkbenchProjectionRoute(
      "/api/state/conversations/history",
      request,
      response,
      context({ readJson: async () => ({}) }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
  let admitted = "";
  await handleWorkbenchProjectionRoute(
    "/api/state/conversations/history",
    request,
    response,
    context({
      readJson: async () => ({ threadId: "active" }),
      state: { inspect: async () => projection() },
      managedHost: { repositoryForRoot: () => ({}) },
      assertManagedThread: (_projection: StateProjection, threadId: string) => {
        admitted = threadId;
      },
      sendJson: (_response: ServerResponse, status: number) => assert.equal(status, 200),
    }) as never,
  );
  assert.equal(admitted, "active");
});

test("history rejects invalid sequences and skips unchanged transcript projection", async () => {
  await assert.rejects(
    handleWorkbenchProjectionRoute(
      "/api/state/conversations/history",
      request,
      response,
      context({
        readJson: async () => ({ threadId: "active", knownSequence: -1 }),
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );

  let status = 0;
  await handleWorkbenchProjectionRoute(
    "/api/state/conversations/history",
    request,
    response,
    context({
      readJson: async () => ({ threadId: "active", knownSequence: 1 }),
      state: { inspect: async () => projection() },
      sendStatus: (_response: ServerResponse, value: number) => {
        status = value;
      },
    }) as never,
  );
  assert.equal(status, 204);
});

test("history returns its sequence when the caller snapshot changed", async () => {
  let value: Record<string, unknown> | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/conversations/history",
    request,
    response,
    context({
      readJson: async () => ({ threadId: "active", knownSequence: 0 }),
      state: { inspect: async () => projection() },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        value = body as Record<string, unknown>;
      },
    }) as never,
  );
  assert.equal(value?.sequence, 1);
  assert.equal((value?.messages as unknown[]).length, 1);
});

test("search enforces archive scope and managed visibility", async () => {
  let value: { threads: Array<{ id: string }> } | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/search",
    request,
    response,
    context({
      readJson: async () => ({ query: "work", archived: "only" }),
      state: { inspect: async () => projection() },
      managedHost: {
        repositoryForRoot: (root: string) => {
          if (root !== "/alpha") throw new Error("outside catalogue");
          return {};
        },
      },
      sendJson: (_response: ServerResponse, _status: number, body: unknown) => {
        value = body as { threads: Array<{ id: string }> };
      },
    }) as never,
  );
  assert.deepEqual(
    value?.threads.map((thread) => thread.id),
    ["archived"],
  );
});

test("managed search does not traverse unrelated projection collections", async () => {
  const currentProjection = projection();
  const searchProjection = new Proxy(currentProjection, {
    get: (target, property, receiver) => {
      // Promise resolution probes `then` before returning the inspected object.
      if (property === "then") return undefined;
      if (property !== "projects" && property !== "threads") {
        throw new Error(`search traversed unrelated projection field ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  let value: { threads: Array<{ id: string }> } | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/search",
    request,
    response,
    context({
      readJson: async () => ({ query: "", archived: "include" }),
      state: { inspect: async () => searchProjection },
      managedHost: {
        repositoryForRoot: (root: string) => {
          if (root !== "/alpha") throw new Error("outside catalogue");
          return {};
        },
      },
      sendJson: (_response: ServerResponse, _status: number, body: unknown) => {
        value = body as { threads: Array<{ id: string }> };
      },
    }) as never,
  );
  assert.deepEqual(
    value?.threads.map((thread) => thread.id),
    ["active", "archived"],
  );
});
