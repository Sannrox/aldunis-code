import type { ProviderDiscovery, ProviderId } from "../types";

export interface ProviderModelOption {
  id: string;
  displayName: string;
}

const CLAUDE_MODELS: ProviderModelOption[] = [
  { id: "default", displayName: "default" },
  { id: "sonnet", displayName: "sonnet" },
  { id: "opus", displayName: "opus" },
  { id: "haiku", displayName: "haiku" },
];

/**
 * Composer / chip copy when a selected provider cannot start a run.
 * Prefer discovery.detail when the host already explained the gap.
 */
export function providerNotReadyMessage(
  provider: ProviderId,
  discovery: ProviderDiscovery | undefined,
  options: { hasClaudeProfile: boolean; providerName: string },
): string {
  if (discovery?.detail?.trim()) return discovery.detail.trim();

  if (provider === "claude-code") {
    return options.hasClaudeProfile
      ? "Claude Code is not ready…"
      : "Configure a Claude profile first…";
  }

  if (provider === "codex-cli") {
    if (!discovery || discovery.installed === false) {
      return "Install Codex CLI on PATH and sign in…";
    }
    if (discovery.authenticated === false) {
      return "Sign in to Codex CLI (codex login)…";
    }
    return "Codex CLI is not ready…";
  }

  if (provider === "shikigami") {
    if (!discovery || discovery.installed === false) {
      return "Install shikigami 1.0.2+ on PATH…";
    }
    if (discovery.authenticated === false) {
      return "Shikigami needs an API key (or SHIKIGAMI_MODEL_ADAPTER=scripted)…";
    }
    return "Shikigami is not ready…";
  }

  if (typeof provider === "string" && provider.startsWith("adapter:")) {
    if (discovery?.enabled === false) {
      return `${options.providerName} is disabled in Provider adapters…`;
    }
    if (!discovery || discovery.installed === false) {
      return `Install the ${options.providerName} adapter CLI…`;
    }
    if (discovery.authenticated === false) {
      return `${options.providerName} needs its CLI on PATH and required env…`;
    }
  }

  return `${options.providerName} is not ready…`;
}

/** Models the composer chip can cycle for the selected provider. */
export function providerModelOptions(
  provider: ProviderId,
  discovery: ProviderDiscovery | undefined,
): ProviderModelOption[] {
  if (provider === "claude-code") return CLAUDE_MODELS;

  const discovered = discovery?.models ?? [];
  if (discovered.length === 0) {
    return [{ id: "default", displayName: "default" }];
  }

  const options = discovered.map((model) => ({
    id: model.id,
    displayName: model.displayName || model.id,
  }));

  // Keep an explicit default entry when discovery did not list one.
  if (!options.some((entry) => entry.id === "default")) {
    return [{ id: "default", displayName: "default" }, ...options];
  }
  return options;
}

export function cycleProviderModel(
  provider: ProviderId,
  currentModel: string,
  discovery: ProviderDiscovery | undefined,
): string {
  const options = providerModelOptions(provider, discovery);
  if (options.length <= 1) return options[0]?.id ?? currentModel;
  const index = options.findIndex((entry) => entry.id === currentModel);
  const next = options[(index + 1) % options.length] ?? options[0]!;
  return next.id;
}

export function providerModelLabel(
  provider: ProviderId,
  model: string,
  discovery: ProviderDiscovery | undefined,
): string {
  if (model === "default") return "default";
  const match = providerModelOptions(provider, discovery).find((entry) => entry.id === model);
  return match?.displayName ?? model;
}
