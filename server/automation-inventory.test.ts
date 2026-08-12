import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutomationError,
  AutomationStore,
  MAX_AUTOMATION_STORE_BYTES,
  MAX_DURABLE_AUTOMATIONS,
  readAutomationStoreFile,
} from "./automations.ts";

const input = (name: string) => ({
  name,
  threadId: "thread-1",
  prompt: "Run the bounded task.",
  schedule: { kind: "interval" as const, seconds: 60 },
});

test("production automation inventory exposes a finite bound", () => {
  assert.equal(MAX_DURABLE_AUTOMATIONS, 256);
  assert.equal(MAX_AUTOMATION_STORE_BYTES, 64 * 1024 * 1024);
});

test("oversized automation stores are rejected before reading file content", async () => {
  let reads = 0;
  let closed = false;
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          return {
            size: MAX_AUTOMATION_STORE_BYTES + 1,
            dev: 1,
            ino: 2,
            mtimeMs: 3,
            ctimeMs: 4,
            isFile: () => true,
          };
        },
        async open() {
          return {
            async stat() {
              return {
                size: MAX_AUTOMATION_STORE_BYTES + 1,
                dev: 1,
                ino: 2,
                mtimeMs: 3,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read() {
              reads += 1;
              return { bytesRead: 0 };
            },
            async close() {
              closed = true;
            },
          };
        },
      }),
    /exceeds the supported size/,
  );
  assert.equal(reads, 0);
  assert.equal(closed, true);
});

test("automation store reads fail closed when the file grows", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          return { size: 2, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4, isFile: () => true };
        },
        async open() {
          return {
            async stat() {
              return {
                size: 2,
                dev: 1,
                ino: 2,
                mtimeMs: 3,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read(buffer, offset) {
              reads += 1;
              buffer[offset] = reads === 1 ? 0x7b : 0x78;
              if (reads === 1) buffer[offset + 1] = 0x7d;
              return { bytesRead: reads === 1 ? 2 : 1 };
            },
            async close() {},
          };
        },
      }),
    /changed while being read/,
  );
});

test("automation store reads fail closed when the file shrinks", async () => {
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          return { size: 2, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4, isFile: () => true };
        },
        async open() {
          return {
            async stat() {
              return {
                size: 2,
                dev: 1,
                ino: 2,
                mtimeMs: 3,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read(buffer, offset) {
              if (offset === 0) {
                buffer[offset] = 0x7b;
                return { bytesRead: 1 };
              }
              return { bytesRead: 0 };
            },
            async close() {},
          };
        },
      }),
    /changed while being read/,
  );
});

test("automation store reads fail closed when metadata changes", async () => {
  let stats = 0;
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          return { size: 2, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4, isFile: () => true };
        },
        async open() {
          return {
            async stat() {
              stats += 1;
              return {
                size: 2,
                dev: 1,
                ino: 2,
                mtimeMs: stats,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read(buffer, offset, length) {
              if (length === 1) return { bytesRead: 0 };
              buffer[offset] = 0x7b;
              buffer[offset + 1] = 0x7d;
              return { bytesRead: 2 };
            },
            async close() {},
          };
        },
      }),
    /changed while being read/,
  );
  assert.equal(stats, 2);
});

test("automation store reads fail closed when the pathname is replaced", async () => {
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          return { size: 2, dev: 1, ino: 9, mtimeMs: 5, ctimeMs: 6, isFile: () => true };
        },
        async open() {
          return {
            async stat() {
              return {
                size: 2,
                dev: 1,
                ino: 2,
                mtimeMs: 3,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read(buffer, offset, length) {
              if (length === 1) return { bytesRead: 0 };
              buffer[offset] = 0x7b;
              buffer[offset + 1] = 0x7d;
              return { bytesRead: 2 };
            },
            async close() {},
          };
        },
      }),
    /changed while being read/,
  );
});

test("automation store reads fail closed when the pathname disappears after opening", async () => {
  await assert.rejects(
    () =>
      readAutomationStoreFile("/state/automations.v1.json", MAX_AUTOMATION_STORE_BYTES, {
        async stat() {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        async open() {
          return {
            async stat() {
              return {
                size: 2,
                dev: 1,
                ino: 2,
                mtimeMs: 3,
                ctimeMs: 4,
                isFile: () => true,
              };
            },
            async read(buffer, offset, length) {
              if (length === 1) return { bytesRead: 0 };
              buffer[offset] = 0x7b;
              buffer[offset + 1] = 0x7d;
              return { bytesRead: 2 };
            },
            async close() {},
          };
        },
      }),
    (error: unknown) => error instanceof AutomationError && error.status === 500,
  );
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

test("automation mutations leave prior state intact when the byte ceiling is exceeded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-automation-inventory-"));
  const seed = new AutomationStore(directory);
  const existing = await seed.create(input("First"));
  const path = join(directory, "automations.v1.json");
  const before = await readFile(path, "utf8");
  const constrained = new AutomationStore(directory, MAX_DURABLE_AUTOMATIONS, before.length + 10);

  await assert.rejects(
    () => constrained.update(existing.id, { prompt: "x".repeat(1_000) }),
    /exceeds the supported size/,
  );
  assert.equal(await readFile(path, "utf8"), before);
});
