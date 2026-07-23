import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PREFERENCES_SCHEMA_VERSION = 1;

export interface Preferences {
  schemaVersion: 1;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  zoom: 0.8 | 0.9 | 1 | 1.1 | 1.2;
  reducedMotion: "system" | "reduce" | "no-preference";
  commandPaletteShortcut: "mod+k" | "mod+shift+p";
}

export const DEFAULT_PREFERENCES: Preferences = {
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  theme: "system",
  density: "comfortable",
  zoom: 1,
  reducedMotion: "system",
  commandPaletteShortcut: "mod+k",
};

export class PreferencesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreferencesError("Preferences are invalid.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== PREFERENCES_SCHEMA_VERSION
    || !["system", "light", "dark"].includes(input.theme as string)
    || !["comfortable", "compact"].includes(input.density as string)
    || ![0.8, 0.9, 1, 1.1, 1.2].includes(input.zoom as number)
    || !["system", "reduce", "no-preference"].includes(input.reducedMotion as string)
    || !["mod+k", "mod+shift+p"].includes(input.commandPaletteShortcut as string)
  ) {
    throw new PreferencesError("Preferences use an incompatible or invalid value.");
  }
  return input as unknown as Preferences;
}

export class PreferencesStore {
  readonly #path: string;

  constructor(readonly directory: string) {
    this.#path = join(directory, "preferences.v1.json");
  }

  async load(): Promise<{ preferences: Preferences; recovered: boolean }> {
    try {
      return { preferences: parsePreferences(JSON.parse(await readFile(this.#path, "utf8"))), recovered: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { preferences: DEFAULT_PREFERENCES, recovered: false };
      }
      return { preferences: DEFAULT_PREFERENCES, recovered: true };
    }
  }

  async save(value: unknown): Promise<Preferences> {
    const preferences = parsePreferences(value);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
    return preferences;
  }
}
