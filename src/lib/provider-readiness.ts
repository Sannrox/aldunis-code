import type { ProviderDiscovery, ProviderId, ReasoningEffort } from "../types";

export interface ProviderModelOption {
  id: string;
  displayName: string;
}

export interface ProviderFailureView {
  kind: "park" | "generic";
  summary: string;
  question: string | null;
  resumeCommand: string | null;
}

const DEFAULT_REASONING_EFFORTS: ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const CLAUDE_MODELS: ProviderModelOption[] = [
  { id: "default", displayName: "default" },
  { id: "sonnet", displayName: "sonnet" },
  { id: "opus", displayName: "opus" },
  { id: "haiku", displayName: "haiku" },
];

/** Human label for a provider id (menus, empty states, chips). */
export function providerDisplayName(
  provider: ProviderId,
  discovery: ProviderDiscovery | undefined,
): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex-cli") return "Codex CLI";
  if (provider === "shikigami") return "Shikigami";
  const discovered = discovery?.name?.trim();
  if (discovered) return discovered;
  // Without discovery, prefer the package id over a generic "Provider adapter"
  // so Grok Build / Kiro threads stay labeled after the host detail drops.
  if (typeof provider === "string" && provider.startsWith("adapter:")) {
    const packageId = provider.slice("adapter:".length).split("@")[0];
    if (packageId === "dev.xai.grok-build" || packageId === "grok-build-cli") {
      return "Grok Build";
    }
    if (packageId === "dev.kiro.cli" || packageId === "kiro-cli") return "Kiro CLI";
    if (packageId === "dev.opencode.cli" || packageId === "opencode-cli") {
      return "OpenCode";
    }
    if (packageId) return packageId;
  }
  return "Provider adapter";
}

/** Compact chip id/label used on the composer provider control. */
export function providerChipName(
  provider: ProviderId,
  discovery: ProviderDiscovery | undefined,
): string {
  if (provider === "claude-code") return "claude-code";
  if (provider === "codex-cli") return "codex-cli";
  if (provider === "shikigami") return "shikigami";
  const name = discovery?.name?.trim();
  if (name) return name;
  // Prefer the adapter package id segment over a generic fallback.
  if (typeof provider === "string" && provider.startsWith("adapter:")) {
    const packageId = provider.slice("adapter:".length).split("@")[0];
    if (packageId) return packageId;
  }
  return providerDisplayName(provider, discovery);
}

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
      // Avoid "Install the Provider adapter adapter CLI…" when the name is the
      // generic fallback; package-derived names already identify the CLI.
      const name = options.providerName.trim();
      if (!name || /^provider adapter$/i.test(name)) {
        return "Install the provider adapter CLI…";
      }
      return `Install the ${name} CLI…`;
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

/**
 * Reasoning efforts for the selected model.
 * Codex always offers a default ladder when the model does not advertise one;
 * ACP adapters only expose efforts when discovery listed them.
 */
export function providerReasoningEfforts(
  provider: ProviderId,
  model: string,
  discovery: ProviderDiscovery | undefined,
): ReasoningEffort[] {
  const isAdapter = typeof provider === "string" && provider.startsWith("adapter:");
  if (provider !== "codex-cli" && !isAdapter) return [];
  if (model === "default") {
    return provider === "codex-cli" ? DEFAULT_REASONING_EFFORTS : [];
  }
  const match = discovery?.models?.find((entry) => entry.id === model);
  if (!match) {
    return provider === "codex-cli" ? DEFAULT_REASONING_EFFORTS : [];
  }
  // Explicit empty list means this model does not expose effort controls.
  if (Array.isArray(match.reasoningEfforts) && match.reasoningEfforts.length === 0) {
    return [];
  }
  const efforts = match.reasoningEfforts ?? [];
  if (efforts.length > 0) return efforts;
  return provider === "codex-cli" ? DEFAULT_REASONING_EFFORTS : [];
}

export function cycleReasoningEffort(
  provider: ProviderId,
  model: string,
  current: ReasoningEffort,
  discovery: ProviderDiscovery | undefined,
): ReasoningEffort {
  const efforts = providerReasoningEfforts(provider, model, discovery);
  if (efforts.length === 0) return current;
  const index = efforts.indexOf(current);
  return efforts[(index + 1) % efforts.length] ?? efforts[0]!;
}

/**
 * Split provider failure text into a scannable summary and optional CLI resume
 * command (Shikigami park). Presentation only — does not resume runs.
 */
export function parseProviderFailure(message: string): ProviderFailureView {
  const trimmed = message.trim();
  const resumeMatch = trimmed.match(
    /(shikigami\s+run\s+--resume\s+[0-9a-fA-F-]{36}\s+--answer\s+"\.\.\.")/i,
  );
  const questionMatch = trimmed.match(/Question:\s*(.+?)(?:\.\s+Resume|\.\s*$)/i);
  const isPark = /parked/i.test(trimmed) || Boolean(resumeMatch);
  if (!isPark) {
    return {
      kind: "generic",
      summary: trimmed,
      question: null,
      resumeCommand: null,
    };
  }
  let summary = trimmed;
  if (resumeMatch) {
    summary = trimmed.slice(0, resumeMatch.index).trim().replace(/[.\s]+$/, "") || "Shikigami parked.";
  }
  const question = questionMatch?.[1]?.trim() ?? null;
  if (question) {
    summary = summary.replace(new RegExp(`\\s*Question:\\s*${escapeRegExp(question)}\\.?`, "i"), "").trim();
  }
  return {
    kind: "park",
    summary: summary || "Shikigami parked awaiting an operator answer.",
    question,
    resumeCommand: resumeMatch?.[1] ?? null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
