import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultStateDirectory } from "./state.ts";

const execFileAsync = promisify(execFile);
const PROFILE_SCHEMA_VERSION = 1;
const DEFAULT_MODELS = ["default", "sonnet", "opus", "haiku"] as const;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Built-in harness defaults that must work without manual profile setup.
 * Claude Code is the only harness that requires a named profile for binary /
 * config-dir / env. Codex CLI is discovered from PATH and needs no profile.
 * Declarative ACP adapters are installed separately and are not seeded here.
 */
export const DEFAULT_CLAUDE_PROFILE_ID = "default:claude-code";

export const BUILTIN_HARNESS_DEFAULTS = [
  {
    id: DEFAULT_CLAUDE_PROFILE_ID,
    harness: "claude-code" as const,
    name: "Claude Code",
    binaryPath: "claude",
    homePath: "",
  },
] as const;

export type ProfileProbeKind = "availability" | "version" | "authentication" | "models";
export type ProbeState = "unknown" | "refreshing" | "ready" | "unavailable";

export interface ProfileEnvironmentVariable {
  name: string;
  sensitive: boolean;
  value?: string;
  valueSet?: boolean;
}

export interface ClaudeProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  binaryPath: string;
  homePath: string;
  environment: ProfileEnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface ProfileProbe {
  state: ProbeState;
  checkedAt: string | null;
  detail: string | null;
  authenticated?: boolean;
  models?: string[];
}

export interface ClaudeProfileSnapshot extends ClaudeProfile {
  probes: Record<ProfileProbeKind, ProfileProbe>;
}

interface ProfileDocument {
  schemaVersion: 1;
  profiles: ClaudeProfile[];
}

interface SecretDocument {
  schemaVersion: 1;
  values: Record<string, string>;
}

export class ProfileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function emptyProbe(): ProfileProbe {
  return { state: "unknown", checkedAt: null, detail: null };
}

function emptyProbes(): Record<ProfileProbeKind, ProfileProbe> {
  return {
    availability: emptyProbe(),
    version: emptyProbe(),
    authentication: emptyProbe(),
    models: emptyProbe(),
  };
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function validateEnvironment(environment: ProfileEnvironmentVariable[]): void {
  const names = new Set<string>();
  for (const variable of environment) {
    if (!ENVIRONMENT_NAME.test(variable.name)) {
      throw new ProfileError(`Invalid environment variable name: ${variable.name || "(empty)"}.`);
    }
    if (names.has(variable.name)) {
      throw new ProfileError(`Environment variable ${variable.name} is duplicated.`);
    }
    names.add(variable.name);
  }
}

function publicProfile(profile: ClaudeProfile, secrets: SecretDocument): ClaudeProfile {
  return {
    ...profile,
    environment: profile.environment.map((variable) => variable.sensitive
      ? {
          name: variable.name,
          sensitive: true,
          valueSet: Object.hasOwn(secrets.values, `${profile.id}:${variable.name}`),
        }
      : { name: variable.name, sensitive: false, value: variable.value ?? "" }),
  };
}

async function readDocument<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new ProfileError("Claude profile storage could not be read.", 500);
  }
}

async function writeDocument(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class ClaudeProfileStore {
  readonly #profilesPath: string;
  readonly #secretsPath: string;
  readonly #probes = new Map<string, Record<ProfileProbeKind, ProfileProbe>>();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly directory = defaultStateDirectory()) {
    this.#profilesPath = join(directory, "claude-profiles.v1.json");
    this.#secretsPath = join(directory, "provider-secrets.v1.json");
  }

  async #documents(): Promise<{ profiles: ProfileDocument; secrets: SecretDocument }> {
    const [profiles, secrets] = await Promise.all([
      readDocument<ProfileDocument>(this.#profilesPath, {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profiles: [],
      }),
      readDocument<SecretDocument>(this.#secretsPath, {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        values: {},
      }),
    ]);
    if (
      profiles.schemaVersion !== PROFILE_SCHEMA_VERSION
      || secrets.schemaVersion !== PROFILE_SCHEMA_VERSION
      || !Array.isArray(profiles.profiles)
      || typeof secrets.values !== "object"
      || secrets.values === null
    ) {
      throw new ProfileError("Claude profile storage uses an incompatible schema.", 500);
    }
    return { profiles, secrets };
  }

  /**
   * Ensure every built-in harness that needs a profile has a usable default.
   * Idempotent by stable profile id: missing built-ins are added; existing
   * user-edited rows with the same id are left alone. Codex CLI and other
   * PATH-discovered harnesses do not use this store.
   */
  async ensureDefaults(): Promise<ClaudeProfileSnapshot[]> {
    let result!: ClaudeProfileSnapshot[];
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      const now = new Date().toISOString();
      let changed = false;
      for (const builtin of BUILTIN_HARNESS_DEFAULTS) {
        if (builtin.harness !== "claude-code") continue;
        if (profiles.profiles.some((profile) => profile.id === builtin.id)) continue;
        const profile: ClaudeProfile = {
          schemaVersion: PROFILE_SCHEMA_VERSION,
          id: builtin.id,
          name: builtin.name,
          binaryPath: builtin.binaryPath,
          homePath: builtin.homePath,
          environment: [],
          createdAt: now,
          updatedAt: now,
        };
        // Prefer the built-in default first so the composer auto-selects it.
        profiles.profiles.unshift(profile);
        this.#probes.delete(profile.id);
        changed = true;
      }
      if (changed) await writeDocument(this.#profilesPath, profiles);
      result = profiles.profiles.map((profile) => ({
        ...publicProfile(profile, secrets),
        probes: structuredClone(this.#probes.get(profile.id) ?? emptyProbes()),
      }));
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async list(): Promise<ClaudeProfileSnapshot[]> {
    return this.ensureDefaults();
  }

  async save(input: {
    id?: string;
    name: string;
    binaryPath?: string;
    homePath?: string;
    environment?: ProfileEnvironmentVariable[];
  }): Promise<ClaudeProfileSnapshot> {
    const name = input.name.trim();
    const binaryPath = input.binaryPath?.trim() || "claude";
    const homePath = input.homePath?.trim() || "";
    const environment = input.environment ?? [];
    if (!name) throw new ProfileError("A profile name is required.");
    validateEnvironment(environment);

    let result!: ClaudeProfileSnapshot;
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      const existing = input.id
        ? profiles.profiles.find((profile) => profile.id === input.id)
        : undefined;
      if (input.id && !existing) throw new ProfileError("The Claude profile was not found.", 404);
      const id = existing?.id ?? randomUUID();
      const now = new Date().toISOString();
      const storedEnvironment = environment.map((variable) => {
        const key = `${id}:${variable.name}`;
        if (variable.sensitive) {
          if (typeof variable.value === "string" && variable.value.length > 0) {
            secrets.values[key] = variable.value;
          } else if (!variable.valueSet) {
            delete secrets.values[key];
          }
          return { name: variable.name, sensitive: true };
        }
        delete secrets.values[key];
        return { name: variable.name, sensitive: false, value: variable.value ?? "" };
      });
      const retainedNames = new Set(environment.map((variable) => variable.name));
      for (const key of Object.keys(secrets.values)) {
        if (key.startsWith(`${id}:`) && !retainedNames.has(key.slice(id.length + 1))) {
          delete secrets.values[key];
        }
      }
      const profile: ClaudeProfile = {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        id,
        name,
        binaryPath,
        homePath,
        environment: storedEnvironment,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const index = profiles.profiles.findIndex((item) => item.id === id);
      if (index === -1) profiles.profiles.push(profile);
      else profiles.profiles[index] = profile;
      await writeDocument(this.#secretsPath, secrets);
      await writeDocument(this.#profilesPath, profiles);
      this.#probes.delete(id);
      result = { ...publicProfile(profile, secrets), probes: emptyProbes() };
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async delete(id: string): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      if (!profiles.profiles.some((profile) => profile.id === id)) {
        throw new ProfileError("The Claude profile was not found.", 404);
      }
      profiles.profiles = profiles.profiles.filter((profile) => profile.id !== id);
      for (const key of Object.keys(secrets.values)) {
        if (key.startsWith(`${id}:`)) delete secrets.values[key];
      }
      await writeDocument(this.#secretsPath, secrets);
      await writeDocument(this.#profilesPath, profiles);
      this.#probes.delete(id);
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async runtime(id: string): Promise<{
    profile: ClaudeProfile;
    executable: string;
    environment: NodeJS.ProcessEnv;
    continuationKey: string;
  }> {
    const { profiles, secrets } = await this.#documents();
    const profile = profiles.profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileError("Select an available Claude profile.", 404);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of profile.environment) {
      environment[variable.name] = variable.sensitive
        ? secrets.values[`${id}:${variable.name}`] ?? ""
        : variable.value ?? "";
    }
    const resolvedHome = resolve(expandHome(profile.homePath || homedir()));
    if (profile.homePath) environment.CLAUDE_CONFIG_DIR = resolvedHome;
    return {
      profile: publicProfile(profile, secrets),
      executable: profile.binaryPath,
      environment,
      continuationKey: `claude:home:${resolvedHome}`,
    };
  }

  async refresh(id: string, kind: ProfileProbeKind): Promise<ClaudeProfileSnapshot> {
    const runtime = await this.runtime(id);
    const probes = this.#probes.get(id) ?? emptyProbes();
    probes[kind] = { state: "refreshing", checkedAt: null, detail: null };
    this.#probes.set(id, probes);
    const checkedAt = new Date().toISOString();
    try {
      if (kind === "availability") {
        if (isAbsolute(runtime.executable)) await access(runtime.executable);
        await execFileAsync(runtime.executable, ["--version"], {
          env: runtime.environment,
          timeout: 5_000,
          encoding: "utf8",
        });
        probes.availability = { state: "ready", checkedAt, detail: "Claude Code is available." };
      } else if (kind === "version") {
        const result = await execFileAsync(runtime.executable, ["--version"], {
          env: runtime.environment,
          timeout: 5_000,
          encoding: "utf8",
        });
        probes.version = {
          state: "ready",
          checkedAt,
          detail: result.stdout.trim().split("\n")[0] || "Version detected.",
        };
      } else if (kind === "authentication") {
        const result = await execFileAsync(runtime.executable, ["auth", "status", "--json"], {
          env: runtime.environment,
          timeout: 8_000,
          encoding: "utf8",
        });
        const normalizedStatus = result.stdout.toLowerCase();
        let authenticated = !normalizedStatus.includes("not authenticated")
          && !normalizedStatus.includes("not logged in")
          && (
            normalizedStatus.includes("loggedin")
            || normalizedStatus.includes("logged in")
            || normalizedStatus.includes("authenticated")
          );
        try {
          const value = JSON.parse(result.stdout) as Record<string, unknown>;
          authenticated = value.loggedIn === true || value.authenticated === true;
        } catch {
          // Older Claude versions may return text despite accepting the command.
        }
        probes.authentication = {
          state: authenticated ? "ready" : "unavailable",
          checkedAt,
          detail: authenticated ? "Claude authentication is ready." : "Claude is not authenticated.",
          authenticated,
        };
      } else {
        probes.models = {
          state: "ready",
          checkedAt,
          detail: "Claude model aliases are available.",
          models: [...DEFAULT_MODELS],
        };
      }
    } catch {
      probes[kind] = {
        state: "unavailable",
        checkedAt,
        detail: kind === "authentication"
          ? "Claude authentication could not be verified."
          : kind === "models"
          ? "Claude models could not be resolved."
          : "Claude Code is unavailable for this profile.",
        ...(kind === "authentication" ? { authenticated: false } : {}),
        ...(kind === "models" ? { models: [] } : {}),
      };
    }
    this.#probes.set(id, probes);
    return {
      ...runtime.profile,
      probes: structuredClone(probes),
    };
  }
}

export const CLAUDE_MODEL_ALIASES: readonly string[] = DEFAULT_MODELS;
