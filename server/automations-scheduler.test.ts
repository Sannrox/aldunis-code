import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationsStore } from "./automations.ts";
import { AutomationsScheduler } from "./automations-scheduler.ts";

test("first tick seeds lastRun without firing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-auto-sched-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Seed me",
    prompt: "Check status",
    schedule: { type: "interval", secs: 60 },
    threadId: "thread-a",
  });
  let fires = 0;
  const clock = { now: Date.parse("2026-01-01T12:00:00Z") };
  const scheduler = new AutomationsScheduler(
    store,
    async () => {
      fires += 1;
      return { status: "ok", turnId: "turn-1" };
    },
    { now: () => clock.now },
  );
  await scheduler.tick();
  assert.equal(fires, 0);
  const after = await store.get(created.id);
  assert.equal(after?.lastOutcome?.status, "seeded");
  assert.equal(after?.lastRun, "2026-01-01T12:00:00.000Z");
});

test("due interval fires once and advances lastRun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-auto-sched-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Due",
    prompt: "Work",
    schedule: { type: "interval", secs: 60 },
    threadId: "thread-a",
  });
  await store.recordOutcome(created.id, {
    lastRun: "2026-01-01T12:00:00.000Z",
    lastOutcome: { at: "2026-01-01T12:00:00.000Z", status: "seeded" },
  });
  let fires = 0;
  const clock = { now: Date.parse("2026-01-01T12:01:00Z") };
  const scheduler = new AutomationsScheduler(
    store,
    async () => {
      fires += 1;
      return { status: "ok", turnId: "turn-9" };
    },
    { now: () => clock.now },
  );
  await scheduler.tick();
  assert.equal(fires, 1);
  const after = await store.get(created.id);
  assert.equal(after?.lastOutcome?.status, "ok");
  assert.equal(after?.lastOutcome?.turnId, "turn-9");
  assert.equal(after?.lastRun, "2026-01-01T12:01:00.000Z");
});

test("busy skip leaves lastRun unchanged on scheduled tick", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-auto-sched-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Busy",
    prompt: "Work",
    schedule: { type: "interval", secs: 60 },
    threadId: "thread-a",
  });
  await store.recordOutcome(created.id, {
    lastRun: "2026-01-01T12:00:00.000Z",
    lastOutcome: { at: "2026-01-01T12:00:00.000Z", status: "seeded" },
  });
  const clock = { now: Date.parse("2026-01-01T12:05:00Z") };
  const scheduler = new AutomationsScheduler(
    store,
    async () => ({ status: "skipped_busy", message: "Conversation is busy." }),
    { now: () => clock.now },
  );
  await scheduler.tick();
  const after = await store.get(created.id);
  assert.equal(after?.lastRun, "2026-01-01T12:00:00.000Z");
  assert.equal(after?.lastOutcome?.status, "skipped_busy");
});

test("runNow ignores schedule and advances lastRun even when busy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-auto-sched-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Now",
    prompt: "Work",
    schedule: { type: "interval", secs: 3600 },
    threadId: "thread-a",
  });
  await store.recordOutcome(created.id, {
    lastRun: "2026-01-01T12:00:00.000Z",
    lastOutcome: { at: "2026-01-01T12:00:00.000Z", status: "seeded" },
  });
  const clock = { now: Date.parse("2026-01-01T12:00:30Z") };
  const scheduler = new AutomationsScheduler(
    store,
    async () => ({ status: "skipped_busy" }),
    { now: () => clock.now },
  );
  const updated = await scheduler.runNow(created.id);
  assert.equal(updated.lastRun, "2026-01-01T12:00:30.000Z");
  assert.equal(updated.lastOutcome?.status, "skipped_busy");
});

test("disabled automations are not evaluated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-auto-sched-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Off",
    prompt: "Work",
    schedule: { type: "interval", secs: 60 },
    threadId: "thread-a",
    enabled: false,
  });
  await store.recordOutcome(created.id, {
    lastRun: "2026-01-01T12:00:00.000Z",
    lastOutcome: { at: "2026-01-01T12:00:00.000Z", status: "seeded" },
  });
  let fires = 0;
  const scheduler = new AutomationsScheduler(
    store,
    async () => {
      fires += 1;
      return { status: "ok" };
    },
    { now: () => Date.parse("2026-01-01T13:00:00Z") },
  );
  await scheduler.tick();
  assert.equal(fires, 0);
});
