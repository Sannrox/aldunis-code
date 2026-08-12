import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { MAX_APPROVAL_PATHS, PermissionBroker } from "./permission.ts";
import {
  CODEX_PROCESS_EXIT_MESSAGE,
  CODEX_PROTOCOL_FALLBACK_MESSAGE,
  CODEX_UNSUPPORTED_ITEM_MESSAGE,
  CODEX_UNSUPPORTED_NOTIFICATION_MESSAGE,
  CODEX_UNSUPPORTED_TURN_STATUS_MESSAGE,
  type ProviderEvent,
  type ProviderRun,
  type ProviderBrowserMcpConfiguration,
  type ProviderStartOptions,
  ProviderProtocolError,
  type ReasoningEffort,
  UNSUPPORTED_EXTERNAL_TOOL_MESSAGE,
} from "./provider.ts";
import { normalizeBrowserObservation } from "./browser-observation.ts";
import { BROWSER_MCP_NAME } from "./browser.ts";
import { scheduleProviderChildTermination, terminateProviderChild } from "./provider-process.ts";

const execFileAsync = promisify(execFile);
/** Major line of the app-server protocol we speak. */
const SUPPORTED_CODEX_MAJOR = 0;
/**
 * Minimum minor on the 0.x line. Exact minor pins blocked working installs
 * (e.g. 0.92 app-server still speaks initialize / account/read / model/list).
 * Fail closed on major ≥ 1 until that line is validated.
 */
const MIN_CODEX_MINOR = 80;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
export const CODEX_IDLE_SESSION_TTL_MS = 5 * 60_000;
export const MAX_IDLE_CODEX_SESSIONS = 8;
const APPROVED_BROWSER_TOOLS = new Set([
  "browser_status",
  "browser_snapshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_wait",
]);

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;
type CodexIdleTimer = { unref(): void };

export interface CodexCliAdapterOptions {
  idleSessionTtlMs?: number;
  maxIdleSessions?: number;
  onSessionClosed?: (conversationId: string) => void;
  onInputSettled?: (runId: string, requestId: string) => void;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): CodexIdleTimer;
    clearTimeout(handle: CodexIdleTimer): void;
  };
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
  initialized: boolean;
  conversationId: string;
  worktree: string;
  browserMcpConfigured: boolean;
  currentRunId: string | null;
  threadId: string | null;
  turnId: string | null;
  fileChanges: Map<string, string[]>;
  activeToolCalls: Set<string>;
  pendingInputs: Map<string, { rpcId: RpcId; questionIds: string[] }>;
  idleTimer: CodexIdleTimer | null;
}

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export interface CodexReadiness {
  id: "codex-cli";
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  models: CodexModel[];
  /** Operator-facing reason when Codex is not run-ready. */
  detail: string | null;
}

export interface CodexSkill {
  name: string;
  description: string;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ProviderProtocolError(`Codex event is missing ${field}.`);
  }
  return value;
}

export function isRecoverableCodexResumeError(value: unknown): boolean {
  const error = record(value);
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (!message.includes("thread")) return false;
  return ["not found", "does not exist", "missing", "unknown", "no rollout"].some((snippet) =>
    message.includes(snippet),
  );
}

/**
 * Build app-server argv for a known Codex version.
 * 0.144+ accepts --stdio / --strict-config / feature disables; 0.80–0.143
 * speaks the same JSON-RPC over stdio without those flags (0.92 rejects them).
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(value: Record<string, string>): string {
  return `{${Object.entries(value)
    .map(([key, entry]) => `${key}=${tomlString(entry)}`)
    .join(",")}}`;
}

function codexMcpOverride(configuration: ProviderBrowserMcpConfiguration): string {
  return `mcp_servers.${configuration.name}={command=${tomlString(configuration.command)},args=[${configuration.args.map(tomlString).join(",")}],env=${tomlInlineTable(configuration.environment)}}`;
}

export function codexAppServerArguments(
  version: string,
  browserMcp?: ProviderBrowserMcpConfiguration,
): string[] {
  const minor = Number(version.split(".")[1] ?? 0);
  const args = ["app-server"];
  if (minor >= 144) {
    args.push("--stdio", "--strict-config");
  }
  args.push("-c", "mcp_servers={}");
  if (browserMcp) args.push("-c", codexMcpOverride(browserMcp));
  args.push("-c", "apps._default.enabled=false", "-c", 'web_search="disabled"');
  return args;
}

export function assertSupportedCodexVersion(output: string): string {
  const match = output.match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new ProviderProtocolError(
      `Unsupported Codex CLI version. Aldunis Code requires ${SUPPORTED_CODEX_MAJOR}.${MIN_CODEX_MINOR}+.`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== SUPPORTED_CODEX_MAJOR) {
    throw new ProviderProtocolError(
      `Unsupported Codex CLI major version ${major}. Aldunis Code requires ${SUPPORTED_CODEX_MAJOR}.${MIN_CODEX_MINOR}+.`,
    );
  }
  if (minor < MIN_CODEX_MINOR) {
    throw new ProviderProtocolError(
      `Unsupported Codex CLI version ${match[1]}.${match[2]}.${match[3]}. Aldunis Code requires ${SUPPORTED_CODEX_MAJOR}.${MIN_CODEX_MINOR}+.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function codexFileChangePaths(itemValue: unknown): string[] {
  const item = record(itemValue);
  if (!item || item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  const paths: string[] = [];
  for (const change of item.changes) {
    const entry = record(change);
    const kind = record(entry?.kind);
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !kind ||
      (kind.type !== "add" && kind.type !== "delete" && kind.type !== "update") ||
      (kind.type === "update" && kind.move_path != null && typeof kind.move_path !== "string")
    ) {
      throw new ProviderProtocolError("Codex emitted a malformed file change.");
    }
    paths.push(
      entry.path,
      ...(kind.type === "update" && typeof kind.move_path === "string" ? [kind.move_path] : []),
    );
  }
  return paths;
}

export async function pathsWithinWorktree(worktree: string, paths: string[]): Promise<boolean> {
  const lexicalRoot = resolve(worktree);
  const root = await realpath(worktree);
  for (const path of paths) {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(lexicalRoot, path);
    const lexical = relative(lexicalRoot, candidate);
    if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) return false;
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      let ancestor = candidate;
      let canonicalAncestor: string | null = null;
      while (canonicalAncestor === null) {
        try {
          const metadata = await lstat(ancestor);
          if (metadata.isSymbolicLink()) return false;
          canonicalAncestor = await realpath(ancestor);
        } catch {
          const parent = dirname(ancestor);
          if (parent === ancestor) return false;
          ancestor = parent;
        }
      }
      canonical = resolve(canonicalAncestor, relative(ancestor, candidate));
    }
    const canonicalRelative = relative(root, canonical);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    )
      return false;
  }
  return true;
}

function itemEvents(itemValue: unknown, completed: boolean): ProviderEvent[] {
  const item = record(itemValue);
  if (!item) throw new ProviderProtocolError("Codex emitted a malformed item.");
  const id = string(item.id, "item id");
  if (item.type === "agentMessage") {
    // Streaming starts with empty text; only completed non-empty text is shown.
    // Absent/non-string text remains a protocol error so malformed completions
    // do not look like successful blank turns.
    if (!completed) return [];
    if (typeof item.text !== "string") {
      throw new ProviderProtocolError("Codex event is missing agent text.");
    }
    if (!item.text) return [];
    return [{ kind: "assistant_text", text: item.text }];
  }
  if (item.type === "reasoning") {
    // Current app-server reasoning items expose summary/content arrays; older
    // builds used a single text field. Prefer text, then join summary parts.
    const text =
      typeof item.text === "string" && item.text
        ? item.text
        : Array.isArray(item.summary)
          ? item.summary
              .filter((part): part is string => typeof part === "string" && !!part)
              .join("\n")
          : "";
    return completed && text ? [{ kind: "thinking", text }] : [];
  }
  if (item.type === "plan") {
    if (!completed) return [];
    if (typeof item.text !== "string") {
      throw new ProviderProtocolError("Codex event is missing plan text.");
    }
    if (!item.text) return [];
    return [
      {
        kind: "plan_updated",
        artifact: {
          id: `item:${id}`,
          provider: "codex-cli",
          body: item.text,
        },
      },
    ];
  }
  if (item.type === "commandExecution") {
    return completed
      ? [{ kind: "tool_finished", toolCallId: id, failed: item.status !== "completed" }]
      : [{ kind: "tool_started", toolCallId: id, name: "Command" }];
  }
  if (item.type === "fileChange") {
    return completed
      ? [{ kind: "tool_finished", toolCallId: id, failed: item.status !== "completed" }]
      : [{ kind: "tool_started", toolCallId: id, name: "File change" }];
  }
  if (item.type === "collabAgentToolCall") {
    return completed
      ? [{ kind: "tool_finished", toolCallId: id, failed: item.status !== "completed" }]
      : [{ kind: "tool_started", toolCallId: id, name: `Subagent ${String(item.tool)}` }];
  }
  if (item.type === "imageView") {
    // The current Codex schema exposes imageView.path, which is a provider
    // filesystem path. Aldunis deliberately does not read arbitrary provider
    // paths. A future adapter may provide bounded inline image bytes instead.
    const observation = normalizeBrowserObservation({
      provider: "codex-cli",
      observationId: id,
      imageData: item.imageData ?? item.data,
      mediaType: item.mediaType ?? item.mimeType,
      title: item.title,
      url: item.url,
    });
    return observation ? [observation] : [];
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool =
      typeof item.tool === "string" && item.tool
        ? item.tool
        : typeof item.name === "string" && item.name
          ? item.name
          : "browser tool";
    const approved =
      item.type === "mcpToolCall" &&
      item.server === BROWSER_MCP_NAME &&
      APPROVED_BROWSER_TOOLS.has(tool);
    if (!approved) {
      return [
        {
          kind: "failed",
          code: "unsupported_external_tool",
          message: UNSUPPORTED_EXTERNAL_TOOL_MESSAGE,
        },
      ];
    }
    const failed = item.status === "failed" || item.status === "error";
    return completed
      ? [{ kind: "tool_finished", toolCallId: id, failed }]
      : [{ kind: "tool_started", toolCallId: id, name: `MCP ${tool.slice(0, 160)}` }];
  }
  // Informational ThreadItem variants from the app-server schema. Keep this
  // list aligned with `codex app-server generate-ts` ThreadItem exports.
  const informationalItemTypes = new Set([
    "userMessage",
    "hookPrompt",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
    "subAgentActivity",
    "webSearch",
  ]);
  if (informationalItemTypes.has(String(item.type))) return [];
  throw new ProviderProtocolError(`Unsupported Codex item type: ${String(item.type)}.`);
}

function settleActiveToolCalls(active: ActiveRun): ProviderEvent[] {
  const events = [...active.activeToolCalls].map((toolCallId): ProviderEvent => ({
    kind: "tool_finished",
    toolCallId,
    failed: true,
  }));
  active.activeToolCalls.clear();
  return events;
}

function safeCodexProtocolFailureMessage(error: ProviderProtocolError): string {
  if (error.message.startsWith("Unsupported Codex notification:")) {
    return CODEX_UNSUPPORTED_NOTIFICATION_MESSAGE;
  }
  if (error.message.startsWith("Unsupported Codex item type:")) {
    return CODEX_UNSUPPORTED_ITEM_MESSAGE;
  }
  if (error.message.startsWith("Unsupported Codex turn status:")) {
    return CODEX_UNSUPPORTED_TURN_STATUS_MESSAGE;
  }
  return CODEX_PROTOCOL_FALLBACK_MESSAGE;
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Map Codex app-server `thread/tokenUsage/updated` into ephemeral context
 * pressure for the composer meter. Malformed usage is ignored (not fatal).
 *
 * usedTokens is last-turn context occupancy: totalTokens minus reasoning
 * output (matching Codex's tokens-in-context estimate). Cumulative session
 * totals are never used as occupancy — they overstate fill after multi-turn
 * work and compaction. maxTokens is modelContextWindow when present.
 */
export function normalizeCodexTokenUsage(params: JsonRecord): ProviderEvent[] {
  const tokenUsage = record(params.tokenUsage);
  if (!tokenUsage) return [];
  const last = record(tokenUsage.last);
  if (!last) return [];
  const lastTotal = finiteNonNegative(last.totalTokens);
  if (lastTotal === null) return [];
  const reasoning = finiteNonNegative(last.reasoningOutputTokens) ?? 0;
  const usedTokens = Math.max(0, lastTotal - reasoning);
  const total = record(tokenUsage.total);
  const sessionTotal = finiteNonNegative(total?.totalTokens);
  const maxTokens = finiteNonNegative(tokenUsage.modelContextWindow);
  const inputTokens = finiteNonNegative(last.inputTokens);
  const outputTokens = finiteNonNegative(last.outputTokens);
  const cachedInputTokens = finiteNonNegative(last.cachedInputTokens);
  const cacheWriteInputTokens = finiteNonNegative(last.cacheWriteInputTokens);
  const reasoningOutputTokens = finiteNonNegative(last.reasoningOutputTokens);
  const usage: Extract<ProviderEvent, { kind: "context_usage" }> = {
    kind: "context_usage",
    usedTokens,
    maxTokens,
    totalProcessedTokens: sessionTotal,
    inputTokens,
    outputTokens,
  };
  if (cachedInputTokens !== null) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== null) usage.cacheWriteInputTokens = cacheWriteInputTokens;
  if (reasoningOutputTokens !== null) usage.reasoningOutputTokens = reasoningOutputTokens;
  return [usage];
}

export function normalizeCodexNotification(value: unknown): ProviderEvent[] {
  const message = record(value);
  const method = string(message?.method, "method");
  const params = record(message?.params);
  if (!params) throw new ProviderProtocolError("Codex emitted malformed notification parameters.");
  if (method === "item/started") return itemEvents(params.item, false);
  if (method === "item/completed") return itemEvents(params.item, true);
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/reasoning/summaryPartAdded"
  ) {
    const part = record(params.part);
    const delta =
      typeof params.delta === "string"
        ? params.delta
        : typeof params.text === "string"
          ? params.text
          : typeof part?.text === "string"
            ? part.text
            : "";
    return delta ? [{ kind: "thinking", text: delta }] : [];
  }
  if (method === "turn/plan/updated") {
    const turnId = string(params.turnId, "turn id");
    if (!Array.isArray(params.plan)) {
      throw new ProviderProtocolError("Codex emitted a malformed turn plan.");
    }
    const steps = params.plan.map((value) => {
      const step = record(value);
      if (!step) throw new ProviderProtocolError("Codex emitted a malformed plan step.");
      const rawStatus = string(step.status, "plan step status");
      const status = rawStatus === "inProgress" ? "active" : rawStatus;
      if (status !== "pending" && status !== "active" && status !== "completed") {
        throw new ProviderProtocolError(`Unsupported Codex plan step status: ${rawStatus}.`);
      }
      return { content: string(step.step, "plan step"), status };
    });
    return [
      {
        kind: "plan_updated",
        artifact: {
          id: `turn:${turnId}`,
          provider: "codex-cli",
          ...(typeof params.explanation === "string" && params.explanation
            ? { body: params.explanation }
            : {}),
          steps,
        },
      },
    ];
  }
  if (method === "item/plan/delta") {
    return [
      {
        kind: "plan_updated",
        artifact: {
          id: `item:${string(params.itemId, "item id")}`,
          provider: "codex-cli",
          body: string(params.delta, "plan delta"),
        },
        bodyMode: "append",
      },
    ];
  }
  if (method === "turn/completed") {
    const turn = record(params.turn);
    if (!turn) throw new ProviderProtocolError("Codex emitted a malformed completed turn.");
    const error = record(turn.error);
    if (turn.status === "failed") {
      return [
        {
          kind: "failed",
          message:
            typeof error?.message === "string"
              ? error.message
              : "Codex could not complete the turn.",
        },
      ];
    }
    if (turn.status === "interrupted") return [{ kind: "cancelled" }];
    // "completed" is terminal success (handled by the event loop). "inProgress"
    // appears in the schema and must not kill the turn if emitted early.
    if (turn.status === "completed" || turn.status === "inProgress") return [];
    throw new ProviderProtocolError(`Unsupported Codex turn status: ${String(turn.status)}.`);
  }
  if (method === "error") {
    const error = record(params.error);
    return [
      {
        kind: "failed",
        message:
          typeof error?.message === "string" ? error.message : "Codex reported a provider error.",
      },
    ];
  }
  if (method === "thread/tokenUsage/updated") {
    return normalizeCodexTokenUsage(params);
  }
  // Housekeeping notifications from the app-server ServerNotification surface.
  // Keep aligned with `codex app-server generate-ts` (0.145+). Unknown future
  // methods still fail closed so protocol drift stays visible.
  const informational = new Set([
    "turn/started",
    "turn/diff/updated",
    "turn/moderationMetadata",
    "hook/started",
    "hook/completed",
    "thread/started",
    "thread/status/changed",
    "thread/archived",
    "thread/deleted",
    "thread/unarchived",
    "thread/closed",
    "thread/name/updated",
    "thread/goal/updated",
    "thread/goal/cleared",
    "thread/environment/connected",
    "thread/environment/disconnected",
    "thread/settings/updated",
    "thread/compacted",
    "thread/realtime/started",
    "thread/realtime/itemAdded",
    "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/sdp",
    "thread/realtime/error",
    "thread/realtime/closed",
    "skills/changed",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
    "rawResponseItem/completed",
    "rawResponse/completed",
    "command/exec/outputDelta",
    "process/outputDelta",
    "process/exited",
    "serverRequest/resolved",
    "model/rerouted",
    "model/verification",
    "model/safetyBuffering/updated",
    "warning",
    "guardianWarning",
    "deprecationNotice",
    "configWarning",
    "remoteControl/status/changed",
    "mcpServer/startupStatus/updated",
    "mcpServer/oauthLogin/completed",
    "account/updated",
    "account/rateLimits/updated",
    "account/login/completed",
    "app/list/updated",
    "externalAgentConfig/import/progress",
    "externalAgentConfig/import/completed",
    "fs/changed",
    "fuzzyFileSearch/sessionUpdated",
    "fuzzyFileSearch/sessionCompleted",
    "windows/worldWritableWarning",
    "windowsSandbox/setupCompleted",
  ]);
  if (informational.has(method)) return [];
  throw new ProviderProtocolError(`Unsupported Codex notification: ${method}.`);
}

export class CodexCliAdapter {
  readonly id = "codex-cli" as const;
  readonly #active = new Map<string, ActiveRun>();
  readonly #sessions = new Map<string, ActiveRun>();

  constructor(
    private readonly executable = "codex",
    private readonly permissions = new PermissionBroker(),
    private readonly options: CodexCliAdapterOptions = {},
  ) {}

  get retainedIdleSessionCount(): number {
    return [...this.#sessions.values()].filter((session) => session.currentRunId === null).length;
  }

  #appServerArguments(version: string, browserMcp?: ProviderBrowserMcpConfiguration): string[] {
    return codexAppServerArguments(version, browserMcp);
  }

  async readiness(): Promise<CodexReadiness> {
    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      try {
        version = assertSupportedCodexVersion(result.stdout.trim());
      } catch (error) {
        const detail =
          error instanceof ProviderProtocolError ? error.message : "Unsupported Codex CLI version.";
        return {
          id: this.id,
          installed: true,
          authenticated: false,
          version: null,
          models: [],
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
        detail: "Install Codex CLI on PATH and sign in (codex login).",
      };
    }
    const child = spawn(this.executable, this.#appServerArguments(version), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const lines = this.#lines(child);
    let authenticated = false;
    let models: CodexModel[] = [];
    let gotAccount = false;
    let gotModels = false;
    const timeout = setTimeout(() => {
      terminateProviderChild(child, 1_000);
    }, 5_000);
    timeout.unref();
    try {
      this.#send(child, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: { name: "aldunis_code", title: "Aldunis Code", version: "0.1.0" },
        },
      });
      for await (const message of lines) {
        if (message.id === 0) {
          if (message.error) break;
          this.#send(child, { method: "initialized", params: {} });
          this.#send(child, { method: "account/read", id: 1, params: { refreshToken: false } });
          this.#send(child, { method: "model/list", id: 2, params: { limit: 100 } });
          continue;
        }
        if (message.id === 1) {
          const result = record(message.result);
          authenticated = record(result?.account) !== null || result?.requiresOpenaiAuth === false;
          gotAccount = true;
        }
        if (message.id === 2) {
          const result = record(message.result);
          const data = Array.isArray(result?.data) ? result.data : [];
          models = data.flatMap((value): CodexModel[] => {
            const model = record(value);
            if (!model || typeof model.id !== "string" || model.hidden === true) return [];
            const efforts = Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts.flatMap((entry): ReasoningEffort[] => {
                  const option = record(entry);
                  const effort = option?.reasoningEffort;
                  return effort === "minimal" ||
                    effort === "low" ||
                    effort === "medium" ||
                    effort === "high" ||
                    effort === "xhigh"
                    ? [effort]
                    : [];
                })
              : [];
            return [
              {
                id: model.id,
                displayName: typeof model.displayName === "string" ? model.displayName : model.id,
                isDefault: model.isDefault === true,
                reasoningEfforts: efforts,
                defaultReasoningEffort: efforts.includes(
                  model.defaultReasoningEffort as ReasoningEffort,
                )
                  ? (model.defaultReasoningEffort as ReasoningEffort)
                  : (efforts[0] ?? "medium"),
              },
            ];
          });
          gotModels = true;
        }
        if (gotAccount && gotModels) break;
      }
    } finally {
      clearTimeout(timeout);
      this.#terminate(child);
    }
    if (spawnFailed) {
      return {
        id: this.id,
        installed: false,
        authenticated: false,
        version: null,
        models: [],
        detail: "Install Codex CLI on PATH and sign in (codex login).",
      };
    }
    if (!gotAccount || !gotModels) {
      return {
        id: this.id,
        installed: true,
        authenticated: false,
        version,
        models: [],
        detail: "Codex CLI did not report account or models. Try `codex login`.",
      };
    }
    return {
      id: this.id,
      installed: true,
      authenticated,
      version,
      models,
      detail: authenticated ? null : "Sign in to Codex CLI (codex login).",
    };
  }

  async skills(worktree: string): Promise<CodexSkill[]> {
    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      version = assertSupportedCodexVersion(result.stdout.trim());
    } catch {
      throw new ProviderProtocolError("Codex CLI is not installed or could not be started.");
    }
    const child = spawn(this.executable, this.#appServerArguments(version), {
      cwd: worktree,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawnFailed = false;
    child.once("error", () => {
      spawnFailed = true;
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const timeout = setTimeout(() => {
      terminateProviderChild(child, 1_000);
    }, 5_000);
    timeout.unref();
    let received = false;
    let skills: CodexSkill[] = [];
    try {
      this.#send(child, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: { name: "aldunis_code", title: "Aldunis Code", version: "0.1.0" },
        },
      });
      for await (const message of this.#lines(child)) {
        if (message.id === 0) {
          if (message.error) break;
          this.#send(child, { method: "initialized", params: {} });
          this.#send(child, {
            method: "skills/list",
            id: 1,
            params: { cwds: [worktree], forceReload: false },
          });
          continue;
        }
        if (message.id !== 1) continue;
        if (message.error) break;
        const result = record(message.result);
        if (!result || !Array.isArray(result.data)) {
          throw new ProviderProtocolError("Codex emitted a malformed skills list.");
        }
        const seen = new Set<string>();
        skills = result.data
          .flatMap((entryValue): CodexSkill[] => {
            const entry = record(entryValue);
            if (!entry || !Array.isArray(entry.skills)) {
              throw new ProviderProtocolError("Codex emitted a malformed skills list.");
            }
            return entry.skills.flatMap((skillValue): CodexSkill[] => {
              const skill = record(skillValue);
              if (
                !skill ||
                typeof skill.name !== "string" ||
                !skill.name ||
                typeof skill.description !== "string" ||
                typeof skill.enabled !== "boolean"
              ) {
                throw new ProviderProtocolError("Codex emitted malformed skill metadata.");
              }
              if (!skill.enabled || seen.has(skill.name)) return [];
              seen.add(skill.name);
              return [{ name: skill.name, description: skill.description }];
            });
          })
          .sort((left, right) => left.name.localeCompare(right.name));
        received = true;
        break;
      }
    } finally {
      clearTimeout(timeout);
      this.#terminate(child);
    }
    if (spawnFailed || !received) {
      throw new ProviderProtocolError("Codex CLI could not list skills.");
    }
    return skills;
  }

  async start(options: ProviderStartOptions): Promise<ProviderRun> {
    const existing = this.#sessions.get(options.conversationId);
    if (
      existing &&
      existing.child.exitCode === null &&
      !existing.spawnFailed &&
      existing.currentRunId === null &&
      existing.worktree === options.worktree &&
      existing.browserMcpConfigured === Boolean(options.browserMcp) &&
      (!options.resumeSessionId || options.resumeSessionId === existing.threadId)
    ) {
      this.#clearIdleTimer(existing);
      this.#sessions.delete(options.conversationId);
      this.#sessions.set(options.conversationId, existing);
      const id = randomUUID();
      existing.cancelled = false;
      existing.currentRunId = id;
      existing.turnId = null;
      existing.fileChanges.clear();
      existing.activeToolCalls.clear();
      this.#active.set(id, existing);
      return { id, events: this.#events(id, existing, options) };
    }
    const displacedBrowserToken = existing?.browserMcpConfigured === true;
    if (existing) {
      this.#retireSession(existing, false);
    }

    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      version = assertSupportedCodexVersion(result.stdout.trim());
    } catch {
      if (displacedBrowserToken && !options.browserMcp) {
        this.options.onSessionClosed?.(options.conversationId);
      }
      throw new ProviderProtocolError("Codex CLI is not installed or could not be started.");
    }
    const id = randomUUID();
    const child = spawn(this.executable, this.#appServerArguments(version, options.browserMcp), {
      cwd: options.worktree,
      env: options.browserMcp ? { ...process.env, ...options.browserMcp.environment } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const active: ActiveRun = {
      child,
      cancelled: false,
      spawnFailed: false,
      initialized: false,
      conversationId: options.conversationId,
      worktree: options.worktree,
      browserMcpConfigured: Boolean(options.browserMcp),
      currentRunId: id,
      threadId: null,
      turnId: null,
      fileChanges: new Map(),
      activeToolCalls: new Set(),
      pendingInputs: new Map(),
      idleTimer: null,
    };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    child.once("close", () => {
      this.#clearIdleTimer(active);
      if (this.#sessions.get(options.conversationId) === active) {
        this.#sessions.delete(options.conversationId);
        if (active.browserMcpConfigured) this.options.onSessionClosed?.(options.conversationId);
      }
    });
    this.#active.set(id, active);
    this.#sessions.set(options.conversationId, active);
    if (displacedBrowserToken && !active.browserMcpConfigured) {
      this.options.onSessionClosed?.(options.conversationId);
    }
    return { id, events: this.#events(id, active, options) };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    this.#forgetPendingInputs(id, active);
    this.permissions.closeRun(id, "cancelled");
    if (active.threadId && active.turnId) {
      this.#send(active.child, {
        method: "turn/interrupt",
        id: 99,
        params: { threadId: active.threadId, turnId: active.turnId },
      });
      scheduleProviderChildTermination(active.child, 2_000);
    } else {
      this.#terminate(active.child);
    }
    return true;
  }

  answerInput(runId: string, requestId: string, answer: string): boolean {
    const active = this.#active.get(runId);
    const pending = active?.pendingInputs.get(requestId);
    if (!active || !pending || active.cancelled) return false;
    const sent = this.#send(active.child, {
      id: pending.rpcId,
      result: {
        answers: Object.fromEntries(
          pending.questionIds.map((questionId) => [questionId, { answers: [answer] }]),
        ),
      },
    });
    if (sent) this.#forgetPendingInput(runId, requestId, active);
    return sent;
  }

  expireInput(runId: string, requestId: string): boolean {
    const active = this.#active.get(runId);
    const pending = active?.pendingInputs.get(requestId);
    if (!active || !pending || active.cancelled) return false;
    const sent = this.#send(active.child, {
      id: pending.rpcId,
      result: { answers: {} },
    });
    if (sent) this.#forgetPendingInput(runId, requestId, active);
    return sent;
  }

  close(): void {
    for (const session of [...this.#sessions.values()]) {
      if (session.currentRunId) this.#forgetPendingInputs(session.currentRunId, session);
      this.#retireSession(session);
    }
  }

  #forgetPendingInput(runId: string, requestId: string, active: ActiveRun): void {
    if (!active.pendingInputs.delete(requestId)) return;
    this.options.onInputSettled?.(runId, requestId);
  }

  #forgetPendingInputs(runId: string, active: ActiveRun): void {
    for (const requestId of [...active.pendingInputs.keys()]) {
      this.#forgetPendingInput(runId, requestId, active);
    }
  }

  #clearIdleTimer(active: ActiveRun): void {
    if (!active.idleTimer) return;
    const clear =
      this.options.timers?.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    clear(active.idleTimer);
    active.idleTimer = null;
  }

  #retireSession(active: ActiveRun, notify = true): void {
    const retained = this.#sessions.get(active.conversationId) === active;
    this.#clearIdleTimer(active);
    if (retained) this.#sessions.delete(active.conversationId);
    this.#terminate(active.child);
    if (retained && notify && active.browserMcpConfigured) {
      this.options.onSessionClosed?.(active.conversationId);
    }
  }

  #scheduleIdleRetirement(active: ActiveRun): void {
    if (
      this.#sessions.get(active.conversationId) !== active ||
      active.currentRunId !== null ||
      active.child.exitCode !== null ||
      active.cancelled
    ) {
      return;
    }
    this.#clearIdleTimer(active);
    this.#sessions.delete(active.conversationId);
    this.#sessions.set(active.conversationId, active);
    const schedule =
      this.options.timers?.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    active.idleTimer = schedule(() => {
      active.idleTimer = null;
      if (active.currentRunId === null) this.#retireSession(active);
    }, this.options.idleSessionTtlMs ?? CODEX_IDLE_SESSION_TTL_MS);
    active.idleTimer.unref();

    const limit = this.options.maxIdleSessions ?? MAX_IDLE_CODEX_SESSIONS;
    while (this.retainedIdleSessionCount > limit) {
      const oldest = [...this.#sessions.values()].find((session) => session.currentRunId === null);
      if (!oldest) break;
      this.#retireSession(oldest);
    }
  }

  #send(child: ChildProcessWithoutNullStreams, value: unknown): boolean {
    if (child.stdin.destroyed || child.stdin.writableEnded) return false;
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`, () => {});
      return true;
    } catch {
      return false;
    }
  }

  #terminate(child: ChildProcessWithoutNullStreams): void {
    terminateProviderChild(child);
  }

  async *#lines(
    child: ChildProcessWithoutNullStreams,
    options?: { allowIncompleteTrailer?: () => boolean },
  ): AsyncIterable<JsonRecord> {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_PROVIDER_LINE_BYTES) {
        throw new ProviderProtocolError("Codex emitted an oversized message.");
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new ProviderProtocolError("Codex emitted malformed JSON.");
          }
          const message = record(value);
          if (!message) throw new ProviderProtocolError("Codex emitted a malformed message.");
          yield message;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.end();
    // After we intentionally terminate the app-server (terminal failure,
    // cancel), stdout may end mid-line. Do not overwrite a more specific
    // terminal event with a generic incomplete-message protocol error.
    if (buffer.trim() && !options?.allowIncompleteTrailer?.()) {
      throw new ProviderProtocolError("Codex emitted an incomplete message.");
    }
  }

  async *#events(
    id: string,
    active: ActiveRun,
    options: ProviderStartOptions,
  ): AsyncIterable<ProviderEvent> {
    const token = this.permissions.createRunToken(id);
    const startTurn = () => {
      if (!active.threadId)
        throw new ProviderProtocolError("Codex session is missing its thread id.");
      this.#send(active.child, {
        method: "turn/start",
        id: 2,
        params: {
          threadId: active.threadId,
          input: [{ type: "text", text: options.prompt, text_elements: [] }],
          cwd: options.worktree,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          model: options.model ?? null,
          effort: options.reasoningEffort ?? null,
        },
      });
    };
    if (active.initialized) startTurn();
    else {
      this.#send(active.child, {
        method: "initialize",
        id: 0,
        params: {
          clientInfo: { name: "aldunis_code", title: "Aldunis Code", version: "0.1.0" },
        },
      });
    }
    let protocolFailed = false;
    let terminalEmitted = false;
    let completed = false;
    let resumeFallbackAttempted = false;
    const approvalTasks = new Set<Promise<void>>();
    try {
      for await (const message of this.#lines(active.child, {
        allowIncompleteTrailer: () => terminalEmitted || active.cancelled,
      })) {
        if (message.id === 0) {
          if (message.error)
            throw new ProviderProtocolError("Codex app-server initialization failed.");
          active.initialized = true;
          this.#send(active.child, { method: "initialized", params: {} });
          this.#send(active.child, {
            method: options.resumeSessionId ? "thread/resume" : "thread/start",
            id: 1,
            params: {
              ...(options.resumeSessionId ? { threadId: options.resumeSessionId } : {}),
              cwd: options.worktree,
              // ThreadStartParams uses CLI-style enum values; turn-level SandboxPolicy
              // is a different tagged-object type and is intentionally not sent here.
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: "read-only",
              model: options.model ?? null,
              config: options.reasoningEffort
                ? { model_reasoning_effort: options.reasoningEffort }
                : null,
            },
          });
          continue;
        }
        if (message.id === 1) {
          if (
            message.error &&
            options.resumeSessionId &&
            !resumeFallbackAttempted &&
            isRecoverableCodexResumeError(message.error)
          ) {
            resumeFallbackAttempted = true;
            this.#send(active.child, {
              method: "thread/start",
              id: 1,
              params: {
                cwd: options.worktree,
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                sandbox: "read-only",
                model: options.model ?? null,
                config: options.reasoningEffort
                  ? { model_reasoning_effort: options.reasoningEffort }
                  : null,
              },
            });
            continue;
          }
          if (message.error)
            throw new ProviderProtocolError("Codex could not start or resume the thread.");
          const result = record(message.result);
          const thread = record(result?.thread);
          active.threadId = string(thread?.id, "thread id");
          yield {
            kind: "session_started",
            sessionId: active.threadId,
            model: typeof result?.model === "string" ? result.model : (options.model ?? null),
          };
          startTurn();
          continue;
        }
        if (message.id === 2) {
          if (message.error) throw new ProviderProtocolError("Codex could not start the turn.");
          const result = record(message.result);
          const turn = record(result?.turn);
          active.turnId = string(turn?.id, "turn id");
          continue;
        }
        if (message.id !== undefined && typeof message.method === "string") {
          // Some unit-like server requests may omit params; treat as empty object.
          const params = record(message.params) ?? {};
          if (message.method === "item/tool/call") {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { contentItems: [], success: false },
            });
            terminalEmitted = true;
            for (const settled of settleActiveToolCalls(active)) yield settled;
            yield {
              kind: "failed",
              code: "unsupported_external_tool",
              message: UNSUPPORTED_EXTERNAL_TOOL_MESSAGE,
            };
            this.#terminate(active.child);
            return;
          }
          if (message.method === "item/tool/requestUserInput") {
            const questions = Array.isArray(params.questions)
              ? params.questions.map(record).filter((item): item is JsonRecord => item !== null)
              : [];
            if (
              questions.length !== 1 ||
              questions.some(
                (question) =>
                  typeof question.id !== "string" ||
                  typeof question.question !== "string" ||
                  question.isSecret === true,
              )
            ) {
              this.#send(active.child, {
                id: message.id as RpcId,
                error: {
                  code: -32602,
                  message: "Aldunis Code cannot safely render this input request.",
                },
              });
              continue;
            }
            const requestId = randomUUID();
            active.pendingInputs.set(requestId, {
              rpcId: message.id as RpcId,
              questionIds: questions.map((question) => question.id as string),
            });
            const firstOptions = Array.isArray(questions[0].options)
              ? questions[0].options.map(record).filter((item): item is JsonRecord => item !== null)
              : [];
            yield {
              kind: "input_requested",
              id: requestId,
              question: questions.map((question) => question.question).join("\n\n"),
              choices: firstOptions.slice(0, 12).flatMap((option, index) =>
                typeof option.label === "string"
                  ? [
                      {
                        id: `${questions[0].id}:${index}`,
                        label: option.label,
                        description:
                          typeof option.description === "string" ? option.description : null,
                      },
                    ]
                  : [],
              ),
              recommendation: null,
              responseMode: "native_resume",
              providerRequestId: String(message.id),
              expiresAt:
                typeof params.autoResolutionMs === "number"
                  ? new Date(Date.now() + params.autoResolutionMs).toISOString()
                  : null,
              allowFreeForm: questions[0].isOther === true || firstOptions.length === 0,
            };
            continue;
          }
          const isCommand = message.method === "item/commandExecution/requestApproval";
          const isFile = message.method === "item/fileChange/requestApproval";
          if (!isCommand && !isFile) {
            this.#send(active.child, {
              id: message.id as RpcId,
              error: {
                code: -32601,
                message: "Aldunis Code does not support this provider request.",
              },
            });
            continue;
          }
          if (options.mode !== "build") {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { decision: "decline" },
            });
            continue;
          }
          // A command sandbox escape cannot be constrained to the selected
          // worktree by cwd alone because arguments may target arbitrary paths.
          // Keep commands in the read-only sandbox until Codex exposes a
          // worktree-confined execution policy that Aldunis Code can enforce.
          if (isCommand && params.command != null) {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { decision: "decline" },
            });
            continue;
          }
          const itemId = string(params.itemId, "approval item id");
          const toolCallId =
            isCommand && typeof params.approvalId === "string"
              ? `${itemId}:${params.approvalId}`
              : itemId;
          const toolName = isCommand ? "Bash" : "Edit";
          const network = record(params.networkApprovalContext);
          if (
            isCommand &&
            params.command == null &&
            (typeof network?.host !== "string" || typeof network.protocol !== "string")
          ) {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { decision: "decline" },
            });
            continue;
          }
          const changedPaths = active.fileChanges.get(toolCallId);
          if (
            isFile &&
            (!changedPaths ||
              changedPaths.length === 0 ||
              changedPaths.length > MAX_APPROVAL_PATHS ||
              !(await pathsWithinWorktree(options.worktree, changedPaths)))
          ) {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { decision: "decline" },
            });
            continue;
          }
          const input = isCommand
            ? { host: network?.host, protocol: network?.protocol, reason: params.reason }
            : {
                path: changedPaths?.[0],
                paths: changedPaths,
                reason: params.reason,
              };
          const approval = this.permissions.register({
            runId: id,
            conversationId: options.conversationId,
            repository: options.repository,
            worktree: options.worktree,
            toolCallId,
            toolName,
            toolInput: input,
            provider: "Codex CLI",
          });
          if (!approval) throw new ProviderProtocolError("Codex approval could not be registered.");
          yield { kind: "approval_pending", ...approval };
          const approvalTask = this.permissions
            .awaitRegisteredDecision(id, token, approval.id)
            .then(async (decision) => {
              const currentPaths = isFile ? (active.fileChanges.get(toolCallId) ?? []) : [];
              const scopeUnchanged =
                !isFile ||
                (currentPaths.length === changedPaths?.length &&
                  currentPaths.every((path, index) => path === changedPaths[index]));
              const remainsWithinWorktree =
                currentPaths.length === 0 ||
                (await pathsWithinWorktree(options.worktree, currentPaths));
              this.#send(active.child, {
                id: message.id as RpcId,
                result: {
                  decision:
                    decision.behavior === "allow" && scopeUnchanged && remainsWithinWorktree
                      ? "accept"
                      : "decline",
                },
              });
            })
            .catch(() => {
              if (!active.child.stdin.destroyed && !active.child.stdin.writableEnded) {
                this.#send(active.child, {
                  id: message.id as RpcId,
                  result: { decision: "decline" },
                });
              }
            })
            .finally(() => approvalTasks.delete(approvalTask));
          approvalTasks.add(approvalTask);
          continue;
        }
        if (typeof message.method === "string") {
          if (message.method === "item/started") {
            const params = record(message.params);
            const item = record(params?.item);
            if (item?.type === "fileChange" && typeof item.id === "string") {
              active.fileChanges.set(item.id, codexFileChangePaths(item));
            }
          } else if (message.method === "item/fileChange/patchUpdated") {
            const params = record(message.params);
            if (typeof params?.itemId === "string" && Array.isArray(params.changes)) {
              active.fileChanges.set(
                params.itemId,
                codexFileChangePaths({
                  type: "fileChange",
                  changes: params.changes,
                }),
              );
            }
          }
          let terminalFromNotification = false;
          for (const event of normalizeCodexNotification(message)) {
            if (event.kind === "tool_started") active.activeToolCalls.add(event.toolCallId);
            if (event.kind === "tool_finished") active.activeToolCalls.delete(event.toolCallId);
            if (
              event.kind === "failed" ||
              event.kind === "cancelled" ||
              event.kind === "turn_completed"
            ) {
              for (const settled of settleActiveToolCalls(active)) yield settled;
            }
            yield event;
            if (event.kind === "cancelled" || event.kind === "failed") {
              terminalEmitted = true;
              terminalFromNotification = true;
              this.#terminate(active.child);
            }
          }
          if (terminalFromNotification) return;
          if (message.method === "turn/completed") {
            const params = record(message.params);
            const turn = record(params?.turn);
            if (turn?.status === "completed" && active.threadId) {
              terminalEmitted = true;
              completed = true;
              for (const settled of settleActiveToolCalls(active)) yield settled;
              yield { kind: "turn_completed", sessionId: active.threadId, costUsd: null };
              return;
            }
          }
        }
      }
    } catch (error) {
      // A terminal event may already have been yielded before stream cleanup
      // threw (for example, a partial line after intentional terminate). Keep
      // the specific terminal outcome and do not emit a second failure.
      if (terminalEmitted) {
        this.#terminate(active.child);
      } else {
        protocolFailed = true;
        if (this.#sessions.get(active.conversationId) === active) {
          this.#retireSession(active);
        } else this.#terminate(active.child);
        terminalEmitted = true;
        for (const settled of settleActiveToolCalls(active)) yield settled;
        yield error instanceof ProviderProtocolError
          ? {
              kind: "failed",
              code: "provider_protocol_error",
              message: safeCodexProtocolFailureMessage(error),
            }
          : {
              kind: "failed",
              code: "provider_protocol_error",
              message: "Codex stream processing failed.",
            };
      }
    } finally {
      this.#forgetPendingInputs(id, active);
      this.#active.delete(id);
      if (active.currentRunId === id) {
        active.currentRunId = null;
        if (completed) this.#scheduleIdleRetirement(active);
      }
      this.permissions.closeRun(id, active.cancelled ? "cancelled" : "provider_failed");
    }
    if (active.cancelled && !protocolFailed && !terminalEmitted) {
      for (const settled of settleActiveToolCalls(active)) yield settled;
      yield { kind: "cancelled" };
    } else if (active.spawnFailed && !protocolFailed) {
      yield { kind: "failed", message: "Codex CLI is not installed or could not be started." };
    } else if (!protocolFailed && !terminalEmitted) {
      for (const settled of settleActiveToolCalls(active)) yield settled;
      yield {
        kind: "failed",
        code: "provider_process_exit",
        message: CODEX_PROCESS_EXIT_MESSAGE,
      };
    }
  }
}
