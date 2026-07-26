import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationsStore } from "./automations.ts";

test("automations are versioned, persisted atomically, and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "Daily check",
    prompt: "Review open work and report blockers.",
    schedule: { type: "interval", secs: 3600 },
    threadId: "thread-1",
  });
  assert.equal(created.schemaVersion, 1);
  assert.equal(created.enabled, true);
  assert.equal(created.lastRun, null);

  const loaded = await new AutomationsStore(directory).load();
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0]?.id, created.id);
  assert.equal(
    (await readFile(join(directory, "automations.v1.json"), "utf8")).includes("\"schemaVersion\": 1"),
    true,
  );
});

test("invalid automations file recovers to an empty list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(directory, "automations.v1.json"), "{\"schemaVersion\":99}");
  const loaded = await new AutomationsStore(directory).load();
  assert.deepEqual(loaded, { items: [], recovered: true });
});

test("create rejects short intervals and empty prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const store = new AutomationsStore(directory);
  await assert.rejects(
    () => store.create({
      name: "Too fast",
      prompt: "x",
      schedule: { type: "interval", secs: 30 },
      threadId: "t1",
    }),
    /at least 60/,
  );
  await assert.rejects(
    () => store.create({
      name: "Empty",
      prompt: "   ",
      schedule: { type: "interval", secs: 60 },
      threadId: "t1",
    }),
    /prompt/i,
  );
});

test("update can pause and change schedule; delete removes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const store = new AutomationsStore(directory);
  const created = await store.create({
    name: "A",
    prompt: "Do the thing",
    schedule: { type: "interval", secs: 120 },
    threadId: "t1",
  });
  const paused = await store.update({ id: created.id, enabled: false });
  assert.equal(paused.enabled, false);
  const cron = await store.update({
    id: created.id,
    schedule: { type: "cron", expr: "0 9 * * *" },
  });
  assert.equal(cron.schedule.type, "cron");
  await store.recordOutcome(created.id, {
    lastRun: "2026-01-01T00:00:00.000Z",
    lastOutcome: { at: "2026-01-01T00:00:00.000Z", status: "seeded" },
  });
  const again = await store.get(created.id);
  assert.equal(again?.lastOutcome?.status, "seeded");
  await store.delete(created.id);
  assert.equal(await store.get(created.id), null);
});

test("concurrent creates all persist without lost updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automations-"));
  const store = new AutomationsStore(directory);
  const created = await Promise.all(
    Array.from({ length: 20 }, (_, index) => store.create({
      name: `Parallel ${index}`,
      prompt: `prompt ${index}`,
      schedule: { type: "interval", secs: 60 + index },
      threadId: "t1",
      enabled: false,
    })),
  );
  assert.equal(created.length, 20);
  assert.equal(new Set(created.map((item) => item.id)).size, 20);
  const loaded = await store.load();
  assert.equal(loaded.items.length, 20);
});
