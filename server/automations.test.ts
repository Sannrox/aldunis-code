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
    isScheduleDue(baseAutomation({
      lastRunAt: "2026-01-01T00:00:00.000Z",
      schedule: { kind: "interval", seconds: 60 },
    }), new Date("2026-01-01T00:01:00.000Z")),
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
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const scheduler = new AutomationScheduler(store, {
    isThreadBusy: async () => false,
    fire: async (automation) => {
      order.push(`start:${automation.id}`);
      if (automation.id === a.id) await gateA;
      order.push(`end:${automation.id}`);
    },
    now: () => now,
  });
  await scheduler.tick(); // seed
  now = new Date("2026-06-01T00:02:00.000Z");
  const tick = scheduler.tick();
  // B should finish while A is still gated.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
