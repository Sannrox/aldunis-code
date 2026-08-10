/**
 * Last-used composer run settings for new conversations.
 *
 * Provider, model, reasoning effort, interaction mode, workspace strategy, and
 * optional profile are browser-local only. They seed the next new chat; they
 * never override an existing conversation's stored binding. Fail soft on
 * storage denial or corrupt payloads.
 */

import type {
  InteractionMode,
  ProviderId,
  ReasoningEffort,
  WorkspaceMode,
} from "../types";
import { DEFAULT_NEW_CONVERSATION_PROVIDER } from "./provider-readiness";

export const COMPOSER_RUN_SETTINGS_STORAGE_KEY = "aldunis.composerRunSettings.v1";
export const COMPOSER_RUN_SETTINGS_VERSION = 1 as const;

export interface ComposerRunSettings {
  version: typeof COMPOSER_RUN_SETTINGS_VERSION;
  provider: ProviderId;
  model: string;
  reasoningEffort: ReasoningEffort;
  mode: InteractionMode;
  workspaceMode: WorkspaceMode;
  /** Claude / Shikigami profile when applicable; omitted otherwise. */
  profileId?: string;
}

export type ComposerRunSettingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const INTERACTION_MODES: readonly InteractionMode[] = ["ask", "plan", "build"];
const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  "shared",
  "aldunis-managed",
  "provider-native",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept built-ins and reviewed adapter ids (`adapter:package@version`). */
export function isComposerRunSettingsProviderId(value: unknown): value is ProviderId {
  if (typeof value !== "string" || !value.trim()) return false;
  if (value === "claude-code" || value === "codex-cli" || value === "shikigami") return true;
  if (!value.startsWith("adapter:")) return false;
  const rest = value.slice("adapter:".length);
  const at = rest.lastIndexOf("@");
  if (at <= 0 || at === rest.length - 1) return false;
  const packageId = rest.slice(0, at).trim();
  const version = rest.slice(at + 1).trim();
  return packageId.length > 0 && version.length > 0;
}

export function defaultComposerRunSettings(
  overrides: Partial<Omit<ComposerRunSettings, "version">> = {},
): ComposerRunSettings {
  const settings: ComposerRunSettings = {
    version: COMPOSER_RUN_SETTINGS_VERSION,
    provider: overrides.provider ?? DEFAULT_NEW_CONVERSATION_PROVIDER,
    model: overrides.model?.trim() || "default",
    reasoningEffort: overrides.reasoningEffort ?? "medium",
    mode: overrides.mode ?? "ask",
    workspaceMode: overrides.workspaceMode ?? "aldunis-managed",
  };
  const profileId = overrides.profileId?.trim();
  if (profileId) settings.profileId = profileId;
  return settings;
}

export function parseComposerRunSettings(raw: string | null | undefined): ComposerRunSettings | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== COMPOSER_RUN_SETTINGS_VERSION) return null;
    if (!isComposerRunSettingsProviderId(parsed.provider)) return null;
    if (typeof parsed.model !== "string" || !parsed.model.trim()) return null;
    if (!REASONING_EFFORTS.includes(parsed.reasoningEffort as ReasoningEffort)) return null;
    if (!INTERACTION_MODES.includes(parsed.mode as InteractionMode)) return null;
    if (!WORKSPACE_MODES.includes(parsed.workspaceMode as WorkspaceMode)) return null;
    const settings: ComposerRunSettings = {
      version: COMPOSER_RUN_SETTINGS_VERSION,
      provider: parsed.provider,
      model: parsed.model.trim(),
      reasoningEffort: parsed.reasoningEffort as ReasoningEffort,
      mode: parsed.mode as InteractionMode,
      workspaceMode: parsed.workspaceMode as WorkspaceMode,
    };
    if (typeof parsed.profileId === "string" && parsed.profileId.trim()) {
      settings.profileId = parsed.profileId.trim();
    }
    return settings;
  } catch {
    return null;
  }
}

export function serializeComposerRunSettings(settings: ComposerRunSettings): string {
  const body: ComposerRunSettings = {
    version: COMPOSER_RUN_SETTINGS_VERSION,
    provider: settings.provider,
    model: settings.model.trim() || "default",
    reasoningEffort: settings.reasoningEffort,
    mode: settings.mode,
    workspaceMode: settings.workspaceMode,
  };
  if (settings.profileId?.trim()) body.profileId = settings.profileId.trim();
  return JSON.stringify(body);
}

/** Safe localStorage access — SecurityError must not crash render. */
export function getComposerRunSettingsStorage(
  scope: { localStorage?: ComposerRunSettingsStorage } | null | undefined = typeof window ===
  "undefined"
    ? null
    : window,
): ComposerRunSettingsStorage | null {
  if (!scope) return null;
  try {
    const storage = scope.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage;
  } catch {
    return null;
  }
}

export function readComposerRunSettings(
  storage: ComposerRunSettingsStorage | null | undefined,
): ComposerRunSettings | null {
  if (!storage) return null;
  try {
    return parseComposerRunSettings(storage.getItem(COMPOSER_RUN_SETTINGS_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeComposerRunSettings(
  storage: ComposerRunSettingsStorage | null | undefined,
  settings: ComposerRunSettings,
): boolean {
  if (!storage) return false;
  try {
    const normalized = parseComposerRunSettings(serializeComposerRunSettings(settings));
    if (!normalized) return false;
    storage.setItem(COMPOSER_RUN_SETTINGS_STORAGE_KEY, serializeComposerRunSettings(normalized));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve seeds for a new conversation composer.
 * Explicit overrides (domain handoff provider) win over stored last-used values.
 */
export function resolveNewConversationRunSettings(input: {
  stored: ComposerRunSettings | null | undefined;
  managedMode?: boolean;
  managedModel?: string | null;
  initialProvider?: ProviderId | null;
}): ComposerRunSettings {
  if (input.managedMode) {
    return defaultComposerRunSettings({
      provider: "shikigami",
      model: input.managedModel?.trim() || "default",
      mode: "build",
      workspaceMode: "shared",
      reasoningEffort: "medium",
    });
  }
  const base = input.stored
    ? defaultComposerRunSettings(input.stored)
    : defaultComposerRunSettings();
  if (input.initialProvider && isComposerRunSettingsProviderId(input.initialProvider)) {
    // Handoff overrides only the provider. Drop provider-specific bindings so a
    // stored Claude model/profile never rides onto Codex/Shikigami (or vice versa).
    // Also drop provider-native workspace: the destination may not support it.
    if (input.initialProvider !== base.provider) {
      return defaultComposerRunSettings({
        provider: input.initialProvider,
        mode: base.mode,
        workspaceMode: "aldunis-managed",
        model: "default",
        reasoningEffort: "medium",
      });
    }
    return defaultComposerRunSettings({
      ...base,
      provider: input.initialProvider,
    });
  }
  return base;
}
