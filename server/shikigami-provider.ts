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
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  type InteractionMode,
  type ProviderEvent,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
} from "./provider.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_SHIKIGAMI_MAJOR = 1;
/** inplace workspace + --task-file for private prompts. */
const MIN_PATCH_FOR_HOST = 2;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 30 * 60_000;
const EVENT_PREFIX = "[shikigami] ";

type JsonRecord = Record<string, unknown>;

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
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
  cleanup: () => Promise<void>;
  runId: string | null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function assertSupportedShikigamiVersion(output: string): string {
  const match = output.match(/shikigami\s+(\d+)\.(\d+)\.(\d+)/i)
    ?? output.match(/(\d+)\.(\d+)\.(\d+)/);
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
    return [{
      kind: "tool_started",
      toolCallId: tools.start(name),
      name,
    }];
  }
  if (event.type === "tool_end") {
    const name = typeof event.name === "string" ? event.name : "tool";
    return [{
      kind: "tool_finished",
      toolCallId: tools.end(name),
      failed: event.ok === false,
    }];
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
    const runId = typeof event.run_id === "string" ? event.run_id : "unknown";
    const success = event.success === true;
    const summary = typeof event.summary === "string" ? event.summary : "";
    if (!success) {
      return [{
        kind: "failed",
        message: summary || "Shikigami run reported failure.",
      }];
    }
    return [
      ...(summary ? [{ kind: "assistant_text" as const, text: summary }] : []),
      { kind: "turn_completed", sessionId: runId, costUsd: null },
    ];
  }
  if (
    event.type === "prompt"
    || event.type === "context_compacted"
    || event.type === "todos_updated"
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
 * Mutating tools are intentionally **not** exposed yet: shikigami does not
 * pause for mid-turn host approval, so enabling write/edit would bypass
 * Aldunis Code's PermissionBroker. Mode selection alone is not a substitute.
 * Read/search/report/todo remain available; bash stays opt-out.
 */
function toolsForMode(mode: InteractionMode): string[] {
  if (mode === "ask") {
    return ["read_file", "glob", "grep", "report"];
  }
  if (mode === "plan") {
    return ["read_file", "glob", "grep", "report", "todo_write"];
  }
  // build: same non-mutating set until host-approved mutation is wired.
  return ["read_file", "glob", "grep", "report", "todo_write"];
}

function escapeTomlString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

export function buildShikigamiConfig(options: {
  worktree: string;
  mode: InteractionMode;
  modelAdapter: "scripted" | "http";
  modelId: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  governanceAdapter?: string;
  failClosed?: boolean;
}): string {
  const tools = toolsForMode(options.mode)
    .map((name) => `"${name}"`)
    .join(", ");
  const modelBlock = options.modelAdapter === "http"
    ? `
[model]
adapter = "http"
model = "${escapeTomlString(options.modelId)}"
base_url = "${escapeTomlString(options.baseUrl ?? "https://api.openai.com/v1")}"
api_key_env = "${escapeTomlString(options.apiKeyEnv ?? "OPENAI_API_KEY")}"
`
    : `
[model]
adapter = "scripted"
`;
  const governanceAdapter = options.governanceAdapter ?? "local";
  const failClosed = options.failClosed ?? false;
  return `# Generated by Aldunis Code — do not commit.
version = 1

[profile]
name = "aldunis-code"

[governance]
adapter = "${escapeTomlString(governanceAdapter)}"
fail_closed = ${failClosed}

[workspace]
# inplace: use the selected Code worktree as the harness workspace (requires shikigami >= 1.0.1).
adapter = "inplace"
root = "${escapeTomlString(options.worktree)}"

[tools]
enabled = [${tools}]
bash_timeout_secs = 60

[run]
max_turns = 40

[events]
adapter = "stderr"
${modelBlock}
`;
}

function resolveModelAdapter(env: NodeJS.ProcessEnv): {
  adapter: "scripted" | "http";
  authenticated: boolean;
} {
  const forced = env.SHIKIGAMI_MODEL_ADAPTER;
  if (forced === "scripted") return { adapter: "scripted", authenticated: true };
  if (forced === "http") {
    const keyEnv = env.SHIKIGAMI_API_KEY_ENV ?? "OPENAI_API_KEY";
    return { adapter: "http", authenticated: Boolean(env[keyEnv]?.trim()) };
  }
  const keyEnv = env.SHIKIGAMI_API_KEY_ENV ?? "OPENAI_API_KEY";
  if (env[keyEnv]?.trim()) return { adapter: "http", authenticated: true };
  return { adapter: "scripted", authenticated: true };
}

export class ShikigamiAdapter {
  readonly id = "shikigami" as const;
  readonly #active = new Map<string, ActiveRun>();

  constructor(private readonly executable = "shikigami") {}

  async readiness(env: NodeJS.ProcessEnv = process.env): Promise<ShikigamiReadiness> {
    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["version"], {
        encoding: "utf8",
        timeout: 5_000,
        env,
      });
      version = assertSupportedShikigamiVersion(`${result.stdout}\n${result.stderr}`);
    } catch {
      return {
        id: this.id,
        installed: false,
        authenticated: false,
        version: null,
        models: [],
        name: "Shikigami",
      };
    }
    const { adapter, authenticated } = resolveModelAdapter(env);
    const models: ShikigamiModel[] = adapter === "scripted"
      ? [{ id: "scripted", displayName: "Scripted (offline)", isDefault: true }]
      : [
        {
          id: env.SHIKIGAMI_MODEL ?? "gpt-4.1-mini",
          displayName: env.SHIKIGAMI_MODEL ?? "HTTP model",
          isDefault: true,
        },
      ];
    return {
      id: this.id,
      installed: true,
      authenticated,
      version,
      models,
      name: "Shikigami",
    };
  }

  async start(
    options: ProviderStartOptions,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ProviderRun> {
    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["version"], {
        encoding: "utf8",
        timeout: 5_000,
        env,
      });
      version = assertSupportedShikigamiVersion(`${result.stdout}\n${result.stderr}`);
    } catch {
      throw new ProviderProtocolError("Shikigami is not installed or could not be started.");
    }
    void version;

    const { adapter: modelAdapter, authenticated } = resolveModelAdapter(env);
    if (modelAdapter === "http" && !authenticated) {
      throw new ProviderProtocolError(
        "Shikigami HTTP model requires an API key (OPENAI_API_KEY or SHIKIGAMI_API_KEY_ENV).",
      );
    }

    const modelId = options.model && options.model !== "default"
      ? options.model
      : modelAdapter === "scripted"
      ? "scripted"
      : (env.SHIKIGAMI_MODEL ?? "gpt-4.1-mini");

    // Conversation-scoped state outside the worktree so inplace tools cannot
    // read/write harness checkpoints (requires shikigami inplace safety).
    const conversationKey = options.conversationId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationKey)) {
      throw new ProviderProtocolError(
        "Shikigami provider requires a UUID conversation id for state isolation.",
      );
    }
    const stateRoot = join(homedir(), ".aldunis-code", "shikigami");
    const workDir = join(stateRoot, conversationKey);
    const resolvedWorkDir = join(stateRoot, conversationKey);
    if (!resolvedWorkDir.startsWith(stateRoot + "/") && resolvedWorkDir !== stateRoot) {
      throw new ProviderProtocolError("Invalid shikigami state path.");
    }
    const stateDir = join(workDir, "state");
    const configPath = join(workDir, "shikigami.toml");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      configPath,
      buildShikigamiConfig({
        worktree: options.worktree,
        mode: options.mode,
        modelAdapter,
        modelId,
        baseUrl: env.SHIKIGAMI_BASE_URL,
        apiKeyEnv: env.SHIKIGAMI_API_KEY_ENV ?? "OPENAI_API_KEY",
        governanceAdapter: env.SHIKIGAMI_GOVERNANCE_ADAPTER ?? "local",
        failClosed: env.SHIKIGAMI_FAIL_CLOSED === "1" || env.SHIKIGAMI_FAIL_CLOSED === "true",
      }),
      "utf8",
    );

    // Keep prompts off argv (process table privacy).
    const taskPath = join(workDir, "task.txt");
    await writeFile(taskPath, options.prompt, "utf8");
    const args = [
      "--config",
      configPath,
      "--state",
      stateDir,
      "run",
      // inplace workspaces must not be deleted; keep_workspace is still set for safety.
      "--keep-workspace",
      "--task-file",
      taskPath,
    ];
    // Each Code message is a fresh harness run. Checkpoint --resume is for
    // mid-run park recovery, not multi-turn chat continuation.
    void options.resumeSessionId;

    const id = randomUUID();
    const child = spawn(this.executable, args, {
      cwd: options.worktree,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
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
      // Persist conversation state for resume; do not wipe after each turn.
      cleanup: async () => undefined,
      runId: options.resumeSessionId
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.resumeSessionId)
        ? options.resumeSessionId
        : null,
    };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    this.#active.set(id, active);
    return { id, events: this.#events(id, active, options, stdoutPromise) };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
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
              message: error instanceof ProviderProtocolError
                ? error.message
                : "Shikigami emitted an unreadable event.",
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
              active.runId = event.sessionId;
              pendingTerminal = event;
              continue;
            }
            if (event.kind === "failed") {
              pendingTerminal = event;
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
            message: error instanceof ProviderProtocolError
              ? error.message
              : "Shikigami event stream failed.",
          };
        }
      }

      const stdout = await stdoutPromise.catch(() => "");
      if (!active.cancelled || (!sawTerminal && !pendingTerminal)) {
        const runMatch = stdout.match(/run\s+([0-9a-f-]{36})/i);
        if (runMatch) active.runId = runMatch[1];
        if (/parked reason=/i.test(stdout) || /termination=parked/i.test(stdout)) {
          sawTerminal = true;
          pendingTerminal = null;
          const resumeId = active.runId ?? "<run-id>";
          const reasonMatch = stdout.match(/parked reason=(.+)/i);
          const reason = reasonMatch?.[1]?.trim();
          yield {
            kind: "failed",
            message: reason
              ? `Shikigami parked: ${reason}. Resume is not wired in Aldunis Code yet; use the CLI: shikigami run --resume ${resumeId} --answer "...".`
              : `Shikigami parked awaiting an operator answer. Resume is not wired in Aldunis Code yet; use the CLI: shikigami run --resume ${resumeId} --answer "...".`,
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
        yield pendingTerminal;
      } else if (!sawTerminal) {
        const code = active.child.exitCode;
        if (code === 0) {
          yield {
            kind: "turn_completed",
            sessionId: active.runId ?? `shikigami-pending:${id}`,
            costUsd: null,
          };
        } else {
          yield {
            kind: "failed",
            message: code == null
              ? "Shikigami exited before completing the turn."
              : `Shikigami exited with code ${code}.`,
          };
        }
      }
    } finally {
      clearTimeout(timeout);
      this.#terminate(active.child);
      this.#active.delete(id);
      await active.cleanup();
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
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_000);
    force.unref();
  }
}
