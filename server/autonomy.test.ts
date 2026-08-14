import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  builtInAutonomyFlows,
  isHeartbeatDue,
  MAX_AUTONOMY_CONFIGURATIONS_PER_KIND,
  NIGHTLY_GARDENER_FLOW_ID,
  parseAutonomyHook,
  parseHeartbeatMonitor,
  parseStandingOrder,
  type AutonomyRun,
} from "./autonomy.ts";
import {
  AutonomyEngine,
  AutonomyScheduler,
  listBoundedAutonomyTrackedFiles,
  readBoundedAutonomyTextFile,
} from "./autonomy-engine.ts";
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

test("Autonomy step timeout aborts and drains work before rejecting", async () => {
  const { engine, cleanup } = await fixture();
  let observedAbort = false;
  let drained = false;
  try {
    await assert.rejects(
      engine.withTimeout(
        (signal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                setImmediate(() => {
                  drained = true;
                  resolve();
                });
              },
              { once: true },
            );
          }),
        5,
      ),
      /timed out/,
    );
    assert.equal(observedAbort, true);
    assert.equal(drained, true);
  } finally {
    await cleanup();
  }
});

test("Autonomy retries cannot overlap a timed-out predecessor", async () => {
  const { engine, cleanup } = await fixture();
  let active = 0;
  let maximumActive = 0;
  const attempt = () =>
    engine.withTimeout(
      (signal) =>
        new Promise<void>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          signal.addEventListener(
            "abort",
            () => {
              setImmediate(() => {
                active -= 1;
                resolve();
              });
            },
            { once: true },
          );
        }),
      5,
    );
  try {
    await assert.rejects(attempt, /timed out/);
    await assert.rejects(attempt, /timed out/);
    assert.equal(maximumActive, 1);
    assert.equal(active, 0);
  } finally {
    await cleanup();
  }
});

test("Autonomy timeout remains finite when cancelled work does not drain", async () => {
  const { engine, cleanup } = await fixture();
  try {
    await assert.rejects(
      engine.withTimeout(() => new Promise<void>(() => undefined), 5, 5),
      /did not stop after cancellation/,
    );
  } finally {
    await cleanup();
  }
});

test("Autonomy does not retry a timed-out operation that fails to drain", async () => {
  const { state, engine, cleanup } = await fixture();
  let attempts = 0;
  try {
    await engine.ensureBuiltInFlows();
    const projection = await state.load();
    const gardener = projection.autonomyFlows.find((flow) => flow.id === NIGHTLY_GARDENER_FLOW_ID)!;
    await state.saveAutonomyRecords({
      flows: [
        {
          ...gardener,
          steps: [
            {
              ...gardener.steps[0]!,
              timeoutSeconds: 1,
              maxAttempts: 3,
            },
          ],
          budget: { ...gardener.budget, maxTasks: 1 },
        },
      ],
    });
    engine.executeStep = async () => {
      attempts += 1;
      return new Promise(() => undefined);
    };
    const run = await engine.startGardener({ projectId: "project-1" });
    const completed = await waitForRun(state, run.id);
    assert.equal(completed.status, "failed");
    assert.match(completed.error ?? "", /did not stop after cancellation/);
    assert.equal(attempts, 1);
    const task = (await state.load()).autonomyTasks.find((candidate) => candidate.runId === run.id);
    assert.equal(task?.attempt, 1);
  } finally {
    await cleanup();
  }
});

test("Autonomy repository scan rejects pre-aborted work before discovery", async () => {
  const { root, engine, cleanup } = await fixture();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(engine.scanRepository(root, controller.signal), {
      name: "AbortError",
    });
  } finally {
    await cleanup();
  }
});

test("Autonomy tracked inventory stops after its scan ceiling beyond 4 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-autonomy-large-index-"));
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "empty"), "");
    const { stdout: emptyBlob } = await execFileAsync(
      "git",
      ["-C", root, "hash-object", "-w", "empty"],
      { encoding: "utf8" },
    );
    const directory = "x".repeat(180);
    const paths = Array.from(
      { length: 25_000 },
      (_, index) => `corpus/${directory}/file-${String(index).padStart(5, "0")}.ts`,
    );
    assert.ok(Buffer.byteLength(`${paths.join("\0")}\0`) > 4 * 1024 * 1024);
    const indexInput = paths.map((path) => `100644 ${emptyBlob.trim()}\t${path}\n`).join("");
    const update = spawn("git", ["-C", root, "update-index", "--index-info"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    update.stderr.setEncoding("utf8");
    update.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    update.stdin.end(indexInput);
    const code = await new Promise<number | null>((resolve) => update.once("close", resolve));
    assert.equal(code, 0, stderr);

    const retained = await listBoundedAutonomyTrackedFiles(root);
    assert.deepEqual(retained, paths.slice(0, 200));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autonomy tracked inventory rejects an oversized complete path record", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-autonomy-long-index-path-"));
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "empty"), "");
    const { stdout: emptyBlob } = await execFileAsync(
      "git",
      ["-C", root, "hash-object", "-w", "empty"],
      { encoding: "utf8" },
    );
    const path = `${Array.from({ length: 300 }, () => "x".repeat(220)).join("/")}/file.ts`;
    assert.ok(Buffer.byteLength(path) > 64 * 1024);
    const update = spawn("git", ["-C", root, "update-index", "--index-info"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    update.stderr.setEncoding("utf8");
    update.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    update.stdin.end(`100644 ${emptyBlob.trim()}\t${path}\n`);
    const code = await new Promise<number | null>((resolve) => update.once("close", resolve));
    assert.equal(code, 0, stderr);

    await assert.rejects(
      listBoundedAutonomyTrackedFiles(root),
      /path exceeded the maintenance inventory limit/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Autonomy repository reads reject an atomic replacement without retaining it", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-autonomy-read-"));
  const source = join(root, "source.txt");
  const replacement = join(root, "replacement.txt");
  await writeFile(source, "small\n", "utf8");
  await writeFile(replacement, "", "utf8");
  await truncate(replacement, 128 * 1024 * 1024);
  try {
    assert.equal(
      await readBoundedAutonomyTextFile(source, 512 * 1024, undefined, {
        async open(path, flags) {
          assert.equal((flags & constants.O_NONBLOCK) !== 0, true);
          assert.equal((flags & constants.O_NOFOLLOW) !== 0, true);
          const handle = await open(path, flags);
          await rename(replacement, source);
          return handle;
        },
        lstat,
      }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("Autonomy run admission does not clone retained conversation history", async () => {
  const { state, engine, cleanup } = await fixture();
  const originalLoad = state.load.bind(state);
  try {
    await engine.ensureBuiltInFlows();
    state.load = async () => {
      throw new Error("run admission must not clone the full state projection");
    };
    const run = await engine.startGardener({ projectId: "project-1" });
    state.load = originalLoad;
    const completed = await waitForRun(state, run.id);
    assert.equal(completed.status, "succeeded");
  } finally {
    state.load = originalLoad;
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

function ledgerRun(id: string, updatedAt: string): AutonomyRun {
  return {
    schemaVersion: 2,
    id,
    flowId: "heartbeat-awareness.v1",
    kind: "heartbeat",
    name: id,
    projectId: "project-1",
    worktree: null,
    trigger: "manual",
    status: "succeeded",
    goal: "x",
    revision: 0,
    currentStepId: null,
    taskIds: [],
    standingOrderIds: [],
    budget: { maxTasks: 1, maxRuntimeSeconds: 1, maxCostUsd: null },
    result: null,
    error: null,
    createdAt: updatedAt,
    startedAt: null,
    updatedAt,
    completedAt: null,
  };
}

function ledgerTask(id: string, runId: string, updatedAt: string) {
  return {
    schemaVersion: 2 as const,
    id,
    runId,
    stepId: "step-1",
    kind: "notify" as const,
    title: id,
    status: "succeeded" as const,
    attempt: 1,
    maxAttempts: 1,
    timeoutSeconds: 1,
    input: {},
    output: null,
    error: null,
    createdAt: updatedAt,
    startedAt: null,
    updatedAt,
    completedAt: null,
    nextRunAt: null,
  };
}

function standingOrder(id: string, updatedAt: string) {
  return parseStandingOrder({
    schemaVersion: 2,
    id,
    name: id,
    scope: "global",
    projectId: null,
    instruction: "Keep maintenance bounded.",
    enabled: true,
    createdAt: updatedAt,
    updatedAt,
  });
}

function heartbeatMonitor(id: string, updatedAt: string) {
  return parseHeartbeatMonitor({
    schemaVersion: 2,
    id,
    name: id,
    flowId: "heartbeat-awareness.v1",
    projectId: null,
    worktree: null,
    goal: "Check bounded maintenance state.",
    enabled: true,
    everySeconds: 3_600,
    activeHours: null,
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    createdAt: updatedAt,
    updatedAt,
  });
}

function autonomyHook(id: string, updatedAt: string) {
  return parseAutonomyHook({
    schemaVersion: 2,
    id,
    name: id,
    event: "heartbeat_tick",
    flowId: "heartbeat-awareness.v1",
    projectId: null,
    enabled: true,
    cooldownSeconds: 300,
    lastTriggeredAt: null,
    lastRunId: null,
    createdAt: updatedAt,
    updatedAt,
  });
}

function ledgerWithoutFullCopy<T>(items: T[]): T[] {
  return new Proxy(items, {
    get(target, property, receiver) {
      if (
        property === "slice" ||
        property === "sort" ||
        property === "map" ||
        property === "filter" ||
        property === "forEach" ||
        property === Symbol.iterator
      ) {
        throw new Error(`copied or sorted the full ledger via ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

test("Autonomy snapshots clone only ledger records, not full conversation history", async () => {
  const { state, engine, cleanup } = await fixture();
  try {
    await engine.addStandingOrder({
      name: "Keep snapshots narrow",
      scope: "project",
      projectId: "project-1",
      instruction: "Do not clone conversation history for ledger refreshes.",
    });
    state.load = async () => {
      throw new Error("Autonomy snapshots must not clone the full state projection");
    };

    const snapshot = await engine.snapshot();
    assert.equal(snapshot.standingOrders[0]?.name, "Keep snapshots narrow");
    snapshot.standingOrders[0]!.name = "mutated by caller";
    assert.equal(
      (await state.loadAutonomyProjection()).standingOrders[0]?.name,
      "Keep snapshots narrow",
    );
  } finally {
    await cleanup();
  }
});

test("Autonomy snapshots copy only the newest page, not the whole ledger", async () => {
  const { state, engine, cleanup } = await fixture();
  const originalClone = globalThis.structuredClone;
  try {
    await engine.ensureBuiltInFlows();
    const live = await state.inspect();
    const runs = Array.from({ length: 8_000 }, (_, index) =>
      ledgerRun(`run-${index}`, `t${String(index).padStart(5, "0")}`),
    );
    const tasks = Array.from({ length: 8_000 }, (_, index) =>
      ledgerTask(`task-${index}`, `run-${index}`, `t${String(index).padStart(5, "0")}`),
    );
    (live as { autonomyRuns: AutonomyRun[] }).autonomyRuns = ledgerWithoutFullCopy(runs);
    (live as { autonomyTasks: typeof tasks }).autonomyTasks = ledgerWithoutFullCopy(tasks);

    globalThis.structuredClone = ((value: unknown) => {
      if (Array.isArray(value) && value.length > 500) {
        throw new Error(`cloned ${value.length} ledger rows`);
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as { autonomyRuns?: unknown[]; autonomyTasks?: unknown[] };
        if (Array.isArray(record.autonomyRuns) && record.autonomyRuns.length > 500) {
          throw new Error("cloned the full autonomy run ledger");
        }
        if (Array.isArray(record.autonomyTasks) && record.autonomyTasks.length > 500) {
          throw new Error("cloned the full autonomy task ledger");
        }
      }
      return originalClone(value);
    }) as typeof structuredClone;

    const snapshot = await engine.snapshot(200);
    assert.equal(snapshot.runs.length, 200);
    assert.equal(snapshot.tasks.length, 500);
    assert.equal(snapshot.runs[0]?.id, "run-7999");
    assert.equal(snapshot.runs[199]?.id, "run-7800");
    assert.equal(snapshot.tasks[0]?.id, "task-7999");
    assert.equal(snapshot.tasks[499]?.id, "task-7500");
    snapshot.runs[0]!.name = "mutated by caller";
    assert.equal(runs[7999]?.name, "run-7999");
  } finally {
    globalThis.structuredClone = originalClone;
    await cleanup();
  }
});

test("Autonomy snapshots bound oversized configuration inventories with recovery metadata", async () => {
  const total = MAX_AUTONOMY_CONFIGURATIONS_PER_KIND + 17;
  const orders = Array.from({ length: total }, (_, index) =>
    standingOrder(`order-${index}`, new Date(index * 1_000).toISOString()),
  );
  const engine = new AutonomyEngine({
    inspectAutonomyProjection: async () => ({
      autonomyRuns: [],
      autonomyTasks: [],
      autonomyFlows: [],
      heartbeatMonitors: [],
      standingOrders: ledgerWithoutFullCopy(orders),
      autonomyHooks: [],
    }),
  } as unknown as LocalStateStore);

  const snapshot = await engine.snapshot();
  assert.equal(snapshot.standingOrders.length, MAX_AUTONOMY_CONFIGURATIONS_PER_KIND);
  assert.equal(
    snapshot.standingOrders.some((item) => item.id === `order-${total - 1}`),
    true,
  );
  assert.deepEqual(snapshot.configurationInventory.standingOrders, {
    total,
    truncated: true,
  });
  assert.equal(snapshot.configurationInventory.limitPerKind, MAX_AUTONOMY_CONFIGURATIONS_PER_KIND);
});

test("managed Autonomy configuration paging filters project authority before selection", async () => {
  const hidden = Array.from({ length: MAX_AUTONOMY_CONFIGURATIONS_PER_KIND }, (_, index) => ({
    ...standingOrder(`hidden-${index}`, new Date((index + 1) * 1_000).toISOString()),
    scope: "project" as const,
    projectId: "hidden",
  }));
  const visible = {
    ...standingOrder("visible-oldest", new Date(0).toISOString()),
    scope: "project" as const,
    projectId: "visible",
  };
  const engine = new AutonomyEngine({
    inspectAutonomyProjection: async () => ({
      autonomyRuns: [],
      autonomyTasks: [],
      autonomyFlows: [],
      heartbeatMonitors: [],
      standingOrders: ledgerWithoutFullCopy([visible, ...hidden]),
      autonomyHooks: [],
    }),
  } as unknown as LocalStateStore);

  const snapshot = await engine.snapshot(50, { visibleProjectIds: new Set(["visible"]) });
  assert.deepEqual(
    snapshot.standingOrders.map((item) => item.id),
    ["visible-oldest"],
  );
  assert.deepEqual(snapshot.configurationInventory.standingOrders, {
    total: 1,
    truncated: false,
  });
});

test("Autonomy configuration admission is atomic at the production bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-autonomy-admission-"));
  try {
    const state = new LocalStateStore(directory);
    const attempts = await Promise.allSettled(
      Array.from({ length: MAX_AUTONOMY_CONFIGURATIONS_PER_KIND + 1 }, (_, index) =>
        state.saveAutonomyRecords({
          standingOrders: [standingOrder(`order-${index}`, new Date(index * 1_000).toISOString())],
        }),
      ),
    );
    assert.equal(
      attempts.filter((item) => item.status === "fulfilled").length,
      MAX_AUTONOMY_CONFIGURATIONS_PER_KIND,
    );
    const rejected = attempts.find((item) => item.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") {
      assert.match(String(rejected.reason), /inventory is full/);
      assert.equal((rejected.reason as { status?: number }).status, 429);
    }
    assert.equal(
      (await state.inspect()).standingOrders.length,
      MAX_AUTONOMY_CONFIGURATIONS_PER_KIND,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("heartbeat and hook admission share the finite per-kind bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-autonomy-kind-bounds-"));
  try {
    const state = new LocalStateStore(directory);
    const timestamps = Array.from({ length: MAX_AUTONOMY_CONFIGURATIONS_PER_KIND }, (_, index) =>
      new Date(index * 1_000).toISOString(),
    );
    await state.saveAutonomyRecords({
      heartbeatMonitors: timestamps.map((timestamp, index) =>
        heartbeatMonitor(`heartbeat-${index}`, timestamp),
      ),
      hooks: timestamps.map((timestamp, index) => autonomyHook(`hook-${index}`, timestamp)),
    });

    await assert.rejects(
      state.saveAutonomyRecords({
        heartbeatMonitors: [heartbeatMonitor("heartbeat-overflow", new Date().toISOString())],
      }),
      { status: 429 },
    );
    await assert.rejects(
      state.saveAutonomyRecords({
        hooks: [autonomyHook("hook-overflow", new Date().toISOString())],
      }),
      { status: 429 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized legacy Autonomy inventories stay bounded and reducible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-autonomy-legacy-"));
  try {
    const orders = Array.from({ length: MAX_AUTONOMY_CONFIGURATIONS_PER_KIND + 1 }, (_, index) =>
      standingOrder(`legacy-${index}`, new Date(index * 1_000).toISOString()),
    );
    await writeFile(
      join(directory, "events.v1.jsonl"),
      `${orders
        .map((order, index) =>
          JSON.stringify({
            schemaVersion: 2,
            sequence: index + 1,
            id: `legacy-event-${index}`,
            recordedAt: order.updatedAt,
            event: { type: "standing_order_saved", standingOrder: order },
          }),
        )
        .join("\n")}\n`,
      "utf8",
    );
    const state = new LocalStateStore(directory);
    const engine = new AutonomyEngine(state);
    await engine.ensureBuiltInFlows();
    const oversized = await engine.snapshot();
    assert.equal(oversized.standingOrders.length, MAX_AUTONOMY_CONFIGURATIONS_PER_KIND);
    assert.equal(oversized.configurationInventory.standingOrders.truncated, true);

    await state.removeAutonomyRecord("standingOrder", oversized.standingOrders[0]!.id);
    const reduced = await engine.snapshot();
    assert.deepEqual(reduced.configurationInventory.standingOrders, {
      total: MAX_AUTONOMY_CONFIGURATIONS_PER_KIND,
      truncated: false,
    });
    assert.equal(reduced.standingOrders.length, MAX_AUTONOMY_CONFIGURATIONS_PER_KIND);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Autonomy snapshot paging preserves ledger order for equal timestamps", async () => {
  const { state, engine, cleanup } = await fixture();
  try {
    const live = await state.inspect();
    const runs = ["first", "second", "third"].map((id) => ledgerRun(id, "same"));
    (live as { autonomyRuns: AutonomyRun[] }).autonomyRuns = runs;

    const snapshot = await engine.snapshot(2);
    assert.deepEqual(
      snapshot.runs.map((run) => run.id),
      ["first", "second"],
    );
  } finally {
    await cleanup();
  }
});

test("Autonomy snapshot paging selects newest records from an updated ledger", async () => {
  const { state, engine, cleanup } = await fixture();
  try {
    const live = await state.inspect();
    const runs = [ledgerRun("newest", "t3"), ledgerRun("oldest", "t1"), ledgerRun("middle", "t2")];
    (live as { autonomyRuns: AutonomyRun[] }).autonomyRuns = runs;

    const snapshot = await engine.snapshot(2);
    assert.deepEqual(
      snapshot.runs.map((run) => run.id),
      ["newest", "middle"],
    );
  } finally {
    await cleanup();
  }
});
