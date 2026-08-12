import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_RECOVERABLE_REMOTE_ENVIRONMENTS,
  MAX_REMOTE_ENVIRONMENT_STATE_BYTES,
  MAX_SAVED_REMOTE_ENVIRONMENTS,
  RemoteEnvironmentStore,
} from "./remote-environments.ts";

const input = (index: number) => ({
  label: `Host ${index}`,
  transport: "endpoint" as const,
  endpoint: `https://host-${index}.example.test`,
});

test("production remote environment inventory exposes finite bounds", () => {
  assert.equal(MAX_SAVED_REMOTE_ENVIRONMENTS, 64);
  assert.equal(MAX_RECOVERABLE_REMOTE_ENVIRONMENTS, 256);
  assert.equal(MAX_REMOTE_ENVIRONMENT_STATE_BYTES, 256 * 1024);
});

test("remote environment inventory rejects overflow and recovers after removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-inventory-"));
  const path = join(directory, "connections.v1.json");
  const store = new RemoteEnvironmentStore(path, 2);
  const first = await store.save(input(1));
  await store.save(input(2));
  const before = await readFile(path, "utf8");

  await assert.rejects(() => store.save(input(3)), /inventory is full/);
  assert.equal(await readFile(path, "utf8"), before);
  await store.save({ ...input(10), id: first.record.id });
  await store.remove(first.record.id);
  await store.save(input(3));
  assert.equal((await store.list()).length, 2);
});

test("distinct stores serialize admission across the final slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-inventory-"));
  const path = join(directory, "connections.v1.json");
  const first = new RemoteEnvironmentStore(path, 1);
  const second = new RemoteEnvironmentStore(path, 1);
  const results = await Promise.allSettled([first.save(input(1)), second.save(input(2))]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await first.list()).length, 1);
});

test("oversized legacy inventory stays bounded and reducible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-inventory-"));
  const path = join(directory, "connections.v1.json");
  const source = new RemoteEnvironmentStore(path, 3);
  await source.save(input(1));
  await source.save(input(2));
  await source.save(input(3));

  const recovering = new RemoteEnvironmentStore(path, 2);
  const visible = await recovering.list();
  assert.equal(visible.length, 2);
  await recovering.remove(visible[0].id);
  assert.equal((await recovering.list()).length, 2);
});

test("remote environment state rejects oversized bytes before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-inventory-"));
  const path = join(directory, "connections.v1.json");
  const store = new RemoteEnvironmentStore(path, 2, 3, 128);
  await writeFile(path, " ".repeat(129), "utf8");

  await assert.rejects(() => store.list(), /supported size/);
  await assert.doesNotReject(() => access(path));
});

test("remote environment mutations cannot write an unreadable oversized state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-inventory-"));
  const path = join(directory, "connections.v1.json");
  const store = new RemoteEnvironmentStore(path, 2, 3, 2_048);
  await store.save(input(1));
  const before = await readFile(path, "utf8");

  await assert.rejects(
    () =>
      store.save({
        label: "Oversized host",
        transport: "ssh",
        sshTarget: "example.test",
        remoteCommand: `/${"a".repeat(3_000)}`,
      }),
    /supported size/,
  );
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal((await store.list()).length, 1);
});
