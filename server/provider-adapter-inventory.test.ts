import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterDigest,
  MAX_DURABLE_PROVIDER_ADAPTERS,
  MAX_PROVIDER_ADAPTER_RECORD_BYTES,
  MAX_PROVIDER_ADAPTER_DIRECTORY_ENTRIES,
  parseProviderAdapterManifest,
  ProviderAdapterError,
  ProviderAdapterStore,
  readProviderAdapterRecordFile,
  type ProviderAdapterManifest,
} from "./provider-adapters.ts";

function input(id: string, version = "1.0.0") {
  const manifest = parseProviderAdapterManifest({
    schemaVersion: 1,
    id,
    publisher: { name: "Example Tools" },
    version,
    aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
    protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
    executable: { names: [`${id}-agent`], arguments: ["--acp"] },
    capabilities: { tools: true, images: false, sessionResume: true },
    environment: [],
    presentation: { name: id, description: "A fixture declarative provider." },
  } satisfies ProviderAdapterManifest);
  return {
    source: `https://example.com/${id}.json`,
    digest: adapterDigest(manifest),
    manifest,
  };
}

test("production provider adapter inventory exposes a finite bound", () => {
  assert.equal(MAX_DURABLE_PROVIDER_ADAPTERS, 64);
  assert.equal(MAX_PROVIDER_ADAPTER_DIRECTORY_ENTRIES, 256);
  assert.equal(MAX_PROVIDER_ADAPTER_RECORD_BYTES, 192 * 1024);
});

test("oversized adapter records are rejected before reading file content", async () => {
  let reads = 0;
  let closed = false;
  await assert.rejects(
    () =>
      readProviderAdapterRecordFile("/state/provider-adapters/large.agent.json", {
        async open() {
          return {
            async stat() {
              return {
                size: MAX_PROVIDER_ADAPTER_RECORD_BYTES + 1,
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
    /metadata is oversized/,
  );
  assert.equal(reads, 0);
  assert.equal(closed, true);
});

test("adapter record reads fail closed when the file grows", async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      readProviderAdapterRecordFile("/state/provider-adapters/growing.agent.json", {
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
  assert.equal(reads, 2);
});

test("adapter record reads fail closed when the file shrinks", async () => {
  await assert.rejects(
    () =>
      readProviderAdapterRecordFile("/state/provider-adapters/shrinking.agent.json", {
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

test("adapter inventory rejects overflow and retains lifecycle recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const store = new ProviderAdapterStore(directory, 2);
  await store.install(input("first.agent"));
  await store.install(input("second.agent"));

  await store.update(input("first.agent", "1.1.0"));
  await store.setEnabled("first.agent", false);
  assert.equal((await store.rollback("first.agent")).manifest.version, "1.0.0");
  await assert.rejects(
    () => store.install(input("overflow.agent")),
    (error: unknown) => error instanceof ProviderAdapterError && error.status === 429,
  );
  await assert.rejects(() => access(join(directory, "provider-adapters", "overflow.agent.json")), {
    code: "ENOENT",
  });

  await store.uninstall("second.agent");
  await store.install(input("recovered.agent"));
  assert.equal((await store.list()).length, 2);
});

test("distinct adapter installs serialize across the final capacity slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const firstStore = new ProviderAdapterStore(directory, 1);
  const secondStore = new ProviderAdapterStore(directory, 1);
  const results = await Promise.allSettled([
    firstStore.install(input("first.agent")),
    secondStore.install(input("second.agent")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof ProviderAdapterError &&
      rejected.reason.status === 429,
  );
  assert.equal((await firstStore.list()).length, 1);
});

test("oversized legacy adapter inventories remain bounded and reducible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const source = new ProviderAdapterStore(directory, 3);
  await source.install(input("first.agent"));
  await source.install(input("second.agent"));
  await source.install(input("third.agent"));

  const recovering = new ProviderAdapterStore(directory, 2);
  const visible = await recovering.list();
  assert.equal(visible.length, 2);
  await recovering.uninstall(visible[0].manifest.id);
  assert.equal((await recovering.list()).length, 2);
});

test("corrupt JSON does not hide valid adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const adapterDirectory = join(directory, "provider-adapters");
  const source = new ProviderAdapterStore(directory, 2);
  await source.install(input("first.agent"));
  await source.install(input("second.agent"));
  await writeFile(join(adapterDirectory, "corrupt.json"), "not json", "utf8");

  const recovering = new ProviderAdapterStore(directory, 2);
  assert.deepEqual((await recovering.list()).map((adapter) => adapter.manifest.id).sort(), [
    "first.agent",
    "second.agent",
  ]);
});

test("copied adapter records do not consume distinct inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const adapterDirectory = join(directory, "provider-adapters");
  const store = new ProviderAdapterStore(directory, 2);
  await store.install(input("first.agent"));
  const record = await readFile(join(adapterDirectory, "first.agent.json"), "utf8");
  await writeFile(join(adapterDirectory, "backup.json"), record, "utf8");
  await store.install(input("second.agent"));

  assert.deepEqual((await store.list()).map((adapter) => adapter.manifest.id).sort(), [
    "first.agent",
    "second.agent",
  ]);
});

test("adapter directory traversal fails explicitly at its examination bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-inventory-"));
  const adapterDirectory = join(directory, "provider-adapters");
  const store = new ProviderAdapterStore(directory, 2, 3);
  await store.install(input("first.agent"));
  await writeFile(join(adapterDirectory, ".one.tmp"), "", "utf8");
  await writeFile(join(adapterDirectory, ".two.tmp"), "", "utf8");
  await writeFile(join(adapterDirectory, ".three.tmp"), "", "utf8");

  await assert.rejects(
    () => store.list(),
    (error: unknown) => error instanceof ProviderAdapterError && error.status === 500,
  );
});
