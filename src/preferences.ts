export interface Preferences {
  schemaVersion: 1;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  zoom: 0.8 | 0.9 | 1 | 1.1 | 1.2;
  reducedMotion: "system" | "reduce" | "no-preference";
  commandPaletteShortcut: "mod+k" | "mod+shift+p";
}

export const DEFAULT_PREFERENCES: Preferences = {
  schemaVersion: 1,
  theme: "system",
  density: "comfortable",
  zoom: 1,
  reducedMotion: "system",
  commandPaletteShortcut: "mod+k",
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
    input.schemaVersion !== 1
    || !["system", "light", "dark"].includes(input.theme as string)
    || !["comfortable", "compact"].includes(input.density as string)
    || ![0.8, 0.9, 1, 1.1, 1.2].includes(input.zoom as number)
    || !["system", "reduce", "no-preference"].includes(input.reducedMotion as string)
    || !["mod+k", "mod+shift+p"].includes(input.commandPaletteShortcut as string)
    || typeof body.recovered !== "boolean"
  ) {
    return null;
  }
  return { preferences: input as unknown as Preferences, recovered: body.recovered };
}
