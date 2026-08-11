import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutomationScheduler,
  AutomationStore,
  assertValidCron,
  cronMatchesUtc,
  isScheduleDue,
  MIN_INTERVAL_SECONDS,
  type Automation,
  type AutomationFire,
  type AutomationFireKey,
  type AutomationFireStore,
} from "./automations.ts";

function baseAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    schemaVersion: 1,
    id: "a1",
    name: "Daily check",
    threadId: "t1",
    prompt: "Summarize outstanding work",
    mode: "ask",
    enabled: true,
    schedule: { kind: "interval", seconds: 60 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    ...overrides,
  };
}

test("interval schedule requires at least 60 seconds", () => {
  assert.equal(MIN_INTERVAL_SECONDS, 60);
});

test("cron validation accepts 5-field UTC expressions", () => {
  assertValidCron("*/15 * * * *");
  assertValidCron("0 9 * * 1-5");
  assert.throws(() => assertValidCron("* * *"), /5-field/);
  assert.throws(() => assertValidCron("60 * * * *"), /minute/);
});

test("cronMatchesUtc evaluates fields", () => {
  const noonMonday = new Date(Date.UTC(2026, 0, 5, 12, 0, 0)); // Mon
  assert.equal(cronMatchesUtc("0 12 * * 1", noonMonday), true);
  assert.equal(cronMatchesUtc("0 13 * * 1", noonMonday), false);
});

test("cronMatchesUtc uses POSIX OR when both DOM and DOW are restricted", () => {
  // 0 9 15 * 1 → 09:00 on the 15th OR on Mondays (not only Mondays that are the 15th).
  const thursday15 = new Date(Date.UTC(2026, 0, 15, 9, 0, 0)); // Thu 15th
  const monday19 = new Date(Date.UTC(2026, 0, 19, 9, 0, 0)); // Mon 19th
  const tuesday = new Date(Date.UTC(2026, 0, 20, 9, 0, 0)); // Tue 20th
  assert.equal(cronMatchesUtc("0 9 15 * 1", thursday15), true);
  assert.equal(cronMatchesUtc("0 9 15 * 1", monday19), true);
  assert.equal(cronMatchesUtc("0 9 15 * 1", tuesday), false);
});

test("first evaluation is due for seeding without prior lastRun", () => {
  const now = new Date("2026-01-01T00:00:30.000Z");
  assert.equal(isScheduleDue(baseAutomation(), now), true);
  // 30s after last run with 60s interval is not due yet.
  assert.equal(
    isScheduleDue(baseAutomation({ lastRunAt: "2026-01-01T00:00:00.000Z" }), now),
    false,
  );
  assert.equal(
    isScheduleDue(
      baseAutomation({
        lastRunAt: "2026-01-01T00:00:00.000Z",
        schedule: { kind: "interval", seconds: 60 },
      }),
      new Date("2026-01-01T00:01:00.000Z"),
    ),
    true,
  );
});

test("store persists items and serializes concurrent creates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const store = new AutomationStore(directory);
  const created = await Promise.all([
    store.create({
      name: "One",
      threadId: "t1",
      prompt: "p1",
      schedule: { kind: "interval", seconds: 60 },
    }),
    store.create({
      name: "Two",
      threadId: "t2",
      prompt: "p2",
      schedule: { kind: "cron", expression: "0 * * * *" },
    }),
  ]);
  assert.equal(created.length, 2);
  const listed = await store.list();
  assert.equal(listed.length, 2);
  const raw = JSON.parse(await readFile(join(directory, "automations.v1.json"), "utf8"));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.items.length, 2);
});

test("scheduler seeds first tick without firing and skips busy without advancing lastRun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-sched-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Busy aware",
    threadId: "thread-busy",
    prompt: "check",
    schedule: { kind: "interval", seconds: 60 },
  });
  let fires = 0;
  let now = new Date("2026-06-01T00:00:00.000Z");
  const busy = new Set<string>();
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async (threadId) => busy.has(threadId),
    fire: async () => {
      fires += 1;
    },
    now: () => now,
  });

  await scheduler.tick();
  let current = await store.get(automation.id);
  assert.ok(current?.lastRunAt);
  assert.equal(fires, 0);

  now = new Date("2026-06-01T00:02:00.000Z");
  busy.add("thread-busy");
  const lastBeforeSkip = current!.lastRunAt;
  await scheduler.tick();
  current = await store.get(automation.id);
  assert.equal(current?.lastRunAt, lastBeforeSkip);
  assert.equal(current?.lastStatus, "skipped_busy");
  assert.equal(fires, 0);

  busy.delete("thread-busy");
  await scheduler.tick();
  current = await store.get(automation.id);
  assert.equal(fires, 1);
  assert.equal(current?.lastStatus, "ok");
  assert.notEqual(current?.lastRunAt, lastBeforeSkip);
});

test("scheduler removes idle timers and wakes after enabled automation mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-idle-"));
  const store = new AutomationStore(directory);
  type Timer = { callback: () => void; delay: number; referenced: boolean; unref(): void };
  const timers = new Set<Timer>();
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => undefined,
    intervalMs: 15_000,
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
  assert.equal(timers.size, 0);

  const automation = await store.create({
    name: "Wake scheduler",
    threadId: "thread-1",
    prompt: "check",
    schedule: { kind: "interval", seconds: 60 },
  });
  await scheduler.refresh();
  assert.equal(timers.size, 1);
  assert.equal([...timers][0]?.delay, 15_000);
  assert.equal([...timers][0]?.referenced, false);

  const originalTimer = [...timers][0];
  await scheduler.refresh();
  assert.equal([...timers][0], originalTimer);

  const scheduled = [...timers][0]!;
  timers.delete(scheduled);
  scheduled.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await scheduler.refresh();
  assert.equal(timers.size, 1);
  assert.equal([...timers][0]?.delay, 15_000);

  await store.update(automation.id, { enabled: false });
  await scheduler.refresh();
  assert.equal(timers.size, 0);

  await store.update(automation.id, { enabled: true });
  await scheduler.refresh();
  assert.equal(timers.size, 1);
  scheduler.stop();
  assert.equal(timers.size, 0);

  await store.update(automation.id, { enabled: false });
  await scheduler.refresh();
  assert.equal(timers.size, 0);
});

test("scheduler serializes mutation refreshes behind an active store read", async () => {
  const releases: Array<() => void> = [];
  let listCalls = 0;
  const store = {
    list: () =>
      new Promise<Automation[]>((resolve) => {
        listCalls += 1;
        releases.push(() => resolve([]));
      }),
  } as AutomationStore;
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => undefined,
  });

  scheduler.start();
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  listCalls = 0;
  const first = scheduler.refresh();
  const second = scheduler.refresh();
  assert.equal(listCalls, 1);

  releases.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 2);
  releases.shift()?.();
  await Promise.all([first, second]);
  scheduler.stop();
});

test("scheduler evaluates schedules immediately on startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-start-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Startup automation",
    threadId: "thread-1",
    prompt: "check",
    schedule: { kind: "interval", seconds: 60 },
  });
  await store.update(automation.id, { lastRunAt: new Date(0).toISOString() });
  let fired = 0;
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => {
      fired += 1;
    },
  });

  scheduler.start();
  await scheduler.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fired, 1);
  scheduler.stop();
});

test("mutation refresh does not wait for due provider execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-refresh-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Slow automation",
    threadId: "thread-1",
    prompt: "check",
    schedule: { kind: "interval", seconds: 60 },
  });
  await store.update(automation.id, { lastRunAt: new Date(0).toISOString() });
  let releaseFire!: () => void;
  const fire = new Promise<void>((resolve) => {
    releaseFire = resolve;
  });
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => fire,
  });

  scheduler.start();
  const tick = scheduler.tick();
  await scheduler.refresh();
  releaseFire();
  await tick;
  scheduler.stop();
});

test("scheduler keeps mutation success recoverable after a transient store read failure", async () => {
  let retries = 0;
  const timer = {
    unref: () => undefined,
  };
  const scheduler = new AutomationScheduler(
    {
      list: async () => {
        throw new Error("temporary read failure");
      },
    } as AutomationStore,
    {
      isThreadBusy: async () => false,
      fire: async () => undefined,
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

test("tick fires multiple due automations without waiting serially", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-concurrent-"));
  const store = new AutomationStore(directory);
  const a = await store.create({
    name: "A",
    threadId: "t-a",
    prompt: "a",
    schedule: { kind: "interval", seconds: 60 },
  });
  const b = await store.create({
    name: "B",
    threadId: "t-b",
    prompt: "b",
    schedule: { kind: "interval", seconds: 60 },
  });
  // Seed both
  let now = new Date("2026-06-01T00:00:00.000Z");
  const order: string[] = [];
  let resolveAStarted!: () => void;
  let resolveBStarted!: () => void;
  let resolveBEnded!: () => void;
  const aStarted = new Promise<void>((resolve) => {
    resolveAStarted = resolve;
  });
  const bStarted = new Promise<void>((resolve) => {
    resolveBStarted = resolve;
  });
  const bEnded = new Promise<void>((resolve) => {
    resolveBEnded = resolve;
  });
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async (automation) => {
      order.push(`start:${automation.id}`);
      if (automation.id === a.id) {
        resolveAStarted();
        await gateA;
      } else {
        resolveBStarted();
      }
      order.push(`end:${automation.id}`);
      if (automation.id === b.id) resolveBEnded();
    },
    now: () => now,
  });
  await scheduler.tick(); // seed
  now = new Date("2026-06-01T00:02:00.000Z");
  const tick = scheduler.tick();
  // B should finish while A is still gated.
  await Promise.all([aStarted, bStarted, bEnded]);
  assert.ok(order.includes(`start:${a.id}`));
  assert.ok(order.includes(`start:${b.id}`));
  assert.ok(order.includes(`end:${b.id}`));
  assert.equal(order.includes(`end:${a.id}`), false);
  releaseA();
  await tick;
  assert.ok(order.includes(`end:${a.id}`));
});

test("runNow fires immediately and can report errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-runnow-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Immediate",
    threadId: "t-run",
    prompt: "go",
    schedule: { kind: "interval", seconds: 3600 },
  });
  let fires = 0;
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => {
      fires += 1;
      if (fires === 2) throw new Error("provider down");
    },
  });
  const ok = await scheduler.runNow(automation.id);
  assert.equal(ok.lastStatus, "ok");
  assert.equal(fires, 1);
  const failed = await scheduler.runNow(automation.id);
  assert.equal(failed.lastStatus, "error");
  assert.match(failed.lastError ?? "", /provider down/);
});

test("runNow serializes distinct keys for one conversation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-run-lock-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Serialized",
    threadId: "t-serialized",
    prompt: "go",
    schedule: { kind: "interval", seconds: 3600 },
  });
  let active = 0;
  let maximumActive = 0;
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  });

  await Promise.all([
    scheduler.runNow(automation.id, "request-a"),
    scheduler.runNow(automation.id, "request-b"),
  ]);
  assert.equal(maximumActive, 1);
});

test("runNow is idempotent for one key and requires a new key for explicit retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-idempotent-"));
  const store = new AutomationStore(directory);
  const automation = await store.create({
    name: "Idempotent",
    threadId: "t-idempotent",
    prompt: "go",
    schedule: { kind: "interval", seconds: 3600 },
  });
  const fires = new Map<string, AutomationFire>();
  let sequence = 0;
  const makeFire = (input: AutomationFireKey, status: AutomationFire["status"]): AutomationFire => {
    const now = new Date().toISOString();
    return {
      schemaVersion: 2,
      id: `fire-${++sequence}`,
      automationId: input.automationId,
      key: input.key,
      kind: input.kind,
      scheduledAt: input.scheduledAt,
      requestedAt: input.requestedAt,
      turnId: null,
      providerRunId: null,
      status,
      error: null,
      retryOf: input.retryOf ?? null,
      createdAt: now,
      updatedAt: now,
    };
  };
  const fireStore: AutomationFireStore = {
    async get(automationId, key) {
      return (
        [...fires.values()].find(
          (fire) => fire.automationId === automationId && fire.key === key,
        ) ?? null
      );
    },
    async getById(fireId) {
      return fires.get(fireId) ?? null;
    },
    async latest(automationId) {
      return (
        [...fires.values()]
          .filter((fire) => fire.automationId === automationId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null
      );
    },
    async recordSkippedBusy(input) {
      const existing = await this.get(input.automationId, input.key);
      if (existing) return existing;
      const fire = makeFire(input, "skipped_busy");
      fires.set(fire.id, fire);
      return fire;
    },
    async claim(input) {
      const existing = await this.get(input.automationId, input.key);
      if (existing) {
        if (existing.kind === "scheduled" && existing.status === "skipped_busy") {
          const fire = { ...existing, status: "started" as const };
          fires.set(fire.id, fire);
          return { fire, claimed: true };
        }
        return { fire: existing, claimed: false };
      }
      const fire = makeFire(input, "started");
      fires.set(fire.id, fire);
      return { fire, claimed: true };
    },
    async finish(fireId, status, error = null) {
      const existing = fires.get(fireId)!;
      const fire = { ...existing, status, error };
      fires.set(fire.id, fire);
      return fire;
    },
  };
  let launches = 0;
  let busy = false;
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => busy,
    fire: async () => {
      launches += 1;
      return launches === 1
        ? { status: "unknown", error: "outcome unavailable" }
        : { status: "completed" };
    },
    fireStore,
  });

  const first = await scheduler.runNow(automation.id, "request-1");
  const duplicate = await scheduler.runNow(automation.id, "request-1");
  assert.equal(launches, 1);
  assert.equal(first.lastStatus, "unknown");
  assert.equal(duplicate.lastStatus, "unknown");
  busy = true;
  const skipped = await scheduler.runNow(automation.id, "request-busy");
  assert.equal(skipped.lastStatus, "skipped_busy");
  busy = false;
  const duplicateSkipped = await scheduler.runNow(automation.id, "request-busy");
  assert.equal(duplicateSkipped.lastStatus, "skipped_busy");
  assert.equal(launches, 1);
  await assert.rejects(
    () => scheduler.runNow(automation.id, "request-1", "fire-1"),
    /explicit retry must use a new idempotency key/,
  );
  const retry = await scheduler.runNow(automation.id, "request-2", "fire-1");
  assert.equal(launches, 2);
  assert.equal(retry.lastStatus, "ok");
  await assert.rejects(
    () => scheduler.runNow(automation.id, "request-3", "fire-2"),
    /Only an unknown fire/,
  );
});
