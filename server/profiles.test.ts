import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeProfileStore } from "./profiles.ts";

test("sensitive environment values are write-only and stored separately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const store = new ClaudeProfileStore(directory);
  const saved = await store.save({
    name: "Work",
    binaryPath: "claude",
    homePath: "~/.claude-work",
    environment: [
      { name: "ANTHROPIC_BASE_URL", sensitive: false, value: "https://example.invalid" },
      { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "secret-sentinel" },
    ],
  });

  assert.deepEqual(saved.environment, [
    { name: "ANTHROPIC_BASE_URL", sensitive: false, value: "https://example.invalid" },
    { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, valueSet: true },
  ]);
  const profilesFile = await readFile(join(directory, "claude-profiles.v1.json"), "utf8");
  const secretsFile = await readFile(join(directory, "provider-secrets.v1.json"), "utf8");
  assert.equal(profilesFile.includes("secret-sentinel"), false);
  assert.equal(secretsFile.includes("secret-sentinel"), true);
  assert.equal(JSON.stringify(await store.list()).includes("secret-sentinel"), false);

  const runtime = await store.runtime(saved.id);
  assert.equal(runtime.environment.ANTHROPIC_AUTH_TOKEN, "secret-sentinel");
  assert.match(runtime.continuationKey, /^claude:home:/);
});

test("redacted updates preserve secrets while removed variables delete them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const store = new ClaudeProfileStore(directory);
  const saved = await store.save({
    name: "Personal",
    environment: [{ name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "keep-me" }],
  });
  await store.save({
    id: saved.id,
    name: "Personal renamed",
    environment: [{
      name: "ANTHROPIC_AUTH_TOKEN",
      sensitive: true,
      value: "",
      valueSet: true,
    }],
  });
  assert.equal((await store.runtime(saved.id)).environment.ANTHROPIC_AUTH_TOKEN, "keep-me");

  await store.save({ id: saved.id, name: "Personal renamed", environment: [] });
  assert.equal(
    (await readFile(join(directory, "provider-secrets.v1.json"), "utf8")).includes("keep-me"),
    false,
  );
});

test("profile deletion removes Aldunis secrets without touching the Claude home", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const claudeHome = join(directory, "provider-owned-home");
  await writeFile(claudeHome, "provider-owned-credential");
  const store = new ClaudeProfileStore(directory);
  const saved = await store.save({
    name: "Disposable",
    homePath: claudeHome,
    environment: [{ name: "TOKEN", sensitive: true, value: "remove-me" }],
  });

  await store.delete(saved.id);
  assert.equal(await readFile(claudeHome, "utf8"), "provider-owned-credential");
  assert.equal((await store.list()).length, 0);
  assert.equal(
    (await readFile(join(directory, "provider-secrets.v1.json"), "utf8")).includes("remove-me"),
    false,
  );
});

test("availability, version, authentication, and models refresh independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const executable = join(directory, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) console.log("2.1.177 (Claude Code)");
else if (process.argv.includes("auth")) console.log(JSON.stringify({ authenticated: true }));
`);
  await chmod(executable, 0o700);
  const store = new ClaudeProfileStore(directory);
  const saved = await store.save({ name: "Ready", binaryPath: executable });

  const version = await store.refresh(saved.id, "version");
  assert.equal(version.probes.version.state, "ready");
  assert.equal(version.probes.authentication.state, "unknown");
  const authentication = await store.refresh(saved.id, "authentication");
  assert.equal(authentication.probes.version.state, "ready");
  assert.equal(authentication.probes.authentication.authenticated, true);
  const models = await store.refresh(saved.id, "models");
  assert.deepEqual(models.probes.models.models, ["default", "sonnet", "opus", "haiku"]);
  const availability = await store.refresh(saved.id, "availability");
  assert.equal(availability.probes.availability.state, "ready");
});

test("plain-text negative authentication status is not treated as authenticated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const executable = join(directory, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) console.log("2.1.177 (Claude Code)");
else if (process.argv.includes("auth")) console.log("Not authenticated");
`);
  await chmod(executable, 0o700);
  const store = new ClaudeProfileStore(directory);
  const saved = await store.save({ name: "Signed out", binaryPath: executable });
  const snapshot = await store.refresh(saved.id, "authentication");
  assert.equal(snapshot.probes.authentication.state, "unavailable");
  assert.equal(snapshot.probes.authentication.authenticated, false);
});

test("profiles reject duplicate and malformed environment variable names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const store = new ClaudeProfileStore(directory);
  await assert.rejects(
    () => store.save({
      name: "Invalid",
      environment: [{ name: "NOT VALID", sensitive: false, value: "" }],
    }),
    /Invalid environment variable name/,
  );
  await assert.rejects(
    () => store.save({
      name: "Duplicate",
      environment: [
        { name: "TOKEN", sensitive: false, value: "" },
        { name: "TOKEN", sensitive: true, value: "" },
      ],
    }),
    /duplicated/,
  );
});
