import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationError, AutomationStore, MAX_DURABLE_AUTOMATIONS } from "./automations.ts";

const input = (name: string) => ({
  name,
  threadId: "thread-1",
  prompt: "Run the bounded task.",
  schedule: { kind: "interval" as const, seconds: 60 },
});

test("production automation inventory exposes a finite bound", () => {
  assert.equal(MAX_DURABLE_AUTOMATIONS, 256);
});

test("automation inventory rejects overflow without writing and recovers after deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automation-inventory-"));
  const store = new AutomationStore(directory, 2);
  const first = await store.create(input("First"));
  const second = await store.create(input("Second"));
  await store.update(second.id, { name: "Second updated" });
  const path = join(directory, "automations.v1.json");
  const beforeOverflow = await readFile(path, "utf8");

  await assert.rejects(
    () => store.create(input("Overflow")),
    (error: unknown) => error instanceof AutomationError && error.status === 429,
  );
  assert.equal(await readFile(path, "utf8"), beforeOverflow);

  await store.remove(first.id);
  await store.create(input("Recovered"));
  assert.deepEqual(
    (await store.list()).map((automation) => automation.name),
    ["Second updated", "Recovered"],
  );
});

test("automation inventory rejects oversized persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automation-inventory-"));
  const source = new AutomationStore(directory, 3);
  await source.create(input("First"));
  await source.create(input("Second"));
  await source.create(input("Third"));

  await assert.rejects(
    () => new AutomationStore(directory, 2).list(),
    (error: unknown) =>
      error instanceof AutomationError && /incompatible schema/i.test(error.message),
  );
});
