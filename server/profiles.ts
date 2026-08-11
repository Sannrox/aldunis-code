import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultStateDirectory } from "./state.ts";

const execFileAsync = promisify(execFile);
const PROFILE_SCHEMA_VERSION = 1;
/**
 * Claude model ids accepted on the wire. Full T3-style slugs are preferred in the UI;
 * short aliases and "default" remain for legacy threads/clients.
 */
const DEFAULT_MODELS = [
  "default",
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
] as const;

/** Short / legacy Claude ids → T3-style full model slugs (for `--model`). */
const CLAUDE_MODEL_SLUG_ALIASES: Record<string, string> = {
  default: "claude-sonnet-5",
  sonnet: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5.0": "claude-sonnet-5",
  "claude-sonnet-5-0": "claude-sonnet-5",
  opus: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "claude-opus-5.0": "claude-opus-5",
  "claude-opus-5-0": "claude-opus-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "opus-4.6": "claude-opus-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
  "haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
};

/** Map short Claude aliases to full product slugs before invoking the CLI. */
export function normalizeClaudeModelSlug(model: string): string {
  const key = model.trim().toLowerCase();
  return CLAUDE_MODEL_SLUG_ALIASES[key] ?? model.trim();
}

export function isAllowedClaudeModel(model: string): boolean {
  const trimmed = model.trim();
  const normalized = normalizeClaudeModelSlug(trimmed);
  return (
    (DEFAULT_MODELS as readonly string[]).includes(trimmed) ||
    (DEFAULT_MODELS as readonly string[]).includes(normalized)
  );
}
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Built-in harness defaults that must exist without manual profile setup.
 * Records may be empty (no home, no env). Adapters get their own default when
 * installed; see `ensureProviderDefault` / `ensureDefaults({ adapters })`.
 */
export const DEFAULT_CLAUDE_PROFILE_ID = "default:claude-code";
export const DEFAULT_CODEX_PROFILE_ID = "default:codex-cli";
export const DEFAULT_SHIKIGAMI_PROFILE_ID = "default:shikigami";

export const BUILTIN_HARNESS_DEFAULTS = [
  {
    id: DEFAULT_CLAUDE_PROFILE_ID,
    provider: "claude-code" as const,
    name: "Claude Code",
    binaryPath: "claude",
    homePath: "",
  },
  {
    id: DEFAULT_CODEX_PROFILE_ID,
    provider: "codex-cli" as const,
    name: "Codex CLI",
    binaryPath: "codex",
    homePath: "",
  },
  {
    id: DEFAULT_SHIKIGAMI_PROFILE_ID,
    provider: "shikigami" as const,
    name: "Shikigami",
    binaryPath: "shikigami",
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

/** Stable provider key: first-class id or `adapter:<packageId>` / `adapter:<packageId>@<version>`. */
export type ProfileProviderKey = string;

export interface ClaudeProfile {
  schemaVersion: 1;
  id: string;
  /** Owning provider. Missing on legacy rows → treated as claude-code. */
  provider: ProfileProviderKey;
  name: string;
  binaryPath: string;
  homePath: string;
  /** Optional provider-native config file. Empty means native resolution. */
  configPath: string;
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

interface ActiveProfileProbe {
  profileId: string;
  invalidated: boolean;
  awaitedMutations: Set<object>;
  promise: Promise<ClaudeProfileSnapshot>;
}

export interface AdapterProfileSeed {
  /** Full discovery id, e.g. `adapter:dev.kiro.cli@1.0.0`. */
  provider: string;
  name: string;
  binaryPath: string;
  environment?: ProfileEnvironmentVariable[];
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
  constructor(
    message: string,
    readonly status = 400,
  ) {
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

/** Stable default profile id for a provider key (version-independent for adapters). */
export function defaultProfileId(provider: string): string {
  if (provider === "claude-code") return DEFAULT_CLAUDE_PROFILE_ID;
  if (provider === "codex-cli") return DEFAULT_CODEX_PROFILE_ID;
  if (provider === "shikigami") return DEFAULT_SHIKIGAMI_PROFILE_ID;
  if (provider.startsWith("adapter:")) {
    const packageId = provider.slice("adapter:".length).split("@")[0]?.trim();
    if (!packageId) throw new ProfileError("Invalid adapter provider key.");
    return `default:adapter:${packageId}`;
  }
  return `default:${provider}`;
}

export function isDefaultProfileId(id: string): boolean {
  return id.startsWith("default:");
}

function normalizeProfile(raw: ClaudeProfile): ClaudeProfile {
  return {
    ...raw,
    provider:
      typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "claude-code",
    binaryPath: raw.binaryPath ?? "",
    homePath: raw.homePath ?? "",
    configPath: raw.configPath ?? "",
    environment: Array.isArray(raw.environment) ? raw.environment : [],
  };
}

function publicProfile(profile: ClaudeProfile, secrets: SecretDocument): ClaudeProfile {
  const normalized = normalizeProfile(profile);
  return {
    ...normalized,
    environment: normalized.environment.map((variable) =>
      variable.sensitive
        ? {
            name: variable.name,
            sensitive: true,
            valueSet: Object.hasOwn(secrets.values, `${normalized.id}:${variable.name}`),
          }
        : { name: variable.name, sensitive: false, value: variable.value ?? "" },
    ),
  };
}

async function readDocument<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new ProfileError("Provider profile storage could not be read.", 500);
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
  readonly #activeProbes = new Map<string, ActiveProfileProbe>();
  readonly #runningProbes = new Set<ActiveProfileProbe>();
  readonly #pendingProfileMutations = new Map<string, Set<object>>();
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
      profiles.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      secrets.schemaVersion !== PROFILE_SCHEMA_VERSION ||
      !Array.isArray(profiles.profiles) ||
      typeof secrets.values !== "object" ||
      secrets.values === null
    ) {
      throw new ProfileError("Provider profile storage uses an incompatible schema.", 500);
    }
    profiles.profiles = profiles.profiles.map((profile) => normalizeProfile(profile));
    return { profiles, secrets };
  }

  #snapshot(profile: ClaudeProfile, secrets: SecretDocument): ClaudeProfileSnapshot {
    return {
      ...publicProfile(profile, secrets),
      probes: structuredClone(this.#probes.get(profile.id) ?? emptyProbes()),
    };
  }

  #invalidateActiveProbes(id: string, committedMutation: object): void {
    for (const active of this.#runningProbes) {
      if (active.profileId === id && !active.awaitedMutations.has(committedMutation)) {
        active.invalidated = true;
      }
    }
  }

  #beginProfileMutation(id: string): object {
    const mutation = {};
    const pending = this.#pendingProfileMutations.get(id) ?? new Set<object>();
    pending.add(mutation);
    this.#pendingProfileMutations.set(id, pending);
    return mutation;
  }

  #endProfileMutation(id: string, mutation: object): void {
    const pending = this.#pendingProfileMutations.get(id);
    pending?.delete(mutation);
    if (pending?.size === 0) this.#pendingProfileMutations.delete(id);
    for (const active of this.#runningProbes) active.awaitedMutations.delete(mutation);
  }

  #awaitsCurrentMutations(id: string, active: ActiveProfileProbe): boolean {
    const pending = this.#pendingProfileMutations.get(id);
    if (active.awaitedMutations.size !== (pending?.size ?? 0)) return false;
    return !pending || [...pending].every((mutation) => active.awaitedMutations.has(mutation));
  }

  #storeProbeResult(
    id: string,
    kind: ProfileProbeKind,
    probe: ProfileProbe,
    active: ActiveProfileProbe,
  ): Record<ProfileProbeKind, ProfileProbe> {
    const probes = structuredClone(this.#probes.get(id) ?? emptyProbes());
    probes[kind] = probe;
    if (!active.invalidated) this.#probes.set(id, probes);
    return probes;
  }

  /** Test and diagnostics: settled profile identities retained in memory. */
  get retainedProbeProfileCount(): number {
    return this.#probes.size;
  }

  /** Test and diagnostics: currently executing profile/kind probes. */
  get activeProbeCount(): number {
    return this.#runningProbes.size;
  }

  /**
   * Ensure every built-in harness (and optionally installed adapters) has a
   * default profile. Idempotent by stable profile id: missing rows are added;
   * existing user-edited rows with the same id are left alone.
   */
  async ensureDefaults(options?: {
    adapters?: AdapterProfileSeed[];
  }): Promise<ClaudeProfileSnapshot[]> {
    let result!: ClaudeProfileSnapshot[];
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      const now = new Date().toISOString();
      let changed = false;

      const seed = (
        id: string,
        provider: string,
        name: string,
        binaryPath: string,
        homePath: string,
        configPath: string,
        environment: ProfileEnvironmentVariable[],
        preferFront: boolean,
      ) => {
        if (profiles.profiles.some((profile) => profile.id === id)) return;
        const profile: ClaudeProfile = {
          schemaVersion: PROFILE_SCHEMA_VERSION,
          id,
          provider,
          name,
          binaryPath,
          homePath,
          configPath,
          environment,
          createdAt: now,
          updatedAt: now,
        };
        if (preferFront) profiles.profiles.unshift(profile);
        else profiles.profiles.push(profile);
        this.#probes.delete(profile.id);
        changed = true;
      };

      for (const builtin of BUILTIN_HARNESS_DEFAULTS) {
        seed(
          builtin.id,
          builtin.provider,
          builtin.name,
          builtin.binaryPath,
          builtin.homePath,
          "",
          [],
          builtin.provider === "claude-code",
        );
      }

      for (const adapter of options?.adapters ?? []) {
        seed(
          defaultProfileId(adapter.provider),
          adapter.provider,
          adapter.name,
          adapter.binaryPath,
          "",
          "",
          adapter.environment ?? [],
          false,
        );
      }

      if (changed) await writeDocument(this.#profilesPath, profiles);
      result = profiles.profiles.map((profile) => this.#snapshot(profile, secrets));
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  /**
   * Create the default profile for one provider if missing (adapter install path).
   * Does not overwrite an existing default the operator may have edited.
   */
  async ensureProviderDefault(seed: AdapterProfileSeed): Promise<ClaudeProfileSnapshot> {
    const id = defaultProfileId(seed.provider);
    const listed = await this.ensureDefaults({ adapters: [seed] });
    const found = listed.find((profile) => profile.id === id);
    if (!found) throw new ProfileError("Default provider profile could not be created.", 500);
    return found;
  }

  async list(options?: { adapters?: AdapterProfileSeed[] }): Promise<ClaudeProfileSnapshot[]> {
    return this.ensureDefaults(options);
  }

  async save(input: {
    id?: string;
    provider?: string;
    name: string;
    binaryPath?: string;
    homePath?: string;
    configPath?: string;
    environment?: ProfileEnvironmentVariable[];
  }): Promise<ClaudeProfileSnapshot> {
    const name = input.name.trim();
    if (!name) throw new ProfileError("A profile name is required.");
    const environment = input.environment ?? [];
    validateEnvironment(environment);
    const mutation = input.id ? this.#beginProfileMutation(input.id) : undefined;

    let result!: ClaudeProfileSnapshot;
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      const existing = input.id
        ? profiles.profiles.find((profile) => profile.id === input.id)
        : undefined;
      if (input.id && !existing) throw new ProfileError("The provider profile was not found.", 404);
      const id = existing?.id ?? randomUUID();
      const provider = (input.provider?.trim() || existing?.provider || "claude-code").trim();
      if (!provider) throw new ProfileError("A provider is required.");
      const binaryPath =
        input.binaryPath?.trim() ??
        existing?.binaryPath ??
        (provider === "claude-code"
          ? "claude"
          : provider === "codex-cli"
            ? "codex"
            : provider === "shikigami"
              ? "shikigami"
              : "");
      const homePath = input.homePath?.trim() ?? existing?.homePath ?? "";
      const configPath = input.configPath?.trim() ?? existing?.configPath ?? "";
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
        provider,
        name,
        binaryPath,
        homePath,
        configPath,
        environment: storedEnvironment,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const index = profiles.profiles.findIndex((item) => item.id === id);
      if (index === -1) profiles.profiles.push(profile);
      else profiles.profiles[index] = profile;
      await writeDocument(this.#secretsPath, secrets);
      await writeDocument(this.#profilesPath, profiles);
      if (mutation) this.#invalidateActiveProbes(id, mutation);
      this.#probes.delete(id);
      result = { ...publicProfile(profile, secrets), probes: emptyProbes() };
    });
    this.#writeQueue = operation.catch(() => undefined);
    try {
      await operation;
      return result;
    } finally {
      if (input.id && mutation) this.#endProfileMutation(input.id, mutation);
    }
  }

  async delete(id: string): Promise<void> {
    const mutation = this.#beginProfileMutation(id);
    const operation = this.#writeQueue.then(async () => {
      const { profiles, secrets } = await this.#documents();
      if (!profiles.profiles.some((profile) => profile.id === id)) {
        throw new ProfileError("The provider profile was not found.", 404);
      }
      profiles.profiles = profiles.profiles.filter((profile) => profile.id !== id);
      for (const key of Object.keys(secrets.values)) {
        if (key.startsWith(`${id}:`)) delete secrets.values[key];
      }
      await writeDocument(this.#secretsPath, secrets);
      await writeDocument(this.#profilesPath, profiles);
      this.#invalidateActiveProbes(id, mutation);
      this.#probes.delete(id);
    });
    this.#writeQueue = operation.catch(() => undefined);
    try {
      await operation;
    } finally {
      this.#endProfileMutation(id, mutation);
    }
  }

  async runtime(id: string): Promise<{
    profile: ClaudeProfile;
    executable: string;
    environment: NodeJS.ProcessEnv;
    /** Absolute explicit config path, or empty for Shikigami native resolution. */
    configPath: string;
    continuationKey: string;
  }> {
    const { profiles, secrets } = await this.#documents();
    const profile = profiles.profiles.find((item) => item.id === id);
    if (!profile) throw new ProfileError("Select an available provider profile.", 404);
    const environment: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of profile.environment) {
      environment[variable.name] = variable.sensitive
        ? (secrets.values[`${id}:${variable.name}`] ?? "")
        : (variable.value ?? "");
    }
    const resolvedHome = resolve(expandHome(profile.homePath || homedir()));
    if (profile.provider === "claude-code" && profile.homePath) {
      environment.CLAUDE_CONFIG_DIR = resolvedHome;
    }
    return {
      profile: publicProfile(profile, secrets),
      executable: profile.binaryPath,
      environment,
      configPath: profile.configPath ? resolve(expandHome(profile.configPath)) : "",
      continuationKey:
        profile.provider === "claude-code"
          ? `claude:home:${resolvedHome}`
          : `${profile.provider}:profile:${profile.id}`,
    };
  }

  async refresh(id: string, kind: ProfileProbeKind): Promise<ClaudeProfileSnapshot> {
    const key = `${id}\n${kind}`;
    const existing = this.#activeProbes.get(key);
    if (existing && !existing.invalidated && this.#awaitsCurrentMutations(id, existing)) {
      return existing.promise;
    }
    const active = {
      profileId: id,
      invalidated: false,
      awaitedMutations: new Set(this.#pendingProfileMutations.get(id) ?? []),
    } as ActiveProfileProbe;
    const operation = this.#refresh(id, kind, active).finally(() => {
      if (this.#activeProbes.get(key) === active) this.#activeProbes.delete(key);
      this.#runningProbes.delete(active);
    });
    active.promise = operation;
    this.#activeProbes.set(key, active);
    this.#runningProbes.add(active);
    return operation;
  }

  async #refresh(
    id: string,
    kind: ProfileProbeKind,
    active: ActiveProfileProbe,
  ): Promise<ClaudeProfileSnapshot> {
    await this.#writeQueue;
    const runtime = await this.runtime(id);
    if (active.invalidated) {
      throw new ProfileError("The provider profile changed while its probe was running.", 409);
    }
    const probes = structuredClone(this.#probes.get(id) ?? emptyProbes());
    probes[kind] = { state: "refreshing", checkedAt: null, detail: null };
    this.#storeProbeResult(id, kind, probes[kind], active);
    const checkedAt = new Date().toISOString();
    const isClaude = runtime.profile.provider === "claude-code";
    try {
      if (kind === "availability") {
        if (!runtime.executable.trim()) {
          throw new Error("No binary path configured.");
        }
        if (isAbsolute(runtime.executable)) await access(runtime.executable);
        const args =
          isClaude || runtime.profile.provider === "codex-cli"
            ? ["--version"]
            : runtime.profile.provider === "shikigami"
              ? ["version"]
              : ["--version"];
        await execFileAsync(runtime.executable, args, {
          env: runtime.environment,
          timeout: 5_000,
          encoding: "utf8",
        });
        probes.availability = {
          state: "ready",
          checkedAt,
          detail: `${runtime.profile.name} is available.`,
        };
      } else if (kind === "version") {
        const args =
          isClaude || runtime.profile.provider === "codex-cli"
            ? ["--version"]
            : runtime.profile.provider === "shikigami"
              ? ["version"]
              : ["--version"];
        const result = await execFileAsync(runtime.executable, args, {
          env: runtime.environment,
          timeout: 5_000,
          encoding: "utf8",
        });
        probes.version = {
          state: "ready",
          checkedAt,
          detail: `${result.stdout}\n${result.stderr}`.trim().split("\n")[0] || "Version detected.",
        };
      } else if (kind === "authentication") {
        if (!isClaude) {
          probes.authentication = {
            state: "ready",
            checkedAt,
            detail: "Authentication is owned by the provider CLI (not probed for this profile).",
            authenticated: true,
          };
        } else {
          const result = await execFileAsync(runtime.executable, ["auth", "status", "--json"], {
            env: runtime.environment,
            timeout: 8_000,
            encoding: "utf8",
          });
          const normalizedStatus = result.stdout.toLowerCase();
          let authenticated =
            !normalizedStatus.includes("not authenticated") &&
            !normalizedStatus.includes("not logged in") &&
            (normalizedStatus.includes("loggedin") ||
              normalizedStatus.includes("logged in") ||
              normalizedStatus.includes("authenticated"));
          try {
            const value = JSON.parse(result.stdout) as Record<string, unknown>;
            authenticated = value.loggedIn === true || value.authenticated === true;
          } catch {
            // Older Claude versions may return text despite accepting the command.
          }
          probes.authentication = {
            state: authenticated ? "ready" : "unavailable",
            checkedAt,
            detail: authenticated
              ? "Claude authentication is ready."
              : "Claude is not authenticated.",
            authenticated,
          };
        }
      } else if (isClaude) {
        probes.models = {
          state: "ready",
          checkedAt,
          detail: "Claude model aliases are available.",
          models: [...CLAUDE_PROBE_MODELS],
        };
      } else {
        probes.models = {
          state: "ready",
          checkedAt,
          detail: "Models are discovered at run time for this provider.",
          models: ["default"],
        };
      }
    } catch {
      probes[kind] = {
        state: "unavailable",
        checkedAt,
        detail:
          kind === "authentication"
            ? "Authentication could not be verified for this profile."
            : kind === "models"
              ? "Models could not be resolved for this profile."
              : `${runtime.profile.name} is unavailable for this profile.`,
        ...(kind === "authentication" ? { authenticated: false } : {}),
        ...(kind === "models" ? { models: [] } : {}),
      };
    }
    if (active.invalidated) {
      throw new ProfileError("The provider profile changed while its probe was running.", 409);
    }
    const currentProbes = this.#storeProbeResult(id, kind, probes[kind], active);
    return {
      ...runtime.profile,
      probes: structuredClone(currentProbes),
    };
  }
}

export const CLAUDE_MODEL_ALIASES: readonly string[] = DEFAULT_MODELS;

/** Preferred Claude probe list (T3 full slugs first). */
export const CLAUDE_PROBE_MODELS: readonly string[] = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
];
