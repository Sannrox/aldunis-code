import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderAdapterStore } from "./provider-adapters.ts";
import { listReviewedAdapters, prepareReviewedAdapter } from "./reviewed-adapters.ts";

test("reviewed catalog exposes Kiro and Grok packages with matching digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-reviewed-adapters-"));
  const store = new ProviderAdapterStore(directory);
  const catalog = await listReviewedAdapters(store);
  assert.equal(catalog.length, 2);
  const slugs = catalog.map((entry) => entry.slug).sort();
  assert.deepEqual(slugs, ["grok-build-cli", "kiro-cli"]);
  for (const entry of catalog) {
    assert.equal(entry.action, "install");
    assert.equal(entry.installed, false);
    assert.ok(entry.package);
    assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(entry.package.digest, entry.digest);
    assert.match(entry.source, /^file:\/\//);
    assert.ok(entry.installLabel.toLocaleLowerCase().includes("install"));
  }
});

test("prepare and install a reviewed adapter without manual digest entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-reviewed-adapters-"));
  const store = new ProviderAdapterStore(directory);
  const { entry, candidate } = await prepareReviewedAdapter(store, "kiro-cli");
  assert.equal(entry.slug, "kiro-cli");
  assert.equal(candidate.manifest.id, "dev.kiro.cli");
  assert.equal(candidate.digest, entry.digest);

  const installed = await store.install({
    source: entry.package.source,
    digest: entry.package.digest,
    manifest: entry.package.manifest,
  });
  assert.equal(installed.manifest.id, "dev.kiro.cli");
  assert.equal(installed.enabled, true);

  const after = await listReviewedAdapters(store);
  const kiro = after.find((item) => item.slug === "kiro-cli");
  assert.equal(kiro?.action, "current");
  assert.equal(kiro?.installed, true);
});

test("unknown reviewed slug fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-reviewed-adapters-"));
  const store = new ProviderAdapterStore(directory);
  await assert.rejects(() => prepareReviewedAdapter(store, "not-a-real-adapter"), /Unknown reviewed adapter/);
});
