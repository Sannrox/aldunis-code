import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adapterDigest,
  MAX_DURABLE_PROVIDER_ADAPTERS,
  MAX_PROVIDER_ADAPTER_DIRECTORY_ENTRIES,
  parseProviderAdapterManifest,
  ProviderAdapterError,
  ProviderAdapterStore,
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
