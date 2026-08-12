import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES,
  MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES,
  ProviderDiscovery,
  type ProviderDiscoveryDependencies,
} from "./provider-discovery.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

function adapter(id = "fixture"): InstalledProviderAdapter {
  return {
    schemaVersion: 1,
    source: "/redacted/adapter.json",
    digest: "a".repeat(64),
    enabled: true,
    installedAt: "2026-08-10T00:00:00.000Z",
    manifest: {
      schemaVersion: 1,
      id,
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

test("declarative adapter discovery preserves order within a fixed concurrency bound", async () => {
  const adapterCount = MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES * 2;
  const adapters = Array.from({ length: adapterCount }, (_, index) => adapter(`fixture-${index}`));
  let active = 0;
  let peak = 0;
  const entered: string[] = [];
  const releases: Array<() => void> = [];
  const discovery = new ProviderDiscovery(
    dependencies({
      adapters: {
        list: async () => adapters,
        resolveExecutable: async (installed) => {
          active += 1;
          peak = Math.max(peak, active);
          entered.push(installed.manifest.id);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return `/usr/bin/${installed.manifest.id}`;
        },
      },
      environment: { FIXTURE_TOKEN: "secret" },
      probeAcpModels: async () => [],
    }),
  );

  const pending = discovery.discover({ cwd: "/authorized/worktree" });
  while (entered.length < MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(active, MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES);
  assert.equal(peak, MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES);

  while (releases.length > 0) releases.shift()?.();
  while (entered.length < adapterCount) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES);
  while (releases.length > 0) releases.shift()?.();

  const result = await pending;
  assert.deepEqual(
    result.providers.slice(3).map((provider) => provider.id),
    adapters.map((installed) => `adapter:${installed.manifest.id}@1.0.0`),
  );
});

test("failed declarative adapter resolution does not strand queued discovery work", async () => {
  const adapterCount = MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES * 2;
  const adapters = Array.from({ length: adapterCount }, (_, index) => adapter(`fixture-${index}`));
  const attempted: string[] = [];
  const discovery = new ProviderDiscovery(
    dependencies({
      adapters: {
        list: async () => adapters,
        resolveExecutable: async (installed) => {
          attempted.push(installed.manifest.id);
          if (attempted.length <= MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES) {
            throw new Error("adapter unavailable");
          }
          return `/usr/bin/${installed.manifest.id}`;
        },
      },
      environment: { FIXTURE_TOKEN: "secret" },
      probeAcpModels: async () => [],
    }),
  );

  const result = await discovery.discover({ cwd: "/authorized/worktree" });

  assert.deepEqual(
    attempted.slice().sort(),
    adapters.map((installed) => installed.manifest.id).sort(),
  );
  assert.equal(result.providers.slice(3).length, adapterCount);
});

test("discovery cancellation stops queued declarative adapters", async () => {
  const adapterCount = MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES * 2;
  const adapters = Array.from({ length: adapterCount }, (_, index) => adapter(`fixture-${index}`));
  const entered: string[] = [];
  const releases: Array<() => void> = [];
  const controller = new AbortController();
  const discovery = new ProviderDiscovery(
    dependencies({
      adapters: {
        list: async () => adapters,
        resolveExecutable: async (installed) => {
          entered.push(installed.manifest.id);
          await new Promise<void>((resolve) => releases.push(resolve));
          return `/usr/bin/${installed.manifest.id}`;
        },
      },
      environment: { FIXTURE_TOKEN: "secret" },
    }),
  );

  const pending = discovery.discover({ cwd: "/authorized/worktree", signal: controller.signal });
  while (entered.length < MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  while (releases.length > 0) releases.shift()?.();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  assert.equal(entered.length, MAX_CONCURRENT_DECLARATIVE_ADAPTER_DISCOVERIES);
});

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

test("Shikigami profile discovery preserves order within a fixed concurrency bound", async () => {
  const profileCount = MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES * 2;
  const profiles = Array.from({ length: profileCount }, (_, index) => ({
    id: index === 0 ? "default:shikigami" : `shikigami-${index}`,
    provider: "shikigami",
  }));
  let active = 0;
  let peak = 0;
  const entered: number[] = [];
  const releases: Array<() => void> = [];
  const discovery = new ProviderDiscovery(
    dependencies({
      profiles: {
        list: async () => profiles,
        runtime: async (id: string) => ({
          executable: id,
          configPath: undefined,
          environment: {},
        }),
      } as ProviderDiscoveryDependencies["profiles"],
      shikigami: {
        readiness: async (_environment, options) => {
          const index = profiles.findIndex((profile) => profile.id === options.executable);
          active += 1;
          peak = Math.max(peak, active);
          entered.push(index);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return {
            id: "shikigami",
            installed: true,
            authenticated: true,
            version: `1.0.${index + 2}`,
            models: [],
            name: "Shikigami",
            detail: null,
          };
        },
      },
    }),
  );

  const pending = discovery.discover({ cwd: "/authorized/worktree" });
  while (entered.length < MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(active, MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES);
  assert.equal(peak, MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES);
  assert.deepEqual(
    entered,
    Array.from({ length: MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES }, (_, index) => index),
  );

  while (releases.length > 0) releases.shift()?.();
  while (entered.length < profileCount) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES);
  while (releases.length > 0) releases.shift()?.();

  const result = await pending;
  const shikigami = result.providers.find((provider) => provider.id === "shikigami");
  assert.deepEqual(
    shikigami?.profileDiscoveries?.map((profile) => profile.profileId),
    profiles.map((profile) => profile.id),
  );
  assert.deepEqual(
    entered,
    Array.from({ length: profileCount }, (_, index) => index),
  );
});

test("failed Shikigami profiles do not strand queued discovery work", async () => {
  const profileCount = MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES * 2;
  const profiles = Array.from({ length: profileCount }, (_, index) => ({
    id: index === 0 ? "default:shikigami" : `shikigami-${index}`,
    provider: "shikigami",
  }));
  const attempted: string[] = [];
  const discovery = new ProviderDiscovery(
    dependencies({
      profiles: {
        list: async () => profiles,
        runtime: async (id: string) => {
          attempted.push(id);
          const index = profiles.findIndex((profile) => profile.id === id);
          if (index < MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES) {
            throw new Error("profile unavailable");
          }
          return { executable: id, configPath: undefined, environment: {} };
        },
      } as ProviderDiscoveryDependencies["profiles"],
    }),
  );

  const result = await discovery.discover({ cwd: "/authorized/worktree" });
  const shikigami = result.providers.find((provider) => provider.id === "shikigami");

  assert.deepEqual(
    attempted,
    profiles.map((profile) => profile.id),
  );
  assert.deepEqual(
    shikigami?.profileDiscoveries?.map((profile) => profile.profileId),
    profiles.map((profile) => profile.id),
  );
  assert.deepEqual(
    shikigami?.profileDiscoveries
      ?.slice(0, MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES)
      .map((profile) => profile.installed),
    Array(MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES).fill(false),
  );
});

test("discovery cancellation stops queued Shikigami profiles and remains cancellation", async () => {
  const profileCount = MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES * 2;
  const profiles = Array.from({ length: profileCount }, (_, index) => ({
    id: index === 0 ? "default:shikigami" : `shikigami-${index}`,
    provider: "shikigami",
  }));
  const entered: string[] = [];
  const observedSignals: AbortSignal[] = [];
  const controller = new AbortController();
  const discovery = new ProviderDiscovery(
    dependencies({
      codex: {
        readiness: async (signal?: AbortSignal) => {
          if (signal) observedSignals.push(signal);
          return dependencies().codex.readiness();
        },
      },
      profiles: {
        list: async () => profiles,
        runtime: async (id: string) => ({
          executable: id,
          configPath: undefined,
          environment: {},
        }),
      } as ProviderDiscoveryDependencies["profiles"],
      shikigami: {
        readiness: async (_environment, options) => {
          entered.push(options.executable ?? "");
          assert.ok(options.signal);
          observedSignals.push(options.signal);
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
          throw new Error("unreachable");
        },
      },
      probeAcpModels: async (options) => {
        assert.ok(options.signal);
        observedSignals.push(options.signal);
        return [];
      },
    }),
  );

  const pending = discovery.discover({ cwd: "/authorized/worktree", signal: controller.signal });
  while (entered.length < MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  assert.equal(entered.length, MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES);
  assert.ok(observedSignals.length > MAX_CONCURRENT_SHIKIGAMI_PROFILE_DISCOVERIES);
  assert.ok(observedSignals.every((signal) => signal === controller.signal && signal.aborted));
});
