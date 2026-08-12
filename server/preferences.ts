import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PREFERENCES_SCHEMA_VERSION = 1;
export const MAX_PREFERENCES_FILE_BYTES = 16 * 1024;

export type ConversationOpenScroll = "latest" | "remember";

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
  conversationOpenScroll: "latest",
};

export class PreferencesError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface PreferencesFileOperations {
  open(path: string): Promise<{
    stat(): Promise<{ size: number }>;
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
}

const preferencesFileOperations: PreferencesFileOperations = {
  open: (path) => open(path, "r"),
};

async function readPreferencesFile(
  path: string,
  operations: PreferencesFileOperations,
): Promise<string> {
  const handle = await operations.open(path);
  try {
    const details = await handle.stat();
    if (details.size > MAX_PREFERENCES_FILE_BYTES) {
      throw new PreferencesError("Preferences exceed the supported size.");
    }
    const bytes = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (offset !== details.size || (await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new PreferencesError("Preferences changed while being read.");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreferencesError("Preferences are invalid.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== PREFERENCES_SCHEMA_VERSION ||
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
      input.conversationOpenScroll !== "latest" &&
      input.conversationOpenScroll !== "remember") ||
    (input.managedWorktreeLimit !== undefined &&
      input.managedWorktreeLimit !== null &&
      (!Number.isInteger(input.managedWorktreeLimit) ||
        (input.managedWorktreeLimit as number) < 1 ||
        (input.managedWorktreeLimit as number) > 100))
  ) {
    throw new PreferencesError("Preferences use an incompatible or invalid value.");
  }
  return {
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    theme: input.theme as Preferences["theme"],
    density: input.density as Preferences["density"],
    zoom: input.zoom as Preferences["zoom"],
    reducedMotion: input.reducedMotion as Preferences["reducedMotion"],
    commandPaletteShortcut: input.commandPaletteShortcut as Preferences["commandPaletteShortcut"],
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
  };
}

export class PreferencesStore {
  readonly #path: string;

  constructor(
    readonly directory: string,
    readonly operations: PreferencesFileOperations = preferencesFileOperations,
  ) {
    this.#path = join(directory, "preferences.v1.json");
  }

  async load(): Promise<{ preferences: Preferences; recovered: boolean }> {
    try {
      return {
        preferences: parsePreferences(
          JSON.parse(await readPreferencesFile(this.#path, this.operations)),
        ),
        recovered: false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { preferences: DEFAULT_PREFERENCES, recovered: false };
      }
      return { preferences: DEFAULT_PREFERENCES, recovered: true };
    }
  }

  async save(value: unknown): Promise<Preferences> {
    const preferences = parsePreferences(value);
    const serialized = `${JSON.stringify(preferences, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_PREFERENCES_FILE_BYTES) {
      throw new PreferencesError("Preferences exceed the supported size.");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    return preferences;
  }
}
