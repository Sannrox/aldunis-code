import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  builtInAutonomyFlows,
  isHeartbeatDue,
  parseHeartbeatMonitor,
  parseStandingOrder,
  type AutonomyRun,
} from "./autonomy.ts";
import { AutonomyEngine, AutonomyScheduler } from "./autonomy-engine.ts";
import { LocalStateStore } from "./state.ts";

const execFileAsync = promisify(execFile);

async function git(worktree: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", worktree, ...args], { encoding: "utf8" });
}

async function fixture(): Promise<{
  root: string;
  state: LocalStateStore;
  engine: AutonomyEngine;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "aldunis-autonomy-repo-"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "aldunis-autonomy-state-"));
  await git(root, ["init", "-q"]);
  await writeFile(
    join(root, "README.md"),
    "# Fixture\n\nA bounded repository for autonomy tests.\n",
    "utf8",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
    "utf8",
  );
  await git(root, ["add", "README.md", "package.json"]);
  await git(root, [
    "-c",
    "user.email=tests@example.invalid",
    "-c",
    "user.name=Aldunis Tests",
    "commit",
    "-qm",
    "fixture",
  ]);
  const state = new LocalStateStore(stateDirectory);
  await state.saveProject({ id: "project-1", name: "fixture", root });
  const engine = new AutonomyEngine(state);
  return {
    root,
    state,
    engine,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(stateDirectory, { recursive: true, force: true });
    },
  };
}

async function waitForRun(state: LocalStateStore, runId: string): Promise<AutonomyRun> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const run = (await state.load()).autonomyRuns.find((candidate) => candidate.id === runId);
    if (run && ["succeeded", "failed", "cancelled", "lost"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Autonomy run did not reach a terminal state in time.");
}

test("autonomy records validate bounded durable configuration", () => {
  const monitor = parseHeartbeatMonitor({
    schemaVersion: 2,
    id: "heartbeat-1",
    name: "Awareness",
    projectId: null,
    worktree: null,
    goal: "Notice changes",
    enabled: true,
    everySeconds: 60,
    activeHours: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  });
  assert.equal(isHeartbeatDue(monitor, new Date("2026-08-03T00:00:00.000Z")), true);
  assert.throws(
    () =>
      parseStandingOrder({
        schemaVersion: 2,
        id: "order-1",
        name: "Invalid",
        scope: "project",
        projectId: null,
        instruction: "Needs a project",
        enabled: true,
        createdAt: "now",
        updatedAt: "now",
      }),
    /project/,
  );
});

test("Autonomy scheduler sleeps without work and preserves active deadlines", async () => {
  type Timer = { callback: () => void; delay: number; referenced: boolean; unref(): void };
  const timers = new Set<Timer>();
  let hasWork = false;
  let ticks = 0;
  const engine = {
    tickHeartbeats: async () => {
      ticks += 1;
    },
    dispatch: async () => [],
    hasScheduledWork: async () => hasWork,
  } as unknown as AutonomyEngine;
  const scheduler = new AutonomyScheduler(engine, {
    intervalMs: 30_000,
    timers: {
      setTimeout(callback, delay) {
        const timer: Timer = {
          callback,
          delay,
          referenced: true,
          unref() {
            this.referenced = false;
          },
        };
        timers.add(timer);
        return timer;
      },
      clearTimeout(handle) {
        timers.delete(handle as Timer);
      },
    },
  });

  scheduler.start();
  await scheduler.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ticks, 1);
  assert.equal(timers.size, 0);

  hasWork = true;
  await scheduler.refresh();
  assert.equal(timers.size, 1);
  const deadline = [...timers][0]!;
  assert.equal(deadline.delay, 30_000);
  assert.equal(deadline.referenced, false);
  await scheduler.refresh();
  assert.equal([...timers][0], deadline);

  timers.delete(deadline);
  deadline.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ticks, 2);
  assert.equal(timers.size, 1);

  hasWork = false;
  await scheduler.refresh();
  assert.equal(timers.size, 0);
  scheduler.stop();
});

test("Autonomy mutation refresh does not wait for a running workflow", async () => {
  let release!: () => void;
  const running = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = new AutonomyScheduler({
    tickHeartbeats: async () => running,
    dispatch: async () => [],
    hasScheduledWork: async () => true,
  } as unknown as AutonomyEngine);

  scheduler.start();
  await scheduler.refresh();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  scheduler.stop();
});

test("Autonomy scheduler retains a retry after transient reconciliation failure", async () => {
  let retries = 0;
  const timer = { unref: () => undefined };
  const scheduler = new AutonomyScheduler(
    {
      tickHeartbeats: async () => undefined,
      dispatch: async () => [],
      hasScheduledWork: async () => {
        throw new Error("temporary projection failure");
      },
    } as unknown as AutonomyEngine,
    {
      timers: {
        setTimeout: () => {
          retries += 1;
          return timer;
        },
        clearTimeout: () => undefined,
      },
    },
  );

  scheduler.start();
  await scheduler.refresh();
  assert.equal(retries, 1);
  scheduler.stop();
});

test("nightly gardener runs read-only, records tasks, and survives reload", async () => {
  const { root, state, engine, cleanup } = await fixture();
  try {
    await engine.ensureBuiltInFlows();
    const before = await readFile(join(root, "README.md"), "utf8");
    const run = await engine.startGardener({ projectId: "project-1" });
    const completed = await waitForRun(state, run.id);
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.flowId, "maintenance-gardener.v1");
    assert.ok(completed.result);
    assert.equal(completed.result?.changedFiles, 0);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
    const tasks = (await state.load()).autonomyTasks.filter((task) => task.runId === run.id);
    assert.deepEqual(
      tasks.map((task) => task.status),
      ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"],
    );
    const reloaded = await new LocalStateStore(state.directory).load();
    assert.equal(reloaded.autonomyRuns[0]?.id, run.id);
    assert.equal(reloaded.autonomyFlows.length, builtInAutonomyFlows().length);
  } finally {
    await cleanup();
  }
});

test("heartbeat and standing order records are durable state records", async () => {
  const { state, engine, cleanup } = await fixture();
  try {
    const heartbeat = await engine.addHeartbeat({
      name: "Hourly awareness",
      projectId: "project-1",
      goal: "Check repository signals",
      everySeconds: 3600,
    });
    assert.equal(heartbeat.flowId, "heartbeat-awareness.v1");
    const order = await engine.addStandingOrder({
      name: "Keep it small",
      scope: "project",
      projectId: "project-1",
      instruction: "Prefer bounded, reviewable maintenance suggestions.",
    });
    const snapshot = await new AutonomyEngine(new LocalStateStore(state.directory)).snapshot();
    assert.equal(snapshot.heartbeatMonitors[0]?.id, heartbeat.id);
    assert.equal(snapshot.standingOrders[0]?.id, order.id);
    assert.equal(snapshot.flows.length, builtInAutonomyFlows().length);
  } finally {
    await cleanup();
  }
});
