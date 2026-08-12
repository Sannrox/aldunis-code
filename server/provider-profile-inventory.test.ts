import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILTIN_HARNESS_DEFAULTS,
  ClaudeProfileStore,
  MAX_DURABLE_PROVIDER_PROFILES,
  ProfileError,
} from "./profiles.ts";

test("production provider profile inventory exposes a finite bound", () => {
  assert.equal(MAX_DURABLE_PROVIDER_PROFILES, 128);
});

test("profile inventory rejects overflow without writes and recovers after deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profile-inventory-"));
  const store = new ClaudeProfileStore(directory, BUILTIN_HARNESS_DEFAULTS.length + 1);
  await store.list();
  const custom = await store.save({ name: "Custom" });
  await store.save({ id: custom.id, name: "Custom updated" });
  const profilesPath = join(directory, "claude-profiles.v1.json");
  const secretsPath = join(directory, "provider-secrets.v1.json");
  const beforeProfiles = await readFile(profilesPath, "utf8");
  const beforeSecrets = await readFile(secretsPath, "utf8");

  await assert.rejects(
    () => store.save({ name: "Overflow" }),
    (error: unknown) => error instanceof ProfileError && error.status === 429,
  );
  assert.equal(await readFile(profilesPath, "utf8"), beforeProfiles);
  assert.equal(await readFile(secretsPath, "utf8"), beforeSecrets);

  await store.delete(custom.id);
  await store.save({ name: "Recovered" });
  assert.equal((await store.list()).length, BUILTIN_HARNESS_DEFAULTS.length + 1);
});

test("profile inventory rejects oversized persisted state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profile-inventory-"));
  const source = new ClaudeProfileStore(directory, BUILTIN_HARNESS_DEFAULTS.length + 2);
  await source.list();
  const first = await source.save({ name: "First" });
  await source.save({ name: "Second" });

  const recovering = new ClaudeProfileStore(directory, BUILTIN_HARNESS_DEFAULTS.length + 1);
  assert.equal((await recovering.list()).length, BUILTIN_HARNESS_DEFAULTS.length + 1);
  await recovering.delete(first.id);
  assert.equal((await recovering.list()).length, BUILTIN_HARNESS_DEFAULTS.length + 1);
});

test("default profile seeding cannot persist beyond inventory capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profile-inventory-"));
  const profilesPath = join(directory, "claude-profiles.v1.json");
  await assert.rejects(
    () => new ClaudeProfileStore(directory, BUILTIN_HARNESS_DEFAULTS.length - 1).list(),
    (error: unknown) => error instanceof ProfileError && error.status === 429,
  );
  await assert.rejects(() => access(profilesPath), { code: "ENOENT" });
});
