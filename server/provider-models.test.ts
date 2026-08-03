import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  claudeModelCatalog,
  discoverProviderModels,
  ProviderModelError,
  resolveEffectiveProviderModel,
  validateProviderModel,
  type ProviderModelServices,
} from "./provider-models.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

const execFileAsync = promisify(execFile);

function codexModel(id: string, isDefault = false) {
  return {
    id,
    displayName: id,
    isDefault,
    reasoningEfforts: ["low", "medium"] as const,
    defaultReasoningEffort: "medium" as const,
  };
}

function shikigamiModel(id: string, isDefault = false) {
  return { id, displayName: id, isDefault };
}

function services(overrides: Partial<ProviderModelServices> = {}): ProviderModelServices {
  return {
    codex: {
      readiness: async () => ({
        id: "codex-cli",
        installed: true,
        authenticated: true,
        version: "0.99.0",
        models: [codexModel("gpt-5", true)],
        detail: null,
      }),
    },
    shikigami: {
      readiness: async () => ({
        id: "shikigami",
        installed: true,
        authenticated: true,
        version: "1.0.5",
        models: [shikigamiModel("scripted", true)],
        name: "Shikigami",
        detail: null,
      }),
    },
    adapters: {
      version: async () => null,
      resolveExecutable: async () => process.execPath,
    },
    ...overrides,
  };
}

test("effective model resolution normalizes Claude aliases and provider defaults", () => {
  assert.equal(
    resolveEffectiveProviderModel("claude-code", "default", claudeModelCatalog()),
    "default",
  );
  assert.equal(
    resolveEffectiveProviderModel("claude-code", "sonnet", claudeModelCatalog()),
    "claude-sonnet-5",
  );
  assert.equal(
    resolveEffectiveProviderModel("codex-cli", "default", [codexModel("gpt-5", true)]),
    "gpt-5",
  );
  assert.equal(
    resolveEffectiveProviderModel("shikigami", "scripted", [shikigamiModel("scripted", true)]),
    "scripted",
  );
});

test("stale and unknown models return bounded refreshable conflicts", () => {
  assert.throws(
    () => resolveEffectiveProviderModel("codex-cli", "old-model", [codexModel("new-model", true)]),
    (error: unknown) => error instanceof ProviderModelError
      && error.status === 409
      && /Refresh provider discovery and retry/.test(error.message),
  );
  assert.throws(
    () => resolveEffectiveProviderModel("codex-cli", "default", []),
    (error: unknown) => error instanceof ProviderModelError
      && /model discovery is unavailable/.test(error.message),
  );
});

test("run-boundary validation rechecks changed provider capability", async () => {
  let advertised = [codexModel("model-a", true)];
  const current = services({
    codex: { readiness: async () => ({
      id: "codex-cli",
      installed: true,
      authenticated: true,
      version: "0.99.0",
      models: advertised,
      detail: null,
    }) },
  });
  assert.equal(await validateProviderModel("codex-cli", "model-a", current, "."), "model-a");
  advertised = [codexModel("model-b", true)];
  await assert.rejects(
    () => validateProviderModel("codex-cli", "model-a", current, "."),
    (error: unknown) => error instanceof ProviderModelError && error.status === 409,
  );
});

test("reviewed adapter models come from a live ACP probe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-models-"));
  await execFileAsync("git", ["init", "-q"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  await execFileAsync("git", ["config", "user.name", "Aldunis Test"], { cwd: directory });
  await writeFile(join(directory, ".gitignore"), "ignored.txt\n");
  await writeFile(join(directory, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: directory });
  await execFileAsync("git", ["commit", "-qm", "baseline"], { cwd: directory });
  await writeFile(join(directory, "untracked.txt"), "current\n");
  await writeFile(join(directory, "model-config.json"), "current\n");
  await writeFile(join(directory, "ignored.txt"), "secret\n");
  await mkdir(join(directory, "shared"));
  await mkdir(join(directory, "packages", "app"), { recursive: true });
  await writeFile(join(directory, "shared", "config.txt"), "current\n");
  await symlink("../../shared/config.txt", join(directory, "packages", "app", "config.txt"));
  const executable = join(directory, "fake-acp");
  await writeFile(executable, `#!/usr/bin/env node
  const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({
    jsonrpc: "2.0", id: msg.id,
    result: { protocolVersion: 1, agentCapabilities: {} },
  }) + "\\n");
  if (msg.method === "session/new") {
    let isWorktree = "";
    let hasTrackedFile = false;
    try {
      isWorktree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: msg.params.cwd,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["ls-files", "--error-unmatch", "tracked.txt"], {
        cwd: msg.params.cwd,
        encoding: "utf8",
      });
      hasTrackedFile = true;
    } catch {}
    const hasCurrentFiles = existsSync(join(msg.params.cwd, "tracked.txt"))
      && existsSync(join(msg.params.cwd, "untracked.txt"))
      && existsSync(join(msg.params.cwd, "model-config.json"))
      && !existsSync(join(msg.params.cwd, "ignored.txt"))
      && existsSync(join(msg.params.cwd, "packages", "app", "config.txt"));
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: msg.id,
      result: { sessionId: "probe", models: isWorktree === "true" && hasTrackedFile && hasCurrentFiles ? {
        currentModelId: "model-b",
        availableModels: [{ modelId: "model-a", name: msg.params.cwd }, { modelId: "model-b", name: process.cwd() }],
      } : {} },
    }) + "\\n");
  }
});
`);
  await chmod(executable, 0o700);
  const adapter = {
    schemaVersion: 1,
    source: "fixture",
    digest: "fixture-digest",
    enabled: true,
    installedAt: new Date(0).toISOString(),
    manifest: {
      schemaVersion: 1,
      id: "fixture",
      publisher: { name: "Fixture" },
      version: "1.0.0",
      aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
      protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
      executable: { names: ["fake-acp"], arguments: [] },
      capabilities: { tools: false, images: false, sessionResume: false },
      environment: [],
      presentation: { name: "Fixture", description: "Fixture adapter" },
    },
  } as InstalledProviderAdapter;
  const provider = "adapter:fixture@1.0.0" as const;
  const discovered = await discoverProviderModels(provider, services({
    adapters: {
      version: async () => adapter,
      resolveExecutable: async () => executable,
    },
  }), directory);
  assert.deepEqual(discovered.map((model) => ({ id: model.id, isDefault: model.isDefault })), [
    { id: "model-a", isDefault: false },
    { id: "model-b", isDefault: true },
  ]);
  assert.match(discovered[0]!.displayName, /aldunis-provider-model-session-/);
  assert.match(discovered[1]!.displayName, /aldunis-provider-model-probe-/);
  assert.notEqual(discovered[0]!.displayName, directory);
  assert.notEqual(discovered[1]!.displayName, directory);
  assert.equal(resolveEffectiveProviderModel(provider, "default", discovered), "model-b");
});

test("Shikigami model discovery uses the selected profile runtime", async () => {
  let received: {
    environment?: NodeJS.ProcessEnv;
    executable?: string;
    configPath?: string;
    cwd?: string;
  } | undefined;
  const discovered = await discoverProviderModels("shikigami", services({
    shikigami: {
      readiness: async (environment, options) => {
        received = { environment, ...options };
        return {
          id: "shikigami",
          installed: true,
          authenticated: true,
          version: "1.0.5",
          models: [shikigamiModel("profile-model", true)],
          name: "Shikigami",
          detail: null,
        };
      },
    },
    shikigamiProfile: {
      executable: "/profile/shikigami",
      environment: { SHIKIGAMI_MODEL_ADAPTER: "scripted" },
      configPath: "/profile/shikigami.toml",
    },
  }), "/selected/worktree");
  assert.deepEqual(received, {
    environment: { SHIKIGAMI_MODEL_ADAPTER: "scripted" },
    executable: "/profile/shikigami",
    configPath: "/profile/shikigami.toml",
    cwd: "/selected/worktree",
  });
  assert.equal(resolveEffectiveProviderModel("shikigami", "default", discovered), "profile-model");
});
