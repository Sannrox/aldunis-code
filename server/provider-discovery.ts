import type { AcpDiscoveredModel } from "./acp-models.ts";
import { probeAcpModels } from "./acp-models.ts";
import type { ProviderDiscovery as ProviderDiscoverySnapshot } from "../src/types.ts";
import type { CodexCliAdapter, CodexReadiness } from "./codex-provider.ts";
import { adapterReference, type ProviderAdapterStore } from "./provider-adapters.ts";
import { claudeModelCatalog } from "./provider-models.ts";
import { ProviderProtocolError } from "./provider.ts";
import { DEFAULT_SHIKIGAMI_PROFILE_ID, type ClaudeProfileStore } from "./profiles.ts";
import { type ShikigamiAdapter, type ShikigamiReadiness } from "./shikigami-provider.ts";

export interface ProviderDiscoveryResult {
  providers: ProviderDiscoverySnapshot[];
}

export interface ProviderDiscoveryDependencies {
  codex: Pick<CodexCliAdapter, "readiness">;
  shikigami: Pick<ShikigamiAdapter, "readiness">;
  profiles: Pick<ClaudeProfileStore, "list" | "runtime">;
  adapters: Pick<ProviderAdapterStore, "list" | "resolveExecutable">;
  environment?: NodeJS.ProcessEnv;
  managedModel?: string;
  probeAcpModels?: typeof probeAcpModels;
}

function unavailableShikigamiReadiness(detail: string): ShikigamiReadiness {
  return {
    id: "shikigami",
    installed: false,
    authenticated: false,
    version: null,
    models: [],
    name: "Shikigami",
    detail,
  };
}

/**
 * Presentation-only readiness for declarative adapters. Run authorization
 * still validates the selected adapter and environment independently.
 */
export function declarativeAdapterReadiness(options: {
  name: string;
  enabled: boolean;
  executableFound: boolean;
  executableNames: string[];
  missingRequiredEnv: string[];
}): { authenticated: boolean; detail: string | null } {
  const { name, enabled, executableFound, executableNames, missingRequiredEnv } = options;
  if (!enabled) {
    return { authenticated: false, detail: `${name} is disabled in Provider adapters.` };
  }
  if (!executableFound) {
    const binaries = executableNames.length > 0 ? executableNames.join(" or ") : "the adapter CLI";
    return { authenticated: false, detail: `Install ${binaries} on PATH for ${name}.` };
  }
  if (missingRequiredEnv.length > 0) {
    return {
      authenticated: false,
      detail: `Set required env for ${name}: ${missingRequiredEnv.join(", ")}.`,
    };
  }
  return { authenticated: true, detail: null };
}

export class ProviderDiscovery {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly acpProbe: typeof probeAcpModels;

  constructor(private readonly dependencies: ProviderDiscoveryDependencies) {
    this.environment = dependencies.environment ?? process.env;
    this.acpProbe = dependencies.probeAcpModels ?? probeAcpModels;
  }

  async discover(context: { cwd: string }): Promise<ProviderDiscoveryResult> {
    if (this.dependencies.managedModel) {
      return {
        providers: [
          {
            id: "shikigami",
            installed: true,
            authenticated: true,
            version: "1.0.5+",
            name: "Shikigami",
            detail: null,
            models: [
              {
                id: this.dependencies.managedModel,
                displayName: this.dependencies.managedModel,
                isDefault: true,
              },
            ],
          },
        ],
      };
    }

    const [codexReadiness, declarativeProviders, shikigamiReadiness] = await Promise.all([
      this.discoverCodex(),
      this.discoverDeclarative(context.cwd),
      this.discoverShikigami(context.cwd),
    ]);
    return {
      providers: [
        { id: "claude-code", installed: true, models: claudeModelCatalog() },
        codexReadiness,
        shikigamiReadiness,
        ...declarativeProviders,
      ],
    };
  }

  private async discoverCodex(): Promise<CodexReadiness> {
    return this.dependencies.codex.readiness().catch(() => ({
      id: "codex-cli" as const,
      installed: false,
      authenticated: false,
      version: null,
      models: [],
      detail: "Install Codex CLI on PATH and sign in (codex login).",
    }));
  }

  private async discoverDeclarative(cwd: string): Promise<ProviderDiscoverySnapshot[]> {
    const installed = await this.dependencies.adapters.list();
    return Promise.all(
      installed.map(async (adapter) => {
        const executablePath = await this.dependencies.adapters
          .resolveExecutable(adapter)
          .catch(() => null);
        const missingRequiredEnv = adapter.manifest.environment
          .filter((entry) => entry.required)
          .filter((entry) => {
            const value = this.environment[entry.name];
            return value === undefined || value === "";
          })
          .map((entry) => entry.name);
        const readiness = declarativeAdapterReadiness({
          name: adapter.manifest.presentation.name,
          enabled: adapter.enabled,
          executableFound: executablePath !== null,
          executableNames: adapter.manifest.executable.names,
          missingRequiredEnv,
        });
        let models: AcpDiscoveredModel[] = [];
        if (readiness.authenticated && executablePath) {
          const environment: NodeJS.ProcessEnv = { ...this.environment };
          for (const reference of adapter.manifest.environment) {
            const value = this.environment[reference.name];
            if (value !== undefined) environment[reference.name] = value;
          }
          models = await this.acpProbe({
            executable: executablePath,
            arguments: adapter.manifest.executable.arguments,
            environment,
            cwd,
            timeoutMs: 8_000,
          }).catch(() => []);
        }
        return {
          id: adapterReference(adapter.manifest),
          installed: true,
          // Retain the existing wire contract: authenticated means run-ready.
          authenticated: readiness.authenticated,
          version: adapter.manifest.version,
          name: adapter.manifest.presentation.name,
          enabled: adapter.enabled,
          detail: readiness.detail,
          models,
        };
      }),
    );
  }

  private async discoverShikigami(cwd: string): Promise<ProviderDiscoverySnapshot> {
    const profiles = (await this.dependencies.profiles.list().catch(() => [])).filter(
      (profile) => profile.provider === "shikigami",
    );
    const profileDiscoveries = await Promise.all(
      profiles.map(async (profile) => {
        let readiness: ShikigamiReadiness;
        try {
          const runtime = await this.dependencies.profiles.runtime(profile.id);
          readiness = await this.dependencies.shikigami.readiness(runtime.environment, {
            executable: runtime.executable,
            configPath: runtime.configPath,
            cwd,
          });
        } catch (error) {
          readiness = unavailableShikigamiReadiness(
            error instanceof ProviderProtocolError
              ? error.message
              : "The selected Shikigami profile could not be checked.",
          );
        }
        return {
          profileId: profile.id,
          installed: readiness.installed,
          authenticated: readiness.authenticated,
          version: readiness.version,
          detail: readiness.detail,
          models: readiness.models,
        };
      }),
    );
    const selected = profileDiscoveries.find(
      (profile) => profile.profileId === DEFAULT_SHIKIGAMI_PROFILE_ID,
    );
    const readiness = selected
      ? {
          id: "shikigami" as const,
          installed: selected.installed,
          authenticated: selected.authenticated,
          version: selected.version,
          models: selected.models,
          name: "Shikigami",
          detail: selected.detail,
        }
      : unavailableShikigamiReadiness(
          "Install shikigami 1.0.2+ on PATH (tenkai or GitHub Release).",
        );
    return { ...readiness, profileDiscoveries };
  }
}
