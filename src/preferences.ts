import type { ConversationOpenScroll } from "./lib/thread-open-scroll";
import { isConversationOpenScroll } from "./lib/thread-open-scroll";

export interface Preferences {
  schemaVersion: 1;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  zoom: 0.8 | 0.9 | 1 | 1.1 | 1.2;
  reducedMotion: "system" | "reduce" | "no-preference";
  commandPaletteShortcut: "mod+k" | "mod+shift+p";
  conversationSearchShortcut: "mod+shift+f" | "mod+shift+o";
  managedWorktreeLimit: number | null;
  orchestrationThreadsBeta: boolean;
  showThinking: boolean;
  /** Where the transcript opens when selecting a conversation. */
  conversationOpenScroll: ConversationOpenScroll;
}

export function resolveTheme(theme: Preferences["theme"], prefersDark: boolean): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark ? "dark" : "light";
}

export const DEFAULT_PREFERENCES: Preferences = {
  schemaVersion: 1,
  theme: "dark",
  density: "comfortable",
  zoom: 1,
  reducedMotion: "system",
  commandPaletteShortcut: "mod+k",
  conversationSearchShortcut: "mod+shift+f",
  managedWorktreeLimit: 10,
  orchestrationThreadsBeta: false,
  showThinking: false,
  conversationOpenScroll: "latest",
};

export function readPreferencesResponse(value: unknown): {
  preferences: Preferences;
  recovered: boolean;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const preferences = body.preferences;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
  const input = preferences as Record<string, unknown>;
  if (
    input.schemaVersion !== 1 ||
    !["system", "light", "dark"].includes(input.theme as string) ||
    !["comfortable", "compact"].includes(input.density as string) ||
    ![0.8, 0.9, 1, 1.1, 1.2].includes(input.zoom as number) ||
    !["system", "reduce", "no-preference"].includes(input.reducedMotion as string) ||
    !["mod+k", "mod+shift+p"].includes(input.commandPaletteShortcut as string) ||
    (input.conversationSearchShortcut !== undefined &&
      !["mod+shift+f", "mod+shift+o"].includes(input.conversationSearchShortcut as string)) ||
    (input.orchestrationThreadsBeta !== undefined &&
      typeof input.orchestrationThreadsBeta !== "boolean") ||
    (input.showThinking !== undefined && typeof input.showThinking !== "boolean") ||
    (input.conversationOpenScroll !== undefined &&
      !isConversationOpenScroll(input.conversationOpenScroll)) ||
    (input.managedWorktreeLimit !== undefined &&
      input.managedWorktreeLimit !== null &&
      (!Number.isInteger(input.managedWorktreeLimit) ||
        (input.managedWorktreeLimit as number) < 1 ||
        (input.managedWorktreeLimit as number) > 100)) ||
    typeof body.recovered !== "boolean"
  ) {
    return null;
  }
  return {
    preferences: {
      ...(input as unknown as Omit<
        Preferences,
        | "managedWorktreeLimit"
        | "orchestrationThreadsBeta"
        | "showThinking"
        | "conversationOpenScroll"
      >),
      conversationSearchShortcut:
        input.conversationSearchShortcut === undefined
          ? DEFAULT_PREFERENCES.conversationSearchShortcut
          : (input.conversationSearchShortcut as Preferences["conversationSearchShortcut"]),
      managedWorktreeLimit:
        input.managedWorktreeLimit === undefined
          ? DEFAULT_PREFERENCES.managedWorktreeLimit
          : (input.managedWorktreeLimit as number | null),
      orchestrationThreadsBeta: input.orchestrationThreadsBeta === true,
      showThinking: input.showThinking === true,
      conversationOpenScroll:
        input.conversationOpenScroll === undefined
          ? DEFAULT_PREFERENCES.conversationOpenScroll
          : (input.conversationOpenScroll as Preferences["conversationOpenScroll"]),
    },
    recovered: body.recovered,
  };
}
