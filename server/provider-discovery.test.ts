import assert from "node:assert/strict";
import test from "node:test";
import { ProviderDiscovery, type ProviderDiscoveryDependencies } from "./provider-discovery.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

function adapter(): InstalledProviderAdapter {
  return {
    schemaVersion: 1,
    source: "/redacted/adapter.json",
    digest: "a".repeat(64),
    enabled: true,
    installedAt: "2026-08-10T00:00:00.000Z",
    manifest: {
      schemaVersion: 1,
      id: "fixture",
      publisher: { name: "Fixture" },
      version: "1.0.0",
      aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
      protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
      executable: { names: ["fixture"], arguments: ["--acp"] },
      capabilities: { tools: true, images: false, sessionResume: true },
      environment: [{ name: "FIXTURE_TOKEN", required: true, sensitive: true }],
      presentation: { name: "Fixture ACP", description: "Fixture adapter" },
    },
  };
}

function dependencies(
  overrides: Partial<ProviderDiscoveryDependencies> = {},
): ProviderDiscoveryDependencies {
  return {
    codex: {
      readiness: async () => ({
        id: "codex-cli",
        installed: true,
        authenticated: true,
        version: "1.0.0",
        models: [],
        detail: null,
      }),
    },
    shikigami: {
      readiness: async () => ({
        id: "shikigami",
        installed: true,
        authenticated: true,
        version: "1.0.5",
        models: [{ id: "fixture-model", displayName: "Fixture model", isDefault: true }],
        name: "Shikigami",
        detail: null,
      }),
    },
    profiles: {
      list: async () => [
        {
          id: "default:shikigami",
          name: "Shikigami",
          provider: "shikigami",
          binaryPath: "shikigami",
          homePath: "",
          configPath: "",
          environment: [],
          probes: {},
        },
      ],
      runtime: async () => ({
        executable: "shikigami",
        configPath: undefined,
        environment: {},
      }),
    } as ProviderDiscoveryDependencies["profiles"],
    adapters: {
      list: async () => [adapter()],
      resolveExecutable: async () => "/usr/bin/fixture",
    },
    environment: { FIXTURE_TOKEN: "secret" },
    ...overrides,
  };
}

test("discovery sends one authorized cwd to Shikigami and declarative ACP probes", async () => {
  const observed: string[] = [];
  const discovery = new ProviderDiscovery(
    dependencies({
      shikigami: {
        readiness: async (_environment, options) => {
          observed.push(options.cwd);
          return {
            id: "shikigami",
            installed: true,
            authenticated: true,
            version: "1.0.5",
            models: [],
            name: "Shikigami",
            detail: null,
          };
        },
      },
      probeAcpModels: async (options) => {
        observed.push(options.cwd);
        return [
          {
            id: "worktree-model",
            displayName: "Worktree model",
            isDefault: true,
            reasoningEfforts: [],
            defaultReasoningEffort: "medium",
          },
        ];
      },
    }),
  );

  const result = await discovery.discover({ cwd: "/authorized/worktree" });

  assert.deepEqual(observed, ["/authorized/worktree", "/authorized/worktree"]);
  assert.deepEqual(
    result.providers.map((provider) => provider.id),
    ["claude-code", "codex-cli", "shikigami", "adapter:fixture@1.0.0"],
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("managed discovery exposes only configured Shikigami without local probes", async () => {
  let probed = false;
  const discovery = new ProviderDiscovery(
    dependencies({
      managedModel: "managed-model",
      codex: {
        readiness: async () => {
          probed = true;
          throw new Error("unexpected");
        },
      },
      adapters: {
        list: async () => {
          probed = true;
          return [];
        },
        resolveExecutable: async () => {
          probed = true;
          return "/unexpected";
        },
      },
    }),
  );

  const result = await discovery.discover({ cwd: "/managed/worktree" });

  assert.equal(probed, false);
  assert.deepEqual(
    result.providers.map((provider) => provider.id),
    ["shikigami"],
  );
  assert.deepEqual(result.providers[0]?.models, [
    {
      id: "managed-model",
      displayName: "managed-model",
      isDefault: true,
    },
  ]);
});

test("provider-local failures remain unavailable results instead of failing discovery", async () => {
  const discovery = new ProviderDiscovery(
    dependencies({
      codex: {
        readiness: async () => {
          throw new Error("private failure");
        },
      },
      profiles: {
        list: async () => [{ id: "default:shikigami", provider: "shikigami" }],
        runtime: async () => {
          throw new Error("profile unavailable");
        },
      } as ProviderDiscoveryDependencies["profiles"],
      probeAcpModels: async () => {
        throw new Error("probe unavailable");
      },
    }),
  );

  const result = await discovery.discover({ cwd: "/authorized/worktree" });
  const codex = result.providers.find((provider) => provider.id === "codex-cli");
  const shikigami = result.providers.find((provider) => provider.id === "shikigami");
  const declarative = result.providers.find((provider) => provider.id === "adapter:fixture@1.0.0");

  assert.equal(codex?.installed, false);
  assert.equal(shikigami?.installed, false);
  assert.deepEqual(declarative?.models, []);
});
