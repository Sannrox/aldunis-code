import type { CodexCliAdapter, CodexModel } from "./codex-provider.ts";
import { buildAcpEnvironment } from "./acp-provider.ts";
import { probeAcpModels, type AcpDiscoveredModel } from "./acp-models.ts";
import type { ProviderAdapterStore } from "./provider-adapters.ts";
import type { ProviderId, ReasoningEffort } from "./provider.ts";
import {
  CLAUDE_PROBE_MODELS,
  normalizeClaudeModelSlug,
} from "./profiles.ts";
import type { ShikigamiAdapter, ShikigamiModel } from "./shikigami-provider.ts";

export interface ProviderModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export class ProviderModelError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export interface ProviderModelServices {
  codex: Pick<CodexCliAdapter, "readiness">;
  shikigami: Pick<ShikigamiAdapter, "readiness">;
  adapters: Pick<ProviderAdapterStore, "version" | "resolveExecutable">;
  environment?: NodeJS.ProcessEnv;
}

function providerName(provider: ProviderId): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex-cli") return "Codex";
  if (provider === "shikigami") return "Shikigami";
  return "the selected provider";
}

function modelConflict(provider: ProviderId): ProviderModelError {
  return new ProviderModelError(
    `${providerName(provider)} did not advertise the selected model. Refresh provider discovery and retry.`,
  );
}

function discoveryUnavailable(provider: ProviderId): ProviderModelError {
  return new ProviderModelError(
    `${providerName(provider)} model discovery is unavailable. Refresh provider discovery and retry.`,
  );
}

function normalizeModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models
    .filter((model) => typeof model.id === "string" && model.id.trim())
    .map((model) => ({
      ...model,
      id: model.id.trim(),
      displayName: model.displayName.trim() || model.id.trim(),
    }));
}

export function claudeModelCatalog(): ProviderModel[] {
  return CLAUDE_PROBE_MODELS.map((id, index) => ({
    id,
    displayName: id,
    isDefault: index === 0,
  }));
}

export function resolveEffectiveProviderModel(
  provider: ProviderId,
  requestedModel: string,
  models: readonly ProviderModel[],
): string {
  if (
    typeof requestedModel !== "string"
    || !requestedModel.trim()
    || requestedModel.length > 256
    || requestedModel.includes("\0")
  ) {
    throw modelConflict(provider);
  }
  const available = normalizeModels(models);
  if (available.length === 0) throw discoveryUnavailable(provider);
  if (requestedModel.trim() === "default") {
    // Claude's CLI owns the default-model decision. Keep the token implicit so
    // account configuration and provider updates remain authoritative.
    if (provider === "claude-code") return "default";
    return available.find((model) => model.isDefault)?.id ?? available[0]!.id;
  }
  const requested = provider === "claude-code"
    ? normalizeClaudeModelSlug(requestedModel)
    : requestedModel.trim();
  const match = available.find((model) => model.id === requested);
  if (!match) throw modelConflict(provider);
  return match.id;
}

function mapCodexModels(models: readonly CodexModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

function mapShikigamiModels(models: readonly ShikigamiModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
  }));
}

function mapAcpModels(models: readonly AcpDiscoveredModel[]): ProviderModel[] {
  return models.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    isDefault: model.isDefault,
    reasoningEfforts: model.reasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
  }));
}

async function discoverAdapterModels(
  provider: ProviderId,
  services: ProviderModelServices,
  cwd: string,
): Promise<ProviderModel[]> {
  const installed = await services.adapters.version(provider);
  if (!installed || !installed.enabled) throw discoveryUnavailable(provider);
  let executable: string;
  let environment: NodeJS.ProcessEnv;
  try {
    executable = await services.adapters.resolveExecutable(installed);
    environment = buildAcpEnvironment(installed, services.environment);
  } catch {
    throw discoveryUnavailable(provider);
  }
  const models = await probeAcpModels({
    executable,
    arguments: installed.manifest.executable.arguments,
    environment,
    cwd,
    timeoutMs: 8_000,
  }).catch(() => []);
  if (models.length === 0) throw discoveryUnavailable(provider);
  return mapAcpModels(models);
}

export async function discoverProviderModels(
  provider: ProviderId,
  services: ProviderModelServices,
  cwd: string,
): Promise<ProviderModel[]> {
  if (provider === "claude-code") return claudeModelCatalog();
  if (provider === "codex-cli") {
    const readiness = await services.codex.readiness().catch(() => null);
    if (!readiness?.installed || !readiness.authenticated || readiness.models.length === 0) {
      throw discoveryUnavailable(provider);
    }
    return mapCodexModels(readiness.models);
  }
  if (provider === "shikigami") {
    const readiness = await services.shikigami.readiness().catch(() => null);
    if (!readiness?.installed || !readiness.authenticated || readiness.models.length === 0) {
      throw discoveryUnavailable(provider);
    }
    return mapShikigamiModels(readiness.models);
  }
  return discoverAdapterModels(provider, services, cwd);
}

export async function validateProviderModel(
  provider: ProviderId,
  requestedModel: string,
  services: ProviderModelServices,
  cwd: string,
): Promise<string> {
  const models = await discoverProviderModels(provider, services, cwd);
  return resolveEffectiveProviderModel(provider, requestedModel, models);
}

export function isAdapterProviderId(value: string): value is `adapter:${string}@${string}` {
  return value.startsWith("adapter:") && value.includes("@");
}
