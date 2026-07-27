import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  type ApprovalSnapshot,
  isMutatingTool,
  PermissionBroker,
} from "./permission.ts";
import { normalizeClaudeModelSlug } from "./profiles.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_CLAUDE_MAJOR = 2;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;
const READ_ONLY_TOOLS = "Read,Glob,Grep";

export type InteractionMode = "ask" | "plan" | "build";

export type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_started"; toolCallId: string; name: string }
  | ({ kind: "approval_pending" } & ApprovalSnapshot)
  | { kind: "approval_resolved"; id: string; state: ApprovalSnapshot["state"] }
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export class ProviderProtocolError extends Error {}

export type ProviderId = "claude-code" | "codex-cli" | "shikigami" | `adapter:${string}@${string}`;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

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
}

export function modeArguments(mode: InteractionMode, help: string): string[] {
  const supportsTools = /--tools <tools\.\.\.>/.test(help);
  const permissionModes = help.match(/--permission-mode <mode>[\s\S]*?\(choices: ([^)]+)\)/)?.[1] ?? "";
  const supportsPermissionMode = (value: string) => permissionModes.includes(`"${value}"`);
  if (!supportsPermissionMode("default") || !supportsPermissionMode("plan")) {
    throw new ProviderProtocolError("Claude Code does not advertise the required interaction modes.");
  }
  if (mode === "ask") {
    if (!supportsTools || !supportsPermissionMode("dontAsk")) {
      throw new ProviderProtocolError("Claude Code does not advertise a fail-closed read-only mode.");
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
    ? value as JsonRecord
    : null;
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
      return [{
        kind: "session_started",
        sessionId: requiredString(event.session_id, "session_id"),
        model: typeof event.model === "string" ? event.model : null,
      }];
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
      if (block.type === "tool_use") {
        return [{
          kind: "tool_requested",
          toolCallId: requiredString(block.id, "tool id"),
          name: requiredString(block.name, "tool name"),
          input: block.input,
        }];
      }
      if (block.type === "thinking") return [];
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
      return [{
        kind: "tool_finished",
        toolCallId: requiredString(block.tool_use_id, "tool_use_id"),
        failed: block.is_error === true,
      }];
    });
  }

  if (event.type === "result") {
    const sessionId = requiredString(event.session_id, "session_id");
    if (event.is_error === true) {
      return [{
        kind: "failed",
        message: typeof event.result === "string" ? event.result : "Claude could not complete the turn.",
      }];
    }
    return [{
      kind: "turn_completed",
      sessionId,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
    }];
  }

  // Claude Code emits stream housekeeping events (rate limits, progress, …)
  // that must not abort an otherwise healthy turn.
  if (
    event.type === "rate_limit_event"
    || event.type === "stream_event"
    || event.type === "progress"
  ) {
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
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
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
    active.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (active.child.exitCode === null) active.child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
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
    try {
      for await (const chunk of active.child.stdout) {
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
        message: error instanceof ProviderProtocolError
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
