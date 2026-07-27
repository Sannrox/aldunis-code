import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ClaudeProfileStore,
  DEFAULT_CLAUDE_PROFILE_ID,
  DEFAULT_CODEX_PROFILE_ID,
  DEFAULT_SHIKIGAMI_PROFILE_ID,
  defaultProfileId,
} from "./profiles.ts";

test("profile store seeds default profiles for every first-class provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-"));
  const store = new ClaudeProfileStore(directory);
  const profiles = await store.list();
  assert.equal(profiles.length, 3);
  assert.equal(profiles[0].id, DEFAULT_CLAUDE_PROFILE_ID);
  assert.equal(profiles[0].provider, "claude-code");
  assert.equal(profiles[0].binaryPath, "claude");
  assert.deepEqual(profiles[0].environment, []);
  assert.ok(profiles.some((profile) => profile.id === DEFAULT_CODEX_PROFILE_ID && profile.provider === "codex-cli"));
  assert.ok(profiles.some((profile) => profile.id === DEFAULT_SHIKIGAMI_PROFILE_ID && profile.provider === "shikigami"));
  // Second list is idempotent and does not duplicate defaults.
  assert.equal((await store.list()).length, 3);
  const runtime = await store.runtime(DEFAULT_CLAUDE_PROFILE_ID);
  assert.equal(runtime.executable, "claude");

  // Custom profiles keep the built-in defaults available.
  await store.save({ name: "Work", binaryPath: "claude", provider: "claude-code" });
  await store.delete(DEFAULT_CLAUDE_PROFILE_ID);
  const restored = await store.list();
  assert.equal(restored.some((profile) => profile.id === DEFAULT_CLAUDE_PROFILE_ID), true);
  assert.equal(restored[0].id, DEFAULT_CLAUDE_PROFILE_ID);
  assert.ok(restored.some((profile) => profile.name === "Work"));
  assert.ok(restored.some((profile) => profile.id === DEFAULT_CODEX_PROFILE_ID));
});

test("legacy profiles without provider migrate to claude-code on read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-legacy-"));
  await writeFile(join(directory, "claude-profiles.v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    profiles: [{
      schemaVersion: 1,
      id: "legacy-1",
      name: "Legacy",
      binaryPath: "claude",
      homePath: "",
      environment: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`, "utf8");
  const store = new ClaudeProfileStore(directory);
  const profiles = await store.list();
  const legacy = profiles.find((profile) => profile.id === "legacy-1");
  assert.equal(legacy?.provider, "claude-code");
  assert.equal(profiles.length, 4); // legacy + 3 builtins
});

test("adapter install seed creates a stable empty-capable default profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-profiles-adapter-"));
  const store = new ClaudeProfileStore(directory);
  const seeded = await store.ensureProviderDefault({
    provider: "adapter:dev.kiro.cli@1.2.3",
    name: "Kiro",
    binaryPath: "kiro-cli",
    environment: [
      { name: "KIRO_TOKEN", sensitive: true, value: "" },
    ],
  });
  assert.equal(seeded.id, "default:adapter:dev.kiro.cli");
  assert.equal(seeded.provider, "adapter:dev.kiro.cli@1.2.3");
  assert.equal(seeded.binaryPath, "kiro-cli");
  assert.equal(seeded.environment.some((entry) => entry.name === "KIRO_TOKEN" && entry.sensitive), true);
  // Re-seed is idempotent and does not overwrite edits.
  await store.save({
    id: seeded.id,
    name: "Kiro custom",
    binaryPath: "/opt/kiro",
    provider: seeded.provider,
    environment: [],
  });
  const again = await store.ensureProviderDefault({
    provider: "adapter:dev.kiro.cli@9.9.9",
    name: "Kiro",
    binaryPath: "kiro-cli",
  });
  assert.equal(again.id, "default:adapter:dev.kiro.cli");
  assert.equal(again.name, "Kiro custom");
  assert.equal(again.binaryPath, "/opt/kiro");
  assert.equal(defaultProfileId("adapter:dev.kiro.cli@1.0.0"), "default:adapter:dev.kiro.cli");
});

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
  // Built-in defaults remain available after user profile deletion.
  const remaining = await store.list();
  assert.equal(remaining.some((profile) => profile.id === DEFAULT_CLAUDE_PROFILE_ID), true);
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
  const saved = await store.save({ name: "Ready", binaryPath: executable, provider: "claude-code" });

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
  const saved = await store.save({ name: "Signed out", binaryPath: executable, provider: "claude-code" });
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
