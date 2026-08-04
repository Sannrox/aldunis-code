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
  conversationSearchShortcut: "mod+shift+f" | "mod+shift+o";
  managedWorktreeLimit: number | null;
  orchestrationThreadsBeta: boolean;
  showThinking: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  theme: "system",
  density: "comfortable",
  zoom: 1,
  reducedMotion: "system",
  commandPaletteShortcut: "mod+k",
  conversationSearchShortcut: "mod+shift+f",
  managedWorktreeLimit: 10,
  orchestrationThreadsBeta: false,
  showThinking: false,
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
    || (
      input.conversationSearchShortcut !== undefined
      && !["mod+shift+f", "mod+shift+o"].includes(input.conversationSearchShortcut as string)
    )
    || (
      input.orchestrationThreadsBeta !== undefined
      && typeof input.orchestrationThreadsBeta !== "boolean"
    )
    || (
      input.showThinking !== undefined
      && typeof input.showThinking !== "boolean"
    )
    || (
      input.managedWorktreeLimit !== undefined
      && input.managedWorktreeLimit !== null
      && (
        !Number.isInteger(input.managedWorktreeLimit)
        || (input.managedWorktreeLimit as number) < 1
        || (input.managedWorktreeLimit as number) > 100
      )
    )
  ) {
    throw new PreferencesError("Preferences use an incompatible or invalid value.");
  }
  return {
    ...(input as unknown as Omit<Preferences, "managedWorktreeLimit" | "orchestrationThreadsBeta" | "showThinking">),
    conversationSearchShortcut: input.conversationSearchShortcut === undefined
      ? DEFAULT_PREFERENCES.conversationSearchShortcut
      : input.conversationSearchShortcut as Preferences["conversationSearchShortcut"],
    managedWorktreeLimit: input.managedWorktreeLimit === undefined
      ? DEFAULT_PREFERENCES.managedWorktreeLimit
      : input.managedWorktreeLimit as number | null,
    orchestrationThreadsBeta: input.orchestrationThreadsBeta === true,
    showThinking: input.showThinking === true,
  };
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
