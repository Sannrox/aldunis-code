/**
 * First-class Aldunis Code provider for Sannrox/shikigami.
 *
 * Spawns the unmodified `shikigami` CLI as a subprocess (not ACP). Events are
 * read from stderr lines emitted by the harness `stderr` event sink:
 *   [shikigami] {"type":"tool_start",...}
 *
 * Product boundary: Code owns conversation UX and worktrees; shikigami owns
 * the headless run loop and tool jail. Governance stays optional (local by
 * default; plane via config env if the operator configures it).
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import TOML from "@iarna/toml";
import { withElectronRunAsNode } from "./electron-runtime.ts";
import type { ManagedShikigamiRuntime } from "./managed-host.ts";
import { isMutatingTool, PermissionBroker } from "./permission.ts";
import {
  formatShikigamiModeViolation,
  SHIKIGAMI_MODE_VIOLATION_CODE,
  type InteractionMode,
  type ProviderEvent,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
} from "./provider.ts";
import { terminateProviderChild } from "./provider-process.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_SHIKIGAMI_MAJOR = 1;
/** inplace workspace + --task-file for private prompts. */
const MIN_PATCH_FOR_HOST = 2;
/** Native parked-run resume (--resume + --answer-file) shipped in v1.0.5. */
const MIN_PATCH_FOR_RESUME = 5;
/** Model catalog discovery was added to the Shikigami CLI in version 1.0.5. */
const MODEL_CATALOG_MIN_PATCH = 5;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 30 * 60_000;
const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const EVENT_PREFIX = "[shikigami] ";
/** Cap matches shikigami hook timeout_ms max (120s). */
const PRE_TOOL_HOOK_TIMEOUT_MS = 120_000;
const SHIKIGAMI_MUTATING_TOOLS = [
  "write_file",
  "edit",
  "multi_edit",
  "apply_patch",
  "bash",
  "bash_background",
] as const;
const PERMISSION_HOOK_PATH = fileURLToPath(
  new URL("./shikigami-permission-hook.mjs", import.meta.url),
);

type JsonRecord = Record<string, unknown>;
type ShikigamiModelAdapter = "scripted" | "http" | "plane";

export interface ShikigamiProfileRuntime {
  executable: string;
  environment: NodeJS.ProcessEnv;
  /** Empty means Shikigami's native config search order. */
  configPath: string;
}

export interface ShikigamiConfigSource {
  path: string | null;
  values: JsonRecord;
}

export interface ShikigamiModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface ShikigamiReadiness {
  id: "shikigami";
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  models: ShikigamiModel[];
  name: string;
  /** Operator-facing reason when the harness is not run-ready. */
  detail: string | null;
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
  cleanup: () => Promise<void>;
  expectedRunId: string | null;
  runId: string | null;
  governed: boolean;
  permissionToken: string;
}

type ShikigamiStartOptions = ProviderStartOptions & {
  /** Only populated by the host-side parked-run resume operation. */
  resumeAnswer?: string;
};

export type ShikigamiResumeOptions = ProviderStartOptions & {
  resumeSessionId: string;
};

const SHIKIGAMI_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function confirmShikigamiRunId(current: string | null, candidate: string): string {
  if (!SHIKIGAMI_RUN_ID.test(candidate)) {
    throw new ProviderProtocolError("Shikigami emitted a malformed run identity.");
  }
  const canonical = candidate.toLocaleLowerCase();
  if (current && current.toLocaleLowerCase() !== canonical) {
    throw new ProviderProtocolError("Shikigami emitted conflicting run identities.");
  }
  return canonical;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function assertSupportedShikigamiVersion(output: string): string {
  const match =
    output.match(/shikigami\s+(\d+)\.(\d+)\.(\d+)/i) ?? output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) !== SUPPORTED_SHIKIGAMI_MAJOR) {
    throw new ProviderProtocolError(
      `Unsupported shikigami version. Aldunis Code requires major version ${SUPPORTED_SHIKIGAMI_MAJOR}.`,
    );
  }
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (minor === 0 && patch < MIN_PATCH_FOR_HOST) {
    throw new ProviderProtocolError(
      "Unsupported shikigami version. Aldunis Code requires 1.0.2+ (inplace workspace + --task-file).",
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Whether this Shikigami version supports the model catalog command. */
export function supportsShikigamiModelCatalog(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > SUPPORTED_SHIKIGAMI_MAJOR ||
    (major === SUPPORTED_SHIKIGAMI_MAJOR &&
      (minor > 0 || (minor === 0 && patch >= MODEL_CATALOG_MIN_PATCH)))
  );
}

export function assertManagedShikigamiVersion(output: string): string {
  const version = assertSupportedShikigamiVersion(output);
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new ProviderProtocolError("Shikigami did not report a usable version.");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major < 1 || (major === 1 && minor === 0 && patch < 5)) {
    throw new ProviderProtocolError(
      "Managed hosted mode requires Shikigami 1.0.5+ with plane governance support.",
    );
  }
  return version;
}

/** Per-run tool id correlation (shikigami events lack a call id). */
export class ShikigamiToolIdTracker {
  #seq = 0;
  #open = new Map<string, string[]>();

  start(name: string): string {
    const id = `shikigami:${name}:${++this.#seq}`;
    const stack = this.#open.get(name) ?? [];
    stack.push(id);
    this.#open.set(name, stack);
    return id;
  }

  end(name: string): string {
    const stack = this.#open.get(name);
    const id = stack?.pop();
    if (!stack?.length) this.#open.delete(name);
    return id ?? `shikigami:${name}:orphan:${++this.#seq}`;
  }
}

/** Map a harness JSON event (after the `[shikigami]` prefix) to provider events. */
export function normalizeShikigamiEvent(
  value: unknown,
  tools: ShikigamiToolIdTracker = new ShikigamiToolIdTracker(),
): ProviderEvent[] {
  const event = record(value);
  if (!event || typeof event.type !== "string") {
    throw new ProviderProtocolError("Shikigami emitted a malformed event.");
  }
  if (event.type === "status") {
    return typeof event.status === "string"
      ? [{ kind: "assistant_text", text: `status: ${event.status}` }]
      : [];
  }
  if (event.type === "tool_start") {
    const name = typeof event.name === "string" ? event.name : "tool";
    return [
      {
        kind: "tool_started",
        toolCallId: tools.start(name),
        name,
      },
    ];
  }
  if (event.type === "tool_end") {
    const name = typeof event.name === "string" ? event.name : "tool";
    return [
      {
        kind: "tool_finished",
        toolCallId: tools.end(name),
        failed: event.ok === false,
      },
    ];
  }
  if (event.type === "model_turn") {
    // content_preview is truncated mid-turn progress; do not persist as assistant text
    // (run_finished summary carries the durable outcome).
    return [];
  }
  if (event.type === "message") {
    // Operator-facing harness messages only (not model body).
    const text = typeof event.text === "string" ? event.text.trim() : "";
    const level = typeof event.level === "string" ? event.level : "info";
    return text ? [{ kind: "assistant_text", text: `[${level}] ${text}` }] : [];
  }
  if (event.type === "run_finished") {
    const runId =
      typeof event.run_id === "string"
        ? confirmShikigamiRunId(null, event.run_id)
        : confirmShikigamiRunId(null, "");
    const success = event.success === true;
    const summary = typeof event.summary === "string" ? event.summary : "";
    if (!success) {
      return [
        {
          kind: "failed",
          message: summary || "Shikigami run reported failure.",
          sessionId: runId,
        },
      ];
    }
    return [
      ...(summary ? [{ kind: "assistant_text" as const, text: summary }] : []),
      { kind: "turn_completed", sessionId: runId, costUsd: null },
    ];
  }
  if (
    event.type === "prompt" ||
    event.type === "context_compacted" ||
    event.type === "todos_updated"
  ) {
    return [];
  }
  // Forward-compatible 1.x: ignore additive unknown event types.
  return [];
}

export function parseShikigamiStderrLine(
  line: string,
  tools: ShikigamiToolIdTracker = new ShikigamiToolIdTracker(),
): ProviderEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(EVENT_PREFIX)) return null;
  const payload = trimmed.slice(EVENT_PREFIX.length);
  try {
    return normalizeShikigamiEvent(JSON.parse(payload), tools);
  } catch (error) {
    if (error instanceof ProviderProtocolError) throw error;
    throw new ProviderProtocolError("Shikigami emitted invalid event JSON.");
  }
}

/**
 * Tool allow-lists by interaction mode.
 *
 * Build may expose mutating tools only when a fail-closed pre_tool hook gates
 * each invocation through PermissionBroker. Ask/Plan stay non-mutating.
 */
export function toolsForMode(mode: InteractionMode): string[] {
  if (mode === "ask") {
    return ["read_file", "glob", "grep", "report"];
  }
  if (mode === "plan") {
    return ["read_file", "glob", "grep", "report", "todo_write"];
  }
  return ["read_file", "glob", "grep", "report", "todo_write", ...SHIKIGAMI_MUTATING_TOOLS];
}

function managedToolsForMode(mode: InteractionMode): string[] {
  // The governance token is intentionally present only in the Shikigami
  // process. Managed hosted runs do not expose shell-capable tools, so an
  // agent-controlled command cannot inspect the provider environment.
  return toolsForMode(mode).filter((name) => !name.startsWith("bash"));
}

export function parseToolArgsJson(argsJson: unknown): Record<string, unknown> {
  if (typeof argsJson !== "string" || !argsJson.trim()) return {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function table(value: unknown): JsonRecord {
  return record(value) ?? {};
}

function stringSetting(section: unknown, key: string): string | undefined {
  const value = table(section)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanSetting(section: unknown, key: string): boolean | undefined {
  const value = table(section)[key];
  return typeof value === "boolean" ? value : undefined;
}

function configPathForCwd(input: string, cwd: string): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** Read native settings without modifying the operator's config file. */
export async function loadShikigamiConfig(
  options: {
    environment?: NodeJS.ProcessEnv;
    cwd?: string;
    explicitPath?: string;
  } = {},
): Promise<ShikigamiConfigSource> {
  const environment = options.environment ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicit = options.explicitPath?.trim() || environment.SHIKIGAMI_CONFIG?.trim() || "";
  const candidates = explicit
    ? [configPathForCwd(explicit, cwd)]
    : [
        configPathForCwd(environment.SHIKIGAMI_STATE?.trim() || ".shikigami-state", cwd),
        join(cwd, "shikigami.toml"),
      ].map((candidate) =>
        candidate.endsWith(".toml") ? candidate : join(candidate, "shikigami.toml"),
      );

  for (const path of candidates) {
    try {
      const source = await readFile(path, "utf8");
      let parsed: unknown;
      try {
        parsed = TOML.parse(source);
      } catch {
        throw new ProviderProtocolError("The selected Shikigami config could not be parsed.");
      }
      const values = record(parsed);
      if (!values)
        throw new ProviderProtocolError("The selected Shikigami config is not a TOML table.");
      return { path, values };
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicit) continue;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProviderProtocolError("The selected Shikigami config file was not found.");
      }
      throw new ProviderProtocolError("The selected Shikigami config could not be read.");
    }
  }
  return { path: null, values: {} };
}

function nativeConfigHasGovernedProfile(config: JsonRecord): boolean {
  return (
    stringSetting(config.profile, "name")?.toLowerCase() === "governed" &&
    Object.keys(table(config.model)).length === 0
  );
}

/** Parse the stable JSON model catalog emitted by Shikigami. */
export function parseShikigamiModelCatalog(output: string): ShikigamiModel[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return [];
  }
  const root = record(value);
  const rows = root && Array.isArray(root.available_models) ? root.available_models : [];
  const defaultModel = typeof root?.default_model === "string" ? root.default_model.trim() : "";
  const seen = new Set<string>();
  const models: ShikigamiModel[] = [];
  for (const row of rows) {
    const entry = record(row);
    const id = stringSetting(entry, "canonical_model") || stringSetting(entry, "upstream_model");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      displayName: id === "auto" ? "Auto (Sekai-Chisei)" : id,
      isDefault: defaultModel ? id === defaultModel : models.length === 0,
    });
  }
  return models;
}

async function probeShikigamiModelCatalog(options: {
  executable: string;
  environment: NodeJS.ProcessEnv;
  configPath?: string;
  cwd?: string;
  version: string;
}): Promise<ShikigamiModel[]> {
  if (!supportsShikigamiModelCatalog(options.version)) return [];
  const args = options.configPath
    ? ["--config", options.configPath, "doctor", "--models", "--json"]
    : ["doctor", "--models", "--json"];
  try {
    const result = await execFileAsync(options.executable, args, {
      encoding: "utf8",
      timeout: MODEL_CATALOG_TIMEOUT_MS,
      env: options.environment,
      cwd: options.cwd,
    });
    return parseShikigamiModelCatalog(result.stdout);
  } catch {
    // Discovery is a readiness projection. Keep the configured model visible
    // when the catalog command is unavailable or the CLI is older.
    return [];
  }
}

export function resolveModelAdapter(
  environment: NodeJS.ProcessEnv,
  baseConfig: JsonRecord = {},
): {
  adapter: ShikigamiModelAdapter;
  authenticated: boolean;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
} {
  const model = table(baseConfig.model);
  const configuredAdapter =
    stringSetting(model, "adapter") ??
    (stringSetting(baseConfig.profile, "name")?.toLowerCase() === "governed" ? "plane" : undefined);
  const forced = environment.SHIKIGAMI_MODEL_ADAPTER?.trim().toLowerCase();
  const apiKeyEnv =
    environment.SHIKIGAMI_API_KEY_ENV?.trim() ||
    stringSetting(model, "api_key_env") ||
    "OPENAI_API_KEY";
  const adapterName =
    forced || configuredAdapter || (environment[apiKeyEnv]?.trim() ? "http" : "scripted");
  if (adapterName !== "scripted" && adapterName !== "http" && adapterName !== "plane") {
    throw new ProviderProtocolError(`Unsupported Shikigami model adapter: ${adapterName}.`);
  }
  const modelId =
    environment.SHIKIGAMI_MODEL?.trim() ||
    stringSetting(model, "model") ||
    (adapterName === "scripted" ? "scripted" : "gpt-4.1-mini");
  return {
    adapter: adapterName,
    authenticated: adapterName !== "http" || Boolean(environment[apiKeyEnv]?.trim()),
    modelId,
    baseUrl:
      environment.SHIKIGAMI_BASE_URL?.trim() ||
      stringSetting(model, "base_url") ||
      "https://api.openai.com/v1",
    apiKeyEnv,
  };
}

export function buildShikigamiConfig(options: {
  worktree: string;
  mode: InteractionMode;
  modelAdapter: ShikigamiModelAdapter;
  modelId: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  governanceAdapter?: string;
  failClosed?: boolean;
  /** Native TOML values used as the non-Code-owned baseline. */
  baseConfig?: JsonRecord;
  /** Keep Shikigami's governed profile expansion when no model table exists. */
  preserveNativeModel?: boolean;
  /** Absolute path to node binary for the pre_tool permission hook. */
  nodeExecutable?: string;
  /** Absolute path to shikigami-permission-hook.mjs. */
  permissionHookPath?: string;
  /** Absolute path to JSON broker config for the permission hook. */
  permissionConfigPath?: string;
  /** Fixed operator-owned managed profile; no caller-selected model or governance. */
  managed?: ManagedShikigamiRuntime;
}): string {
  const config = structuredClone(options.baseConfig ?? {}) as JsonRecord;
  const tools = options.managed ? managedToolsForMode(options.mode) : toolsForMode(options.mode);
  const baseProfile = table(config.profile);
  config.version = 1;
  config.profile = {
    ...baseProfile,
    name: options.managed ? "aldunis-code-managed" : (baseProfile.name ?? "aldunis-code"),
  };
  // Workspace, tools, events, and the Code approval hook are host-owned.
  config.workspace = { adapter: "inplace", root: options.worktree };
  const baseTools = table(config.tools);
  config.tools = {
    mode: "custom",
    enabled: tools,
    bash_timeout_secs: 60,
    ...(typeof baseTools.respect_ignore === "boolean"
      ? { respect_ignore: baseTools.respect_ignore }
      : {}),
    // Native MCP definitions are not implicitly imported into Code runs.
    mcp_servers: [],
  };
  config.run = { ...table(config.run), max_turns: 40 };
  config.events = { ...table(config.events), adapter: "stderr" };

  if (options.managed) {
    config.governance = {
      adapter: "sekai-chisei",
      endpoint: options.managed.governanceEndpoint,
      principal: options.managed.principal,
      namespace: options.managed.namespace,
      fail_closed: true,
      token_env: options.managed.tokenEnv,
    };
    config.model = { adapter: "plane", model: options.managed.model };
  } else {
    const governance = table(config.governance);
    if (options.governanceAdapter !== undefined) governance.adapter = options.governanceAdapter;
    if (options.failClosed !== undefined) governance.fail_closed = options.failClosed;
    if (!options.baseConfig && options.governanceAdapter === undefined) {
      governance.adapter = "local";
      governance.fail_closed = options.failClosed ?? false;
    }
    if (Object.keys(governance).length > 0) config.governance = governance;
    else delete config.governance;

    const model = table(config.model);
    if (!(options.preserveNativeModel && Object.keys(model).length === 0)) {
      model.adapter = options.modelAdapter;
      if (options.modelAdapter === "http") {
        model.model = options.modelId;
        model.base_url = options.baseUrl ?? "https://api.openai.com/v1";
        model.api_key_env = options.apiKeyEnv ?? "OPENAI_API_KEY";
      } else if (options.modelAdapter === "plane") {
        model.model = options.modelId;
      }
      config.model = model;
    } else {
      delete config.model;
    }
  }

  const hooks = Array.isArray(config.hooks)
    ? config.hooks.filter((hook): hook is JsonRecord => record(hook) !== null)
    : [];
  const permissionHook =
    options.nodeExecutable && options.permissionHookPath && options.permissionConfigPath
      ? {
          event: "pre_tool",
          command: options.nodeExecutable,
          args: [options.permissionHookPath, options.permissionConfigPath],
          timeout_ms: PRE_TOOL_HOOK_TIMEOUT_MS,
          fail_closed: true,
        }
      : null;
  if (permissionHook) config.hooks = [...hooks, permissionHook];
  else if (hooks.length > 0) config.hooks = hooks;
  else delete config.hooks;
  return `# Generated by Aldunis Code — private per-run overlay; source config is not modified.\n${TOML.stringify(config as never)}`;
}

/**
 * Electron's process.execPath is the Electron executable, not a standalone
 * Node binary. The Shikigami permission hook inherits this environment and
 * needs Electron's documented Node mode to execute the bundled .mjs hook.
 */
export function permissionHookRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  electronVersion: string | undefined = process.versions.electron,
): NodeJS.ProcessEnv {
  return withElectronRunAsNode(env, electronVersion);
}

/**
 * Managed Shikigami receives a small deterministic runtime environment. In
 * particular, no provider, source-control, proxy, platform, or host-home
 * credential variables are inherited from the Code process.
 */
export function managedShikigamiEnvironment(
  runtime: ManagedShikigamiRuntime,
  workDir: string,
  electronVersion: string | undefined = process.versions.electron,
): NodeJS.ProcessEnv {
  return withElectronRunAsNode(
    {
      PATH: runtime.path ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: workDir,
      TMPDIR: join(workDir, "tmp"),
      TMP: join(workDir, "tmp"),
      TEMP: join(workDir, "tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      [runtime.tokenEnv]: runtime.token,
    },
    electronVersion,
  );
}

export class ShikigamiAdapter {
  readonly id = "shikigami" as const;
  readonly #active = new Map<string, ActiveRun>();

  constructor(
    private readonly executable = "shikigami",
    private readonly permissions = new PermissionBroker(),
  ) {}

  async readiness(
    env: NodeJS.ProcessEnv = process.env,
    options: { executable?: string; configPath?: string; cwd?: string } = {},
  ): Promise<ShikigamiReadiness> {
    const executable = options.executable ?? this.executable;
    let version: string;
    try {
      const result = await execFileAsync(executable, ["version"], {
        encoding: "utf8",
        timeout: 5_000,
        env,
      });
      try {
        version = assertSupportedShikigamiVersion(`${result.stdout}\n${result.stderr}`);
      } catch (error) {
        const detail =
          error instanceof ProviderProtocolError
            ? error.message
            : "Unsupported shikigami version. Aldunis Code requires 1.0.2+.";
        return {
          id: this.id,
          installed: true,
          authenticated: false,
          version: null,
          models: [],
          name: "Shikigami",
          detail,
        };
      }
    } catch {
      return {
        id: this.id,
        installed: false,
        authenticated: false,
        version: null,
        models: [],
        name: "Shikigami",
        detail: "Install shikigami 1.0.2+ on PATH (tenkai or GitHub Release).",
      };
    }
    let config: ShikigamiConfigSource;
    try {
      config = await loadShikigamiConfig({
        environment: env,
        cwd: options.cwd,
        explicitPath: options.configPath,
      });
    } catch (error) {
      return {
        id: this.id,
        installed: true,
        authenticated: false,
        version,
        models: [],
        name: "Shikigami",
        detail:
          error instanceof ProviderProtocolError
            ? error.message
            : "The selected Shikigami config could not be loaded.",
      };
    }
    let resolved: ReturnType<typeof resolveModelAdapter>;
    try {
      resolved = resolveModelAdapter(env, config.values);
    } catch (error) {
      return {
        id: this.id,
        installed: true,
        authenticated: false,
        version,
        models: [],
        name: "Shikigami",
        detail:
          error instanceof ProviderProtocolError
            ? error.message
            : "The selected Shikigami model configuration is invalid.",
      };
    }
    const { adapter, authenticated, modelId, apiKeyEnv } = resolved;
    const discoveredModels =
      authenticated && (adapter === "plane" || modelId === "auto")
        ? await probeShikigamiModelCatalog({
            executable,
            environment: env,
            configPath: options.configPath,
            cwd: options.cwd,
            version,
          })
        : [];
    const configuredModels: ShikigamiModel[] =
      adapter === "scripted"
        ? [{ id: "scripted", displayName: "Scripted (offline)", isDefault: true }]
        : [
            {
              id: modelId,
              displayName: adapter === "plane" ? modelId : modelId || "HTTP model",
              isDefault: true,
            },
          ];
    const models = discoveredModels.length > 0 ? discoveredModels : configuredModels;
    const detail =
      !authenticated && adapter === "http"
        ? `Set ${apiKeyEnv}, or force SHIKIGAMI_MODEL_ADAPTER=scripted.`
        : null;
    return {
      id: this.id,
      installed: true,
      authenticated,
      version,
      models,
      name: "Shikigami",
      detail,
    };
  }

  async start(
    options: ShikigamiStartOptions,
    env: NodeJS.ProcessEnv = process.env,
    managed?: ManagedShikigamiRuntime,
    profile?: ShikigamiProfileRuntime,
  ): Promise<ProviderRun> {
    // Conversation-scoped state outside the worktree so inplace tools cannot
    // read/write harness checkpoints (requires shikigami inplace safety).
    const conversationKey = options.conversationId.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        conversationKey,
      )
    ) {
      throw new ProviderProtocolError(
        "Shikigami provider requires a UUID conversation id for state isolation.",
      );
    }
    const stateRoot = managed?.stateRoot ?? join(homedir(), ".aldunis-code", "shikigami");
    const workDir = join(stateRoot, conversationKey);
    const resolvedWorkDir = join(stateRoot, conversationKey);
    if (!resolvedWorkDir.startsWith(stateRoot + "/") && resolvedWorkDir !== stateRoot) {
      throw new ProviderProtocolError("Invalid shikigami state path.");
    }
    const stateDir = join(workDir, "state");
    const configPath = join(workDir, "shikigami.toml");
    const permissionConfigPath = join(workDir, "permission-gate.json");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(join(workDir, "tmp"), { recursive: true, mode: 0o700 });

    const sourceEnvironment = profile?.environment ?? env;
    const executable = managed?.executable ?? profile?.executable ?? this.executable;
    const childEnvironment = managed
      ? managedShikigamiEnvironment(managed, workDir)
      : permissionHookRuntimeEnvironment(sourceEnvironment);
    const nativeConfig = managed
      ? { path: null, values: {} as JsonRecord }
      : await loadShikigamiConfig({
          environment: sourceEnvironment,
          cwd: options.worktree,
          explicitPath: profile?.configPath,
        });
    let version: string;
    try {
      const result = await execFileAsync(executable, ["version"], {
        encoding: "utf8",
        timeout: 5_000,
        env: childEnvironment,
      });
      version = managed
        ? assertManagedShikigamiVersion(`${result.stdout}\n${result.stderr}`)
        : assertSupportedShikigamiVersion(`${result.stdout}\n${result.stderr}`);
    } catch (error) {
      if (error instanceof ProviderProtocolError) throw error;
      throw new ProviderProtocolError("Shikigami is not installed or could not be started.");
    }
    void version;

    const resolvedModel = managed
      ? {
          adapter: "plane" as const,
          authenticated: true,
          modelId: managed.model,
          baseUrl: "",
          apiKeyEnv: "",
        }
      : resolveModelAdapter(sourceEnvironment, nativeConfig.values);
    const { adapter: modelAdapter, authenticated } = resolvedModel;
    if (!managed && modelAdapter === "http" && !authenticated) {
      throw new ProviderProtocolError(
        `Shikigami HTTP model requires an API key (${resolvedModel.apiKeyEnv}).`,
      );
    }

    const modelId = managed
      ? managed.model
      : options.model && options.model !== "default"
        ? options.model
        : resolvedModel.modelId;
    const baseGovernance = table(nativeConfig.values.governance);
    const governanceAdapter = managed
      ? undefined
      : sourceEnvironment.SHIKIGAMI_GOVERNANCE_ADAPTER?.trim() ||
        stringSetting(baseGovernance, "adapter") ||
        (nativeConfig.path ? undefined : "local");
    const failClosed = managed
      ? undefined
      : sourceEnvironment.SHIKIGAMI_FAIL_CLOSED !== undefined
        ? sourceEnvironment.SHIKIGAMI_FAIL_CLOSED === "1" ||
          sourceEnvironment.SHIKIGAMI_FAIL_CLOSED.toLowerCase() === "true"
        : (booleanSetting(baseGovernance, "fail_closed") ??
          (nativeConfig.path ? undefined : false));

    const id = randomUUID();
    const permissionToken = this.permissions.createRunToken(id);
    await writeFile(
      permissionConfigPath,
      JSON.stringify({
        approvalUrl: options.approvalUrl,
        runId: id,
        token: permissionToken,
        mutatingTools: [...SHIKIGAMI_MUTATING_TOOLS],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      configPath,
      buildShikigamiConfig({
        worktree: options.worktree,
        mode: options.mode,
        modelAdapter,
        modelId,
        baseUrl: resolvedModel.baseUrl,
        apiKeyEnv: resolvedModel.apiKeyEnv,
        governanceAdapter,
        failClosed,
        baseConfig: nativeConfig.path !== null ? nativeConfig.values : undefined,
        preserveNativeModel:
          nativeConfig.path !== null && nativeConfigHasGovernedProfile(nativeConfig.values),
        nodeExecutable: process.execPath,
        permissionHookPath: PERMISSION_HOOK_PATH,
        permissionConfigPath,
        managed,
      }),
      "utf8",
    );

    // Keep prompts off argv (process table privacy).
    const resumeId = options.resumeSessionId
      ? confirmShikigamiRunId(null, options.resumeSessionId)
      : null;
    if (resumeId) {
      const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
      const supportsResume =
        versionMatch &&
        Number(versionMatch[1]) === SUPPORTED_SHIKIGAMI_MAJOR &&
        (Number(versionMatch[2]) > 0 ||
          (Number(versionMatch[2]) === 0 && Number(versionMatch[3]) >= MIN_PATCH_FOR_RESUME));
      if (!supportsResume) {
        throw new ProviderProtocolError(
          "Native Shikigami parked-run resume requires Shikigami 1.0.5+.",
        );
      }
    }
    let answerPath: string | null = null;
    if (resumeId) {
      if (!options.resumeAnswer?.trim()) {
        throw new ProviderProtocolError("A parked Shikigami run requires a non-empty answer.");
      }
      answerPath = join(workDir, "tmp", `resume-${randomUUID()}.answer`);
      try {
        await writeFile(answerPath, options.resumeAnswer, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await rm(answerPath, { force: true });
        throw error;
      }
    }
    const args = [
      "--config",
      configPath,
      "--state",
      stateDir,
      "run",
      // inplace workspaces must not be deleted; keep_workspace is still set for safety.
      "--keep-workspace",
      ...(resumeId
        ? ["--resume", resumeId, "--answer-file", answerPath!]
        : (() => {
            const taskPath = join(workDir, "task.txt");
            return ["--task-file", taskPath];
          })()),
    ];
    if (!resumeId) {
      // Keep prompts off argv (process table privacy).
      await writeFile(join(workDir, "task.txt"), options.prompt, "utf8");
    }

    const child = spawn(executable, args, {
      cwd: options.worktree,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...childEnvironment,
        // Prefer explicit paths over ambient host config for this run.
        SHIKIGAMI_CONFIG: configPath,
        SHIKIGAMI_STATE: stateDir,
      },
    });
    // Drain stdout immediately so a large summary cannot fill the pipe and
    // deadlock the process while we still read stderr.
    const stdoutPromise = this.#readAll(child.stdout);
    const active: ActiveRun = {
      child,
      cancelled: false,
      spawnFailed: false,
      cleanup: async () => {
        if (answerPath) await rm(answerPath, { force: true });
      },
      expectedRunId: resumeId,
      runId: null,
      governed: Boolean(
        managed ||
        governanceAdapter === "sekai-chisei" ||
        sourceEnvironment.SHIKIGAMI_PROFILE?.trim().toLowerCase() === "governed" ||
        stringSetting(nativeConfig.values.profile, "name")?.toLowerCase() === "governed",
      ),
      permissionToken,
    };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    this.#active.set(id, active);
    return { id, events: this.#events(id, active, options, stdoutPromise) };
  }

  async resumeParked(
    options: ShikigamiResumeOptions,
    answer: string,
    env: NodeJS.ProcessEnv = process.env,
    managed?: ManagedShikigamiRuntime,
    profile?: ShikigamiProfileRuntime,
  ): Promise<ProviderRun> {
    return this.start({ ...options, resumeAnswer: answer }, env, managed, profile);
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    this.permissions.closeRun(id, "cancelled");
    this.#terminate(active.child);
    return true;
  }

  async *#events(
    id: string,
    active: ActiveRun,
    options: ProviderStartOptions,
    stdoutPromise: Promise<string>,
  ): AsyncGenerator<ProviderEvent> {
    const timeout = setTimeout(() => {
      active.cancelled = true;
      this.#terminate(active.child);
    }, RUN_TIMEOUT_MS);
    timeout.unref();

    let sawTerminal = false;
    let correlationEmitted = false;
    // Buffer run_finished terminals until stdout is inspected so parked runs
    // can replace a generic failure with CLI resume guidance.
    let pendingTerminal: ProviderEvent | null = null;
    const toolIds = new ShikigamiToolIdTracker();
    try {
      // Do not advertise a local provider-run UUID as a shikigami resume id.
      // The real harness run_id arrives on run_finished / turn_completed.
      yield {
        kind: "session_started",
        sessionId: active.runId ?? `shikigami-pending:${id}`,
        model: options.model ?? null,
      };

      try {
        for await (const line of this.#stderrLines(active.child)) {
          if (active.cancelled) break;
          let events: ProviderEvent[] | null;
          try {
            events = parseShikigamiStderrLine(line, toolIds);
          } catch (error) {
            sawTerminal = true;
            pendingTerminal = null;
            yield {
              kind: "failed",
              message:
                error instanceof ProviderProtocolError
                  ? error.message
                  : "Shikigami emitted an unreadable event.",
              ...(error instanceof ProviderProtocolError
                ? { code: "provider_protocol_error" as const }
                : {}),
            };
            active.cancelled = true;
            this.#terminate(active.child);
            break;
          }
          if (!events) continue;
          for (const event of events) {
            if (active.cancelled && event.kind !== "failed") break;
            if (event.kind === "session_started") continue;
            if (event.kind === "turn_completed") {
              try {
                active.runId = confirmShikigamiRunId(active.runId, event.sessionId);
                if (active.expectedRunId && active.runId !== active.expectedRunId) {
                  throw new ProviderProtocolError(
                    "Shikigami resume reported a different run identity.",
                  );
                }
              } catch (error) {
                sawTerminal = true;
                pendingTerminal = null;
                active.cancelled = true;
                this.#terminate(active.child);
                yield {
                  kind: "failed",
                  message:
                    error instanceof ProviderProtocolError
                      ? error.message
                      : "Shikigami emitted an invalid run identity.",
                  code: "provider_protocol_error",
                };
                break;
              }
              pendingTerminal = event;
              continue;
            }
            if (event.kind === "failed") {
              if (event.sessionId) {
                try {
                  active.runId = confirmShikigamiRunId(active.runId, event.sessionId);
                  if (active.expectedRunId && active.runId !== active.expectedRunId) {
                    throw new ProviderProtocolError(
                      "Shikigami resume reported a different run identity.",
                    );
                  }
                } catch (error) {
                  sawTerminal = true;
                  pendingTerminal = null;
                  active.cancelled = true;
                  this.#terminate(active.child);
                  yield {
                    kind: "failed",
                    message:
                      error instanceof ProviderProtocolError
                        ? error.message
                        : "Shikigami emitted an invalid run identity.",
                    code: "provider_protocol_error",
                  };
                  break;
                }
              }
              pendingTerminal = event;
              continue;
            }
            if (event.kind === "tool_started") {
              yield event;
              const rawInput = this.#toolStartInput(line);
              if (isMutatingTool(event.name)) {
                if (options.mode !== "build") {
                  sawTerminal = true;
                  pendingTerminal = null;
                  yield {
                    kind: "failed",
                    code: SHIKIGAMI_MODE_VIOLATION_CODE,
                    message: formatShikigamiModeViolation(event.name, options.mode),
                    toolName: event.name,
                    mode: options.mode,
                  };
                  active.cancelled = true;
                  this.permissions.closeRun(id, "provider_failed");
                  this.#terminate(active.child);
                  break;
                }
                const approval = this.permissions.register({
                  runId: id,
                  conversationId: options.conversationId,
                  repository: options.repository,
                  worktree: options.worktree,
                  toolCallId: event.toolCallId,
                  toolName: event.name,
                  toolInput: rawInput,
                  provider: "Shikigami",
                });
                if (approval) yield { kind: "approval_pending", ...approval };
              }
              continue;
            }
            if (event.kind === "tool_finished") {
              yield event;
              const approval = this.permissions.approvalFor(id, event.toolCallId);
              if (approval && approval.state !== "pending") {
                yield { kind: "approval_resolved", id: approval.id, state: approval.state };
              }
              continue;
            }
            yield event;
          }
        }
      } catch (error) {
        if (!sawTerminal && !pendingTerminal) {
          sawTerminal = true;
          yield {
            kind: "failed",
            message:
              error instanceof ProviderProtocolError
                ? error.message
                : "Shikigami event stream failed.",
          };
        }
      }

      const stdout = await stdoutPromise.catch(() => "");
      if (!active.cancelled) {
        const runMatch = stdout.match(/run\s+([0-9a-f-]{36})/i);
        if (runMatch) {
          try {
            active.runId = confirmShikigamiRunId(active.runId, runMatch[1]);
            if (active.expectedRunId && active.runId !== active.expectedRunId) {
              throw new ProviderProtocolError(
                "Shikigami resume reported a different run identity.",
              );
            }
          } catch (error) {
            sawTerminal = true;
            pendingTerminal = null;
            active.cancelled = true;
            this.#terminate(active.child);
            yield {
              kind: "failed",
              message:
                error instanceof ProviderProtocolError
                  ? error.message
                  : "Shikigami emitted an invalid run identity.",
              code: "provider_protocol_error",
            };
          }
        }
        if (!active.cancelled && active.governed && active.runId) {
          correlationEmitted = true;
          yield {
            kind: "governance_correlation",
            governance: "sekai-chisei",
            runId: active.runId,
            operationId: active.runId,
          };
        }
        if (
          !active.cancelled &&
          (/parked reason=/i.test(stdout) || /termination=parked/i.test(stdout))
        ) {
          sawTerminal = true;
          pendingTerminal = null;
          const resumeId = active.runId ?? "<run-id>";
          const reasonMatch = stdout.match(/parked reason=(.+)/i);
          const reason = reasonMatch?.[1]?.trim();
          const questionMatch = stdout.match(/parked question=(.+)/i);
          const question = questionMatch?.[1]?.trim();
          yield {
            kind: "input_requested",
            id: randomUUID(),
            question: question || reason || "Shikigami is waiting for operator input.",
            choices: [],
            recommendation: null,
            responseMode: active.runId ? "native_resume" : "child_follow_up",
            providerRequestId: resumeId === "<run-id>" ? null : resumeId,
            expiresAt: null,
            allowFreeForm: true,
          };
        }
      }

      await new Promise<void>((resolve) => {
        if (active.child.exitCode !== null || active.child.signalCode !== null) {
          resolve();
          return;
        }
        const done = () => resolve();
        active.child.once("close", done);
        setTimeout(() => {
          this.#terminate(active.child);
          done();
        }, 2_000).unref();
      });

      if (active.spawnFailed) {
        if (!sawTerminal && !pendingTerminal) {
          yield { kind: "failed", message: "Shikigami could not be started." };
        } else if (pendingTerminal?.kind === "failed") {
          sawTerminal = true;
          yield pendingTerminal;
        }
        return;
      }
      if (active.cancelled) {
        if (!sawTerminal) yield { kind: "cancelled" };
        return;
      }
      if (pendingTerminal) {
        sawTerminal = true;
        if (active.governed && active.runId && !correlationEmitted) {
          yield {
            kind: "governance_correlation",
            governance: "sekai-chisei",
            runId: active.runId,
            operationId: active.runId,
          };
        }
        yield pendingTerminal;
      } else if (!sawTerminal) {
        const code = active.child.exitCode;
        if (code === 0) {
          if (active.expectedRunId && !active.runId) {
            yield {
              kind: "failed",
              message: "Shikigami resume did not confirm the requested run identity.",
              code: "provider_protocol_error",
            };
            return;
          }
          if (active.governed && !active.runId) {
            yield {
              kind: "failed",
              message: "Shikigami completed without a provider-confirmed run identity.",
              code: "provider_protocol_error",
            };
          } else {
            yield {
              kind: "turn_completed",
              sessionId: active.runId ?? `shikigami-pending:${id}`,
              costUsd: null,
            };
          }
        } else {
          yield {
            kind: "failed",
            message:
              code == null
                ? "Shikigami exited before completing the turn."
                : `Shikigami exited with code ${code}.`,
          };
        }
      }
    } finally {
      clearTimeout(timeout);
      this.permissions.closeRun(id, active.cancelled ? "cancelled" : "provider_failed");
      this.#terminate(active.child);
      this.#active.delete(id);
      await active.cleanup();
    }
  }

  #toolStartInput(line: string): Record<string, unknown> {
    const trimmed = line.trim();
    if (!trimmed.startsWith(EVENT_PREFIX)) return {};
    try {
      const payload = JSON.parse(trimmed.slice(EVENT_PREFIX.length)) as unknown;
      const event = record(payload);
      if (!event || event.type !== "tool_start") return {};
      return parseToolArgsJson(event.args_json);
    } catch {
      return {};
    }
  }

  async *#stderrLines(child: ChildProcessWithoutNullStreams): AsyncGenerator<string> {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    for await (const chunk of child.stderr) {
      buffer += decoder.write(chunk as Buffer);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.length > MAX_PROVIDER_LINE_BYTES) {
          throw new ProviderProtocolError("Shikigami event line exceeded the size limit.");
        }
        yield line;
        index = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_PROVIDER_LINE_BYTES) {
        throw new ProviderProtocolError("Shikigami event line exceeded the size limit.");
      }
    }
    buffer += decoder.end();
    if (buffer) yield buffer;
  }

  #readAll(stream: NodeJS.ReadableStream, maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      stream.on("data", (chunk) => {
        if (truncated) return;
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          truncated = true;
          chunks.push(buffer.subarray(0, Math.max(0, maxBytes - (total - buffer.length))));
          // Stop retaining more data; still consume to unblock the child.
          return;
        }
        chunks.push(buffer);
      });
      stream.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(truncated ? `${text}\n…[stdout truncated]` : text);
      });
      stream.on("error", reject);
    });
  }

  #terminate(child: ChildProcessWithoutNullStreams): void {
    terminateProviderChild(child, 1_000);
  }
}
