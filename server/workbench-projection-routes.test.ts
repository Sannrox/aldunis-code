import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  filterManagedOrchestrationProjection,
  filterManagedUsageReceipts,
  filterManagedWorkbenchListProjection,
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

test("managed usage filtering traverses only usage-scoped state", () => {
  const value = projection();
  value.turns.push({
    schemaVersion: 2,
    id: "turn-hidden",
    threadId: "hidden",
    status: "completed",
    mode: "build",
    createdAt: "t0",
    completedAt: "t1",
  });
  value.usageReceipts.push(
    {
      schemaVersion: 2,
      id: "usage-visible",
      threadId: "active",
      turnId: "turn-active",
      provider: "codex-cli",
      model: "gpt-5-codex",
      status: "completed",
      createdAt: "t0",
      updatedAt: "t1",
    },
    {
      schemaVersion: 2,
      id: "usage-hidden",
      threadId: "hidden",
      turnId: "turn-hidden",
      provider: "codex-cli",
      model: "gpt-5-codex",
      status: "completed",
      createdAt: "t0",
      updatedAt: "t1",
    },
    {
      schemaVersion: 2,
      id: "usage-missing-turn",
      threadId: "active",
      turnId: "missing",
      provider: "codex-cli",
      model: "gpt-5-codex",
      status: "completed",
      createdAt: "t0",
      updatedAt: "t1",
    },
  );

  const filtered = filterManagedUsageReceipts(
    {
      projects: value.projects,
      threads: value.threads,
      turns: value.turns,
      usageReceipts: value.usageReceipts,
    },
    {
      repositoryForRoot(root) {
        if (root !== "/alpha") throw new Error("not managed");
        return {} as never;
      },
    },
  );

  assert.deepEqual(
    filtered.map((receipt) => receipt.id),
    ["usage-visible"],
  );
});

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
  assert.deepEqual(
    (value?.threadStatuses as Array<{ threadId: string; status: string }>).map((item) => [
      item.threadId,
      item.status,
    ]),
    [
      ["active", "completed"],
      ["archived", "idle"],
      ["hidden", "idle"],
    ],
  );
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

test("managed orchestration projection skips unrelated durable collections", () => {
  const value = projection();
  value.turns.push({
    schemaVersion: 2,
    id: "turn-hidden",
    threadId: "hidden",
    status: "completed",
    mode: "build",
    createdAt: "t0",
    completedAt: "t1",
  });
  value.messages.push({
    schemaVersion: 2,
    id: "message-hidden",
    turnId: "turn-hidden",
    role: "assistant",
    text: "hidden content",
    createdAt: "t0",
  });
  value.plans = [{}] as StateProjection["plans"];
  value.contextReceipts = [{}] as StateProjection["contextReceipts"];
  value.usageReceipts = [{}] as StateProjection["usageReceipts"];
  value.governanceCorrelations = [{}] as StateProjection["governanceCorrelations"];
  value.checkpoints = [{}] as StateProjection["checkpoints"];
  value.annotations = [{}] as StateProjection["annotations"];
  value.fileReviews = [{}] as StateProjection["fileReviews"];
  value.inputReceipts = [{}] as StateProjection["inputReceipts"];
  value.autonomyRuns = [{}] as StateProjection["autonomyRuns"];

  const filtered = filterManagedOrchestrationProjection(value, {
    repositoryForRoot(root) {
      if (root !== "/alpha") throw new Error("outside catalogue");
      return {} as never;
    },
  });

  assert.deepEqual(
    filtered.turns.map((turn) => turn.id),
    ["turn-active"],
  );
  assert.deepEqual(
    filtered.messages.map((message) => message.id),
    ["message"],
  );
  assert.deepEqual(filtered.plans, []);
  assert.deepEqual(filtered.contextReceipts, []);
  assert.deepEqual(filtered.usageReceipts, []);
  assert.deepEqual(filtered.governanceCorrelations, []);
  assert.deepEqual(filtered.checkpoints, []);
  assert.deepEqual(filtered.annotations, []);
  assert.deepEqual(filtered.fileReviews, []);
  assert.deepEqual(filtered.inputReceipts, []);
  assert.deepEqual(filtered.autonomyRuns, []);
});

function forbiddenLoadTurns(turns: StateProjection["turns"]): StateProjection["turns"] {
  return new Proxy(turns, {
    get(target, property, receiver) {
      if (
        property === Symbol.iterator ||
        property === "filter" ||
        property === "map" ||
        property === "flatMap" ||
        property === "forEach" ||
        property === "find"
      ) {
        throw new Error(`scanned turns via ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("Workbench load uses the turn index instead of scanning inspect().turns", async () => {
  const current = projection();
  const foreign = Array.from({ length: 200 }, (_, index) => ({
    schemaVersion: 2 as const,
    id: `foreign-${index}`,
    threadId: "other",
    status: "completed" as const,
    mode: "build" as const,
    createdAt: "t0",
    completedAt: "t1",
  }));
  current.turns = [...current.turns, ...foreign];
  const inspected = new Proxy(current, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (property === "turns") {
        throw new Error("workbench load scanned projection.turns");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const turnsByThread = new Map([
    ["active", [projection().turns[0]]],
    ["other", foreign],
  ]);
  let value: Record<string, unknown> | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/load",
    request,
    response,
    context({
      preferences: {
        load: async () => ({
          preferences: { orchestrationThreadsBeta: false, managedWorktreeLimit: 7 },
        }),
      },
      state: {
        inspect: async () => inspected,
        turnsByThreadIndex: async () => turnsByThread,
      },
      worktrees: {
        countActiveManaged: async () => 0,
        listActiveManagedPaths: async () => [],
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        value = body as Record<string, unknown>;
      },
    }) as never,
  );
  assert.deepEqual(
    (value?.threadStatuses as Array<{ threadId: string; status: string }>).map((item) => [
      item.threadId,
      item.status,
    ]),
    [
      ["active", "completed"],
      ["archived", "idle"],
      ["hidden", "idle"],
    ],
  );
});

test("managed list projection uses the turn index instead of scanning all turns", () => {
  const value = projection();
  const hiddenTurn = {
    schemaVersion: 2 as const,
    id: "turn-hidden",
    threadId: "hidden",
    status: "completed" as const,
    mode: "build" as const,
    createdAt: "t0",
    completedAt: "t1",
  };
  value.turns = forbiddenLoadTurns([...value.turns, hiddenTurn]);
  const filtered = filterManagedWorkbenchListProjection(
    value,
    {
      repositoryForRoot(root) {
        if (root !== "/alpha") throw new Error("outside catalogue");
        return {} as never;
      },
    },
    new Map([
      ["active", [projection().turns[0]]],
      ["hidden", [hiddenTurn]],
    ]),
  );
  assert.deepEqual(
    filtered.turns.map((turn) => turn.id),
    ["turn-active"],
  );
});

test("managed list projection skips transcript and durable-history filtering", () => {
  const value = projection();
  value.autonomyRuns = [{ id: "run", projectId: "p1" }] as StateProjection["autonomyRuns"];
  const filtered = filterManagedWorkbenchListProjection(value, {
    repositoryForRoot(root) {
      if (root !== "/alpha") throw new Error("outside catalogue");
      return {} as never;
    },
  });

  assert.deepEqual(
    filtered.projects.map((project) => project.id),
    ["p1"],
  );
  assert.deepEqual(
    filtered.threads.map((thread) => thread.id),
    ["active", "archived"],
  );
  assert.deepEqual(
    filtered.turns.map((turn) => turn.id),
    ["turn-active"],
  );
  assert.deepEqual(filtered.messages, []);
  assert.deepEqual(filtered.autonomyRuns, []);
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

test("history uses one atomic thread index without traversing global collections", async () => {
  const current = projection();
  const [thread] = current.threads;
  const [turn] = current.turns;
  const [message] = current.messages;
  assert.ok(thread && turn && message);
  const forbidden = new Proxy([], {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (property === "length") return 100_000;
      if (property === Symbol.iterator || property === "find" || property === "filter") {
        throw new Error("history traversed a global collection");
      }
      return Reflect.get(target, property, receiver);
    },
  }) as never[];
  const inspected = {
    ...current,
    turns: forbidden,
    messages: forbidden,
    activities: forbidden,
    plans: forbidden,
    contextReceipts: forbidden,
    inputRequests: forbidden,
    providerSessions: forbidden,
    governanceCorrelations: forbidden,
    checkpoints: forbidden,
  } as StateProjection;
  const conversationHistory = {
    threadById: new Map([[thread.id, thread]]),
    turnsByThread: new Map([[thread.id, [turn]]]),
    messagesByThread: new Map([[thread.id, [message]]]),
    activitiesByThread: new Map(),
    plansByThread: new Map(),
    contextReceiptsByThread: new Map(),
    inputRequestsByThread: new Map(),
    providerSessionsByThread: new Map(),
    governanceCorrelationsByThread: new Map(),
    checkpointsByThread: new Map(),
  };
  let value: Record<string, unknown> | undefined;
  await handleWorkbenchProjectionRoute(
    "/api/state/conversations/history",
    request,
    response,
    context({
      readJson: async () => ({ threadId: thread.id, knownSequence: 0 }),
      state: {
        inspect: async () => assert.fail("history should use the atomic indexed snapshot"),
        inspectWorkbenchProjection: async () => ({
          projection: inspected,
          turnsByThread: conversationHistory.turnsByThread,
          delegatedMessagesByTurn: new Map(),
          delegatedActivitiesByTurn: new Map(),
          conversationHistory,
        }),
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        value = body as Record<string, unknown>;
      },
    }) as never,
  );
  assert.deepEqual(
    (value?.turns as Array<{ id: string }>).map((row) => row.id),
    [turn.id],
  );
  assert.deepEqual(
    (value?.messages as Array<{ id: string }>).map((row) => row.id),
    [message.id],
  );
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
