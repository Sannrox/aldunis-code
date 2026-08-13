import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTONOMY_REFRESH_INTERVAL_MS,
  AutonomyLedgerSessionModule,
  type AutonomyLedger,
  type AutonomyLedgerSessionAdapters,
} from "./autonomy-ledger-session";

const ledger = (id = "run-1"): AutonomyLedger => ({
  runs: [
    {
      id,
      flowId: "maintenance-gardener.v1",
      kind: "maintenance",
      name: "Gardener",
      projectId: "project-1",
      status: "succeeded",
      trigger: "manual",
      goal: "Inspect",
      result: null,
      error: null,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      completedAt: "2026-08-11T00:00:00.000Z",
    },
  ],
  tasks: [],
  flows: [],
  heartbeatMonitors: [],
  standingOrders: [],
  hooks: [],
});

function harness(overrides: Partial<AutonomyLedgerSessionAdapters> = {}) {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | null = null;
  let timeout: (() => void) | null = null;
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const adapters: AutonomyLedgerSessionAdapters = {
    managed: false,
    visibility: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, listener) => {
        visibilityListener = listener;
      },
      removeEventListener: (_type, listener) => {
        if (visibilityListener === listener) visibilityListener = null;
      },
    },
    timers: {
      setTimeout: (handler, delay) => {
        assert.equal(delay, AUTONOMY_REFRESH_INTERVAL_MS);
        timeout = handler;
        return 1;
      },
      clearTimeout: () => {
        timeout = null;
      },
    },
    request: async (path, body) => {
      requests.push({ path, body });
      return path === "/api/autonomy/load" ? ledger() : {};
    },
    ...overrides,
  };
  return {
    adapters,
    requests,
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      visibilityListener?.();
    },
    tick() {
      const pending = timeout;
      timeout = null;
      pending?.();
    },
    hasTimer: () => timeout !== null,
    hasVisibilityListener: () => visibilityListener !== null,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("session owns visible polling and close cleanup", async () => {
  const testHarness = harness();
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({ projectId: "project-1", worktree: "/repo" });
  await settle();
  assert.equal(testHarness.requests.length, 1);
  assert.equal(testHarness.hasTimer(), true);
  assert.equal(session.getSnapshot().draft.projectId, "project-1");

  testHarness.tick();
  await settle();
  assert.equal(testHarness.requests.length, 2);
  testHarness.setVisibility("hidden");
  assert.equal(testHarness.hasTimer(), false);

  session.close();
  assert.equal(testHarness.hasVisibilityListener(), false);
});

test("visibility restart cannot retain an in-flight poll timer", async () => {
  const testHarness = harness();
  let releaseLoad: ((value: AutonomyLedger) => void) | null = null;
  testHarness.adapters.request = async () =>
    new Promise<AutonomyLedger>((resolve) => {
      releaseLoad = resolve;
    });
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({ projectId: "project-1" });
  testHarness.setVisibility("hidden");
  testHarness.setVisibility("visible");
  releaseLoad!(ledger());
  await settle();

  assert.equal(testHarness.hasTimer(), true);
  testHarness.setVisibility("hidden");
  assert.equal(testHarness.hasTimer(), false);
  session.close();
});

test("mutation forces a post-mutation load after an active poll", async () => {
  const testHarness = harness();
  let releaseFirstLoad: ((value: AutonomyLedger) => void) | null = null;
  let loadCount = 0;
  testHarness.adapters.request = async (path, body) => {
    testHarness.requests.push({ path, body });
    if (path !== "/api/autonomy/load") return {};
    loadCount += 1;
    if (loadCount === 1) {
      return new Promise<AutonomyLedger>((resolve) => {
        releaseFirstLoad = resolve;
      });
    }
    return ledger("fresh-run");
  };
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({ projectId: "project-1", worktree: "/repo" });
  const mutation = session.command({ kind: "cancel_run", runId: "run-1" });
  await Promise.resolve();
  assert.deepEqual(
    testHarness.requests.map((request) => request.path),
    ["/api/autonomy/load", "/api/autonomy/runs/cancel"],
  );
  releaseFirstLoad!(ledger("stale-run"));
  await mutation;
  assert.deepEqual(
    testHarness.requests.map((request) => request.path),
    ["/api/autonomy/load", "/api/autonomy/runs/cancel", "/api/autonomy/load"],
  );
  assert.equal(session.getSnapshot().ledger.runs[0]?.id, "fresh-run");
});

test("managed mode rejects mutation before crossing the host adapter", async () => {
  const testHarness = harness({ managed: true });
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({});
  await settle();
  testHarness.requests.length = 0;
  await session.command({ kind: "create_hook" });
  assert.equal(testHarness.requests.length, 0);
  assert.match(session.getSnapshot().error ?? "", /inspect-only/);
});

test("typed gardener command uses bound draft and validates missing projects", async () => {
  const testHarness = harness();
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({});
  await settle();
  testHarness.requests.length = 0;
  await session.command({ kind: "start_gardener" });
  assert.equal(testHarness.requests.length, 0);
  assert.match(session.getSnapshot().error ?? "", /Open a repository/);

  session.updateDraft({ projectId: "project-1", worktree: "/repo", goal: "Inspect safely" });
  await session.command({ kind: "start_gardener" });
  assert.equal(testHarness.requests[0]?.path, "/api/autonomy/gardener/start");
  assert.deepEqual(testHarness.requests[0]?.body, {
    projectId: "project-1",
    worktree: "/repo",
    goal: "Inspect safely",
  });
});

test("close suppresses stale load completion and reopen resets busy", async () => {
  const testHarness = harness();
  let releaseLoad: ((value: AutonomyLedger) => void) | null = null;
  testHarness.adapters.request = async (path) => {
    if (path === "/api/autonomy/load") {
      return new Promise<AutonomyLedger>((resolve) => {
        releaseLoad = resolve;
      });
    }
    return new Promise(() => undefined);
  };
  const session = new AutonomyLedgerSessionModule(testHarness.adapters);
  session.open({ projectId: "project-1" });
  void session.command({ kind: "cancel_run", runId: "run-1" });
  assert.equal(session.getSnapshot().busy, true);
  session.close();
  releaseLoad!(ledger("stale"));
  await settle();
  session.open({});
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.getSnapshot().ledger.runs.length, 0);
  session.close();
});
