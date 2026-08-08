import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { type ApprovalSnapshot, isMutatingTool, PermissionBroker } from "./permission.ts";
import { normalizeClaudeModelSlug } from "./profiles.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_CLAUDE_MAJOR = 2;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const READ_ONLY_TOOLS = "Read,Glob,Grep";

export type InteractionMode = "ask" | "plan" | "build";

export const UNSUPPORTED_EXTERNAL_TOOL_MESSAGE =
  "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.";
export const CODEX_PROCESS_EXIT_MESSAGE = "Codex CLI exited before completing the turn.";
export const CODEX_PROTOCOL_FALLBACK_MESSAGE =
  "Codex app-server emitted an incompatible protocol event.";
export const CODEX_UNSUPPORTED_NOTIFICATION_MESSAGE =
  "Codex app-server emitted an unsupported notification.";
export const CODEX_UNSUPPORTED_ITEM_MESSAGE = "Codex app-server emitted an unsupported item type.";
export const CODEX_UNSUPPORTED_TURN_STATUS_MESSAGE =
  "Codex app-server emitted an unsupported turn status.";
export const CLAUDE_AUTHENTICATION_FAILURE_MESSAGE =
  "Claude Code authentication failed. Re-authenticate in Claude Code and try again.";
export const SHIKIGAMI_MODE_VIOLATION_CODE = "provider_mode_violation" as const;
const SAFE_PROVIDER_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;

export function formatShikigamiModeViolation(
  toolName: string,
  mode: Exclude<InteractionMode, "build">,
): string {
  return SAFE_PROVIDER_TOOL_NAME.test(toolName)
    ? `Shikigami requested mutating tool ${toolName} while ${mode} mode was active.`
    : `Shikigami requested a mutating tool while ${mode} mode was active.`;
}

export type ProviderId = "claude-code" | "codex-cli" | "shikigami" | `adapter:${string}@${string}`;
export type ProviderPlanStepStatus = "pending" | "active" | "completed" | "neutral";
export interface ProviderPlanStep {
  content: string;
  status: ProviderPlanStepStatus;
}
export interface ProviderPlanArtifact {
  id: string;
  provider: ProviderId;
  title?: string;
  body?: string;
  steps?: ProviderPlanStep[];
  updatedAt?: string;
}

export type ProviderBrowserObservationMediaType = "image/jpeg" | "image/png" | "image/webp";
export interface ProviderBrowserObservation {
  provider: ProviderId;
  observationId: string;
  imageData: string;
  mediaType: ProviderBrowserObservationMediaType;
  toolCallId?: string;
  title?: string;
  url?: string;
}

export interface ProviderInputRequest {
  id: string;
  question: string;
  choices: Array<{ id: string; label: string; description: string | null }>;
  recommendation: string | null;
  responseMode: "native_resume" | "child_follow_up";
  providerRequestId: string | null;
  expiresAt: string | null;
  allowFreeForm: boolean;
}

export type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | {
      kind: "governance_correlation";
      governance: "sekai-chisei";
      runId: string;
      operationId: string;
      correlationId?: string;
    }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "plan_updated";
      artifact: ProviderPlanArtifact;
      bodyMode?: "replace" | "append";
    }
  | { kind: "tool_started"; toolCallId: string; name: string }
  | ({ kind: "approval_pending" } & ApprovalSnapshot)
  | { kind: "approval_resolved"; id: string; state: ApprovalSnapshot["state"] }
  | ({ kind: "input_requested" } & ProviderInputRequest)
  | { kind: "input_resolved"; id: string; state: "answered" | "cancelled" }
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | ({ kind: "browser_observation" } & ProviderBrowserObservation)
  /**
   * Live context pressure for the active turn. The state layer may copy its
   * bounded numeric usage fields into a turn-scoped local receipt; occupancy
   * and provider payloads remain transient.
   */
  | {
      kind: "context_usage";
      usedTokens: number;
      maxTokens: number | null;
      totalProcessedTokens?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      cachedInputTokens?: number | null;
      cacheWriteInputTokens?: number | null;
      reasoningOutputTokens?: number | null;
    }
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | {
      kind: "failed";
      message: string;
      costUsd?: number | null;
      sessionId?: string;
      code?:
        | "unsupported_external_tool"
        | "provider_authentication"
        | "provider_protocol_error"
        | "provider_process_exit"
        | typeof SHIKIGAMI_MODE_VIOLATION_CODE;
      toolName?: string;
      mode?: Exclude<InteractionMode, "build">;
    };

export function persistedProviderFailureMessage(
  event: Extract<ProviderEvent, { kind: "failed" }>,
): string {
  if (event.code === "unsupported_external_tool") return UNSUPPORTED_EXTERNAL_TOOL_MESSAGE;
  if (event.code === "provider_authentication") return CLAUDE_AUTHENTICATION_FAILURE_MESSAGE;
  if (event.code === "provider_process_exit") return CODEX_PROCESS_EXIT_MESSAGE;
  if (
    event.code === SHIKIGAMI_MODE_VIOLATION_CODE &&
    typeof event.toolName === "string" &&
    SAFE_PROVIDER_TOOL_NAME.test(event.toolName) &&
    (event.mode === "ask" || event.mode === "plan")
  ) {
    return formatShikigamiModeViolation(event.toolName, event.mode);
  }
  if (event.code === "provider_protocol_error") {
    if (
      event.message === CODEX_PROTOCOL_FALLBACK_MESSAGE ||
      event.message === CODEX_UNSUPPORTED_NOTIFICATION_MESSAGE ||
      event.message === CODEX_UNSUPPORTED_ITEM_MESSAGE ||
      event.message === CODEX_UNSUPPORTED_TURN_STATUS_MESSAGE ||
      event.message === "Shikigami emitted a malformed run identity." ||
      event.message === "Shikigami emitted conflicting run identities." ||
      event.message === "Shikigami resume reported a different run identity." ||
      event.message === "Shikigami resume did not confirm the requested run identity." ||
      event.message === "Shikigami completed without a provider-confirmed run identity." ||
      event.message === "Codex stream processing failed."
    ) {
      return event.message;
    }
  }
  return "Provider failed.";
}

export class ProviderProtocolError extends Error {}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * A host-owned MCP server injected for one provider run. Environment values
 * are intentionally explicit so provider adapters never inherit unrelated
 * host credentials.
 */
export interface ProviderBrowserMcpConfiguration {
  name: string;
  command: string;
  args: string[];
  environment: Record<string, string>;
}

export interface ProviderStartOptions {
  repository: string;
  worktree: string;
  conversationId: string;
  prompt: string;
  approvalUrl: string;
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  mode: InteractionMode;
  browserMcp?: ProviderBrowserMcpConfiguration;
}

export function modeArguments(mode: InteractionMode, help: string): string[] {
  const supportsTools = /--tools <tools\.\.\.>/.test(help);
  const permissionModes =
    help.match(/--permission-mode <mode>[\s\S]*?\(choices: ([^)]+)\)/)?.[1] ?? "";
  const supportsPermissionMode = (value: string) => permissionModes.includes(`"${value}"`);
  if (!supportsPermissionMode("default") || !supportsPermissionMode("plan")) {
    throw new ProviderProtocolError(
      "Claude Code does not advertise the required interaction modes.",
    );
  }
  if (mode === "ask") {
    if (!supportsTools || !supportsPermissionMode("dontAsk")) {
      throw new ProviderProtocolError(
        "Claude Code does not advertise a fail-closed read-only mode.",
      );
    }
    return ["--permission-mode", "dontAsk", "--tools", READ_ONLY_TOOLS];
  }
  return ["--permission-mode", mode === "plan" ? "plan" : "default"];
}

type JsonRecord = Record<string, unknown>;
interface ProviderToolRequest {
  kind: "tool_requested";
  toolCallId: string;
  name: string;
  input: unknown;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function claudeUsageEvent(
  event: JsonRecord,
): Extract<ProviderEvent, { kind: "context_usage" }> | null {
  const usage = record(event.usage);
  if (!usage) return null;
  const inputTokens = finiteNonNegative(usage.input_tokens) ?? finiteNonNegative(usage.inputTokens);
  const outputTokens =
    finiteNonNegative(usage.output_tokens) ?? finiteNonNegative(usage.outputTokens);
  const totalProcessedTokens =
    finiteNonNegative(usage.total_tokens) ??
    finiteNonNegative(usage.totalTokens) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);
  if (totalProcessedTokens === null) return null;
  const cachedInputTokens =
    finiteNonNegative(usage.cache_read_input_tokens) ??
    finiteNonNegative(usage.cacheReadInputTokens);
  const cacheWriteInputTokens =
    finiteNonNegative(usage.cache_creation_input_tokens) ??
    finiteNonNegative(usage.cacheCreationInputTokens);
  const usageEvent: Extract<ProviderEvent, { kind: "context_usage" }> = {
    kind: "context_usage",
    usedTokens: totalProcessedTokens,
    maxTokens: null,
    totalProcessedTokens,
    inputTokens,
    outputTokens,
  };
  if (cachedInputTokens !== null) usageEvent.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== null) usageEvent.cacheWriteInputTokens = cacheWriteInputTokens;
  return usageEvent;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ProviderProtocolError(`Claude event is missing ${field}.`);
  }
  return value;
}

export function normalizeClaudeEvent(value: unknown): Array<ProviderEvent | ProviderToolRequest> {
  const event = record(value);
  if (!event || typeof event.type !== "string") {
    throw new ProviderProtocolError("Claude emitted a malformed event.");
  }

  if (event.type === "system") {
    // Claude Code emits several system subtypes (init, compact_boundary, …).
    // Only init is required for session identity; other system lines are advisory
    // and must not fail the turn when Claude adds new subtypes.
    if (event.subtype === "init") {
      return [
        {
          kind: "session_started",
          sessionId: requiredString(event.session_id, "session_id"),
          model: typeof event.model === "string" ? event.model : null,
        },
      ];
    }
    if (
      event.subtype === "api_retry" &&
      (event.error_status === 401 || event.error === "authentication_failed")
    ) {
      return [
        {
          kind: "failed",
          code: "provider_authentication",
          message: CLAUDE_AUTHENTICATION_FAILURE_MESSAGE,
        },
      ];
    }
    return [];
  }

  if (event.type === "assistant") {
    const message = record(event.message);
    if (!message || !Array.isArray(message.content)) {
      throw new ProviderProtocolError("Claude emitted a malformed assistant event.");
    }
    return message.content.flatMap((item): ProviderEvent[] => {
      const block = record(item);
      if (!block || typeof block.type !== "string") {
        throw new ProviderProtocolError("Claude emitted a malformed content block.");
      }
      if (block.type === "text") {
        return [{ kind: "assistant_text", text: requiredString(block.text, "text") }];
      }
      if (block.type === "thinking") {
        return typeof block.thinking === "string" && block.thinking
          ? [{ kind: "thinking", text: block.thinking }]
          : [];
      }
      if (block.type === "tool_use") {
        return [
          {
            kind: "tool_requested",
            toolCallId: requiredString(block.id, "tool id"),
            name: requiredString(block.name, "tool name"),
            input: block.input,
          },
        ];
      }
      throw new ProviderProtocolError(`Unsupported Claude content block: ${block.type}.`);
    });
  }

  if (event.type === "user") {
    const message = record(event.message);
    if (!message || !Array.isArray(message.content)) {
      throw new ProviderProtocolError("Claude emitted a malformed tool result.");
    }
    return message.content.flatMap((item): ProviderEvent[] => {
      const block = record(item);
      if (!block || block.type !== "tool_result") return [];
      return [
        {
          kind: "tool_finished",
          toolCallId: requiredString(block.tool_use_id, "tool_use_id"),
          failed: block.is_error === true,
        },
      ];
    });
  }

  if (event.type === "result") {
    const sessionId = requiredString(event.session_id, "session_id");
    const usage = claudeUsageEvent(event);
    const costUsd = finiteNonNegative(event.total_cost_usd);
    if (event.is_error === true) {
      return [
        ...(usage ? [usage] : []),
        {
          kind: "failed",
          ...(costUsd !== null ? { costUsd } : {}),
          message:
            typeof event.result === "string" ? event.result : "Claude could not complete the turn.",
        },
      ];
    }
    return [
      ...(usage ? [usage] : []),
      {
        kind: "turn_completed",
        sessionId,
        costUsd,
      },
    ];
  }

  if (event.type === "stream_event") {
    const nested = record(event.event);
    const delta = record(nested?.delta);
    if (nested?.type === "content_block_delta" && delta?.type === "thinking_delta") {
      return typeof delta.thinking === "string" && delta.thinking
        ? [{ kind: "thinking", text: delta.thinking }]
        : [];
    }
    return [];
  }

  // Claude Code emits stream housekeeping events (rate limits, progress, …)
  // that must not abort an otherwise healthy turn.
  if (event.type === "rate_limit_event" || event.type === "progress") {
    return [];
  }

  throw new ProviderProtocolError(`Unsupported Claude event: ${event.type}.`);
}

export function assertSupportedClaudeVersion(output: string): string {
  const match = output.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) !== SUPPORTED_CLAUDE_MAJOR) {
    throw new ProviderProtocolError(
      `Unsupported Claude Code version. Aldunis Code requires major version ${SUPPORTED_CLAUDE_MAJOR}.`,
    );
  }
  return match[0];
}

export interface ProviderRun {
  id: string;
  events: AsyncIterable<ProviderEvent>;
}

export interface ProviderCommand {
  name: string;
  description: string;
}

export interface ProviderCapabilities {
  provider: "claude-code";
  commands: ProviderCommand[];
  attachments: {
    maxCount: number;
    textMaxBytes: number;
    imageMaxBytes: number;
    imageTypes: string[];
  };
  workspace: {
    shared: true;
    aldunisManaged: true;
    providerNative: false;
    providerNativeDetail: string;
  };
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
}

function terminateProviderProcess(child: ChildProcessWithoutNullStreams): NodeJS.Timeout {
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
  return timer;
}

export class ClaudeCodeAdapter {
  readonly #active = new Map<string, ActiveRun>();

  constructor(
    private readonly defaultExecutable = "claude",
    private readonly permissions = new PermissionBroker(),
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      provider: "claude-code",
      commands: [
        { name: "/compact", description: "Compact the current Claude session context" },
        { name: "/cost", description: "Show Claude Code usage for the session" },
        { name: "/help", description: "Show supported Claude Code commands" },
      ],
      attachments: {
        maxCount: 8,
        textMaxBytes: 64 * 1024,
        imageMaxBytes: 2 * 1024 * 1024,
        imageTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
      },
      workspace: {
        shared: true,
        aldunisManaged: true,
        providerNative: false,
        providerNativeDetail:
          "This adapter receives a canonical worktree from Aldunis Code and does not expose native worktree creation yet.",
      },
    };
  }

  async start(
    repository: string,
    worktree: string,
    conversationId: string,
    prompt: string,
    approvalUrl: string,
    mode: InteractionMode,
    resumeSessionId?: string,
    options?: {
      executable?: string;
      environment?: NodeJS.ProcessEnv;
      model?: string;
    },
  ): Promise<ProviderRun> {
    const executable = options?.executable ?? this.defaultExecutable;
    const environment = options?.environment ?? process.env;
    let version: { stdout: string };
    let help: { stdout: string };
    try {
      [version, help] = await Promise.all([
        execFileAsync(executable, ["--version"], {
          encoding: "utf8",
          timeout: 5_000,
          env: environment,
        }),
        execFileAsync(executable, ["--help"], {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 512 * 1024,
          env: environment,
        }),
      ]);
    } catch {
      throw new ProviderProtocolError("Claude Code is not installed or could not be started.");
    }
    assertSupportedClaudeVersion(version.stdout.trim());
    const authorityArgs = modeArguments(mode, help.stdout);

    const id = randomUUID();
    const permissionToken = this.permissions.createRunToken(id);
    const permissionServer = fileURLToPath(new URL("./permission-mcp.mjs", import.meta.url));
    const mcpConfig = JSON.stringify({
      mcpServers: {
        aldunis: {
          command: process.execPath,
          args: [permissionServer],
          env: {
            ALDUNIS_APPROVAL_URL: "${ALDUNIS_APPROVAL_URL}",
            ALDUNIS_PROVIDER_RUN_ID: "${ALDUNIS_PROVIDER_RUN_ID}",
            ALDUNIS_PROVIDER_RUN_TOKEN: "${ALDUNIS_PROVIDER_RUN_TOKEN}",
          },
        },
      },
    });
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...authorityArgs,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--permission-prompt-tool",
      "mcp__aldunis__approval_prompt",
    ];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (options?.model && options.model !== "default") {
      // Prefer T3-style full slugs; map legacy sonnet/opus/haiku aliases first.
      args.push("--model", normalizeClaudeModelSlug(options.model));
    }
    const child = spawn(executable, args, {
      cwd: worktree,
      env: {
        ...environment,
        ALDUNIS_APPROVAL_URL: approvalUrl,
        ALDUNIS_PROVIDER_RUN_ID: id,
        ALDUNIS_PROVIDER_RUN_TOKEN: permissionToken,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const active: ActiveRun = { child, cancelled: false, spawnFailed: false };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    child.stderr.resume();
    child.stdin.end(prompt);
    this.#active.set(id, active);

    return {
      id,
      events: this.#events(id, active, { repository, worktree, conversationId, mode }),
    };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    this.permissions.closeRun(id, "cancelled");
    terminateProviderProcess(active.child);
    return true;
  }

  async *#events(
    id: string,
    active: ActiveRun,
    context: {
      repository: string;
      worktree: string;
      conversationId: string;
      mode: InteractionMode;
    },
  ): AsyncIterable<ProviderEvent> {
    let buffer = "";
    let protocolFailed = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    try {
      providerOutput: for await (const chunk of active.child.stdout) {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > MAX_PROVIDER_LINE_BYTES) {
          throw new ProviderProtocolError("Claude emitted an oversized event.");
        }
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              throw new ProviderProtocolError("Claude emitted malformed JSON.");
            }
            for (const event of normalizeClaudeEvent(parsed)) {
              if (event.kind !== "tool_requested") {
                yield event;
                if (event.kind === "failed") {
                  protocolFailed = true;
                  terminationTimer = terminateProviderProcess(active.child);
                  break providerOutput;
                }
                if (event.kind === "tool_finished") {
                  const approval = this.permissions.approvalFor(id, event.toolCallId);
                  if (approval && approval.state !== "pending") {
                    yield { kind: "approval_resolved", id: approval.id, state: approval.state };
                  }
                }
                continue;
              }
              yield {
                kind: "tool_started",
                toolCallId: event.toolCallId,
                name: event.name,
              };
              if (isMutatingTool(event.name)) {
                if (context.mode !== "build") {
                  throw new ProviderProtocolError(
                    `Claude requested mutating tool ${event.name} while ${context.mode} mode was active.`,
                  );
                }
                const approval = this.permissions.register({
                  runId: id,
                  conversationId: context.conversationId,
                  repository: context.repository,
                  worktree: context.worktree,
                  toolCallId: event.toolCallId,
                  toolName: event.name,
                  toolInput: event.input,
                });
                if (approval) yield { kind: "approval_pending", ...approval };
              }
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim()) throw new ProviderProtocolError("Claude emitted an incomplete event.");
    } catch (error) {
      protocolFailed = true;
      active.child.kill("SIGTERM");
      yield {
        kind: "failed",
        message:
          error instanceof ProviderProtocolError
            ? error.message
            : "Claude stream processing failed.",
      };
    }

    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      if (active.child.exitCode !== null || active.child.signalCode !== null) {
        resolve([active.child.exitCode, active.child.signalCode]);
      } else {
        active.child.once("close", (exitCode, signal) => resolve([exitCode, signal]));
      }
    });
    clearTimeout(terminationTimer);
    this.#active.delete(id);
    if (active.cancelled) {
      yield { kind: "cancelled" };
    } else if (!protocolFailed && active.spawnFailed) {
      this.permissions.closeRun(id, "provider_failed");
      yield { kind: "failed", message: "Claude Code is not installed or could not be started." };
    } else if (!protocolFailed && code !== 0) {
      this.permissions.closeRun(id, "provider_failed");
      yield { kind: "failed", message: `Claude Code exited unexpectedly (${code ?? "signal"}).` };
    } else {
      this.permissions.closeRun(id, "provider_failed");
    }
  }
}
