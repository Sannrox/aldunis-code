import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { PermissionBroker } from "./permission.ts";
import {
  type ProviderEvent,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
} from "./provider.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

const MAX_ACP_MESSAGE_BYTES = 1024 * 1024;
const ACP_HANDSHAKE_TIMEOUT_MS = 10_000;
const ACP_RUN_TIMEOUT_MS = 30 * 60_000;
type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new ProviderProtocolError(`ACP message is missing ${field}.`);
  return value;
}

function textContent(value: unknown): string {
  const content = record(value);
  if (!content || content.type !== "text") throw new ProviderProtocolError("ACP emitted unsupported message content.");
  return requiredString(content.text, "message text");
}

export function normalizeAcpNotification(value: unknown): ProviderEvent[] {
  const message = record(value);
  if (
    !message
    || (message.method !== "session/update" && message.method !== "session/notification")
  ) {
    throw new ProviderProtocolError(`Unsupported ACP notification: ${String(message?.method)}.`);
  }
  const params = record(message.params);
  const update = record(params?.update);
  const updateType = typeof update?.sessionUpdate === "string"
    ? update.sessionUpdate
    : typeof update?.type === "string"
    ? ({
        AgentMessageChunk: "agent_message_chunk",
        ToolCall: "tool_call",
        ToolCallUpdate: "tool_call_update",
        TurnEnd: "turn_end",
      } as Record<string, string>)[update.type]
    : undefined;
  if (!update || !updateType) {
    throw new ProviderProtocolError("ACP emitted a malformed session update.");
  }
  if (updateType === "agent_message_chunk") {
    return [{ kind: "assistant_text", text: textContent(update.content) }];
  }
  if (updateType === "tool_call") {
    return [{
      kind: "tool_started",
      toolCallId: requiredString(update.toolCallId, "tool call ID"),
      name: typeof update.title === "string" ? update.title : "Provider tool",
    }];
  }
  if (updateType === "tool_call_update") {
    const status = update.status;
    if (status === "completed" || status === "failed") {
      return [{
        kind: "tool_finished",
        toolCallId: requiredString(update.toolCallId, "tool call ID"),
        failed: status === "failed",
      }];
    }
    if (status === "pending" || status === "in_progress") return [];
    throw new ProviderProtocolError("ACP emitted an unsupported tool status.");
  }
  const informational = new Set([
    "agent_thought_chunk",
    "plan",
    "available_commands_update",
    "current_mode_update",
    "usage_update",
    "turn_end",
  ]);
  if (informational.has(updateType)) return [];
  throw new ProviderProtocolError(`Unsupported ACP session update: ${updateType}.`);
}

export function isOptionalKiroNotification(adapterId: string, value: unknown): boolean {
  const message = record(value);
  return adapterId === "dev.kiro.cli"
    && typeof message?.method === "string"
    && (
      message.method.startsWith("_kiro.dev/")
      || message.method === "_session/terminate"
    )
    && message.id === undefined;
}

export function acpSessionRequest(
  resumeSessionId: string | undefined,
  manifestSupportsResume: boolean,
  agentSupportsResume: boolean,
  worktree: string,
): { method: "session/load" | "session/new"; params: JsonRecord } | null {
  if (resumeSessionId && (!manifestSupportsResume || !agentSupportsResume)) return null;
  const resume = Boolean(resumeSessionId);
  return {
    method: resume ? "session/load" : "session/new",
    params: {
      ...(resume ? { sessionId: resumeSessionId } : {}),
      cwd: worktree,
      mcpServers: [],
    },
  };
}

export function acpAllowOnceOption(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    const option = record(entry);
    if (typeof option?.optionId === "string" && option.kind === "allow_once") {
      return option.optionId;
    }
  }
  return null;
}

export function acpPromptRequest(
  sessionId: string,
  prompt: string,
): { method: "session/prompt"; params: JsonRecord } {
  return {
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    },
  };
}

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  sessionId: string | null;
  loadSession: boolean;
  spawnFailed: boolean;
  timedOut: boolean;
}

export class AcpProviderAdapter {
  readonly #active = new Map<string, ActiveRun>();

  constructor(
    readonly adapter: InstalledProviderAdapter,
    private readonly executable: string,
    private readonly permissions: PermissionBroker,
    private readonly inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(options: ProviderStartOptions): Promise<ProviderRun> {
    if (!this.adapter.enabled) throw new ProviderProtocolError("The selected adapter is disabled.");
    const environment: NodeJS.ProcessEnv = {};
    for (const reference of this.adapter.manifest.environment) {
      const value = this.inheritedEnvironment[reference.name];
      if (reference.required && value === undefined) {
        throw new ProviderProtocolError(`Required environment ${reference.name} is unavailable.`);
      }
      if (value !== undefined) environment[reference.name] = value;
    }
    // A minimal process environment is required for predictable subprocess
    // behavior; no unrelated credential-bearing values are inherited.
    for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
      const value = this.inheritedEnvironment[name];
      if (value !== undefined && environment[name] === undefined) environment[name] = value;
    }
    const id = randomUUID();
    const child = spawn(this.executable, this.adapter.manifest.executable.arguments, {
      cwd: options.worktree,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const active = {
      child,
      cancelled: false,
      sessionId: null,
      loadSession: false,
      spawnFailed: false,
      timedOut: false,
    };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    this.#active.set(id, active);
    return { id, events: this.#events(id, active, options) };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    this.permissions.closeRun(id, "cancelled");
    if (active.sessionId) {
      this.#send(active.child, {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: active.sessionId },
      });
    }
    this.#terminate(active.child);
    return true;
  }

  #send(child: ChildProcessWithoutNullStreams, value: unknown): void {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify(value)}\n`, () => {});
    }
  }

  #terminate(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000);
    force.unref();
  }

  async *#lines(child: ChildProcessWithoutNullStreams): AsyncIterable<JsonRecord> {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_ACP_MESSAGE_BYTES) {
        throw new ProviderProtocolError("ACP emitted an oversized message.");
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
            throw new ProviderProtocolError("ACP emitted malformed JSON.");
          }
          const message = record(value);
          if (!message) throw new ProviderProtocolError("ACP emitted a malformed message.");
          yield message;
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.end();
    if (buffer.trim()) throw new ProviderProtocolError("ACP emitted an incomplete message.");
  }

  async *#events(
    id: string,
    active: ActiveRun,
    options: ProviderStartOptions,
  ): AsyncIterable<ProviderEvent> {
    const token = this.permissions.createRunToken(id);
    let terminal = false;
    let protocolFailed = false;
    const approvalTasks = new Set<Promise<void>>();
    let phaseTimer = setTimeout(() => {
      active.timedOut = true;
      this.#terminate(active.child);
    }, ACP_HANDSHAKE_TIMEOUT_MS);
    phaseTimer.unref();
    const setPhaseTimeout = (milliseconds: number) => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(() => {
        active.timedOut = true;
        this.#terminate(active.child);
      }, milliseconds);
      phaseTimer.unref();
    };
    this.#send(active.child, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "aldunis-code", version: "0.1.0" },
      },
    });
    try {
      for await (const message of this.#lines(active.child)) {
        if (message.method === undefined && message.id === 0) {
          if (message.error) throw new ProviderProtocolError("ACP initialization failed.");
          const initialized = record(message.result);
          if (initialized?.protocolVersion !== 1) {
            throw new ProviderProtocolError("ACP returned an incompatible protocol version.");
          }
          const agentCapabilities = record(initialized?.agentCapabilities);
          active.loadSession = agentCapabilities?.loadSession === true;
          const sessionRequest = acpSessionRequest(
            options.resumeSessionId,
            this.adapter.manifest.capabilities.sessionResume,
            active.loadSession,
            options.worktree,
          );
          if (!sessionRequest) {
            throw new ProviderProtocolError(
              "This adapter cannot resume the existing session. Start a new conversation or install a resume-capable version.",
            );
          }
          this.#send(active.child, {
            jsonrpc: "2.0",
            id: 1,
            ...sessionRequest,
          });
          setPhaseTimeout(ACP_HANDSHAKE_TIMEOUT_MS);
          continue;
        }
        if (message.method === undefined && message.id === 1) {
          if (message.error) throw new ProviderProtocolError("ACP could not start or load the session.");
          const result = record(message.result);
          active.sessionId = requiredString(result?.sessionId, "session ID");
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          yield { kind: "session_started", sessionId: active.sessionId, model: null };
          this.#send(active.child, {
            jsonrpc: "2.0",
            id: 2,
            ...acpPromptRequest(
              active.sessionId,
              options.prompt,
            ),
          });
          continue;
        }
        if (message.method === undefined && message.id === 2) {
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          if (message.error) throw new ProviderProtocolError("ACP could not complete the prompt.");
          if (!active.sessionId) throw new ProviderProtocolError("ACP completed without a session.");
          terminal = true;
          yield { kind: "turn_completed", sessionId: active.sessionId, costUsd: null };
          this.#terminate(active.child);
          continue;
        }
        if (message.id !== undefined && typeof message.method === "string") {
          if (message.method !== "session/request_permission") {
            this.#send(active.child, {
              jsonrpc: "2.0", id: message.id as RpcId,
              error: { code: -32601, message: "Aldunis Code does not support this ACP request." },
            });
            continue;
          }
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          const params = record(message.params);
          const toolCall = record(params?.toolCall);
          const toolCallId = requiredString(toolCall?.toolCallId, "tool call ID");
          const allowOnceOption = acpAllowOnceOption(params?.options);
          const kind = toolCall?.kind;
          const rawInput = record(toolCall?.rawInput);
          const locationPaths = Array.isArray(toolCall?.locations)
            ? toolCall.locations.flatMap((value): string[] => {
                const location = record(value);
                return typeof location?.path === "string" ? [location.path] : [];
              })
            : [];
          const toolName = kind === "execute"
            ? typeof rawInput?.command === "string" ? "Bash" : "ProviderAction"
            : kind === "edit"
            ? locationPaths.length > 0 ? "Edit" : "ProviderAction"
            : kind === "delete"
            ? locationPaths.length > 0 ? "Delete" : "ProviderAction"
            : kind === "move"
            ? locationPaths.length > 0 ? "Move" : "ProviderAction"
            : kind === "read" || kind === "search" || kind === "think" || kind === "fetch"
            ? ""
            : "ProviderAction";
          if (
            !toolName
            || !allowOnceOption
            || (toolName === "ProviderAction"
              && locationPaths.length === 0
              && typeof toolCall?.title !== "string")
            || options.mode !== "build"
            || !this.adapter.manifest.capabilities.tools
          ) {
            this.#send(active.child, {
              jsonrpc: "2.0", id: message.id as RpcId,
              result: { outcome: { outcome: "cancelled" } },
            });
            continue;
          }
          const input = toolName === "Bash"
            ? { command: requiredString(rawInput?.command, "tool command") }
            : toolName === "ProviderAction"
            ? {
                title: typeof toolCall?.title === "string" ? toolCall.title : "Provider action",
                path: locationPaths[0],
                paths: locationPaths,
              }
            : {
                path: locationPaths[0],
                paths: locationPaths,
              };
          const approval = this.permissions.register({
            runId: id,
            conversationId: options.conversationId,
            repository: options.repository,
            worktree: options.worktree,
            toolCallId,
            toolName,
            toolInput: input,
            provider: `${this.adapter.manifest.presentation.name} (${this.adapter.manifest.id}@${this.adapter.manifest.version})`,
          });
          if (!approval) throw new ProviderProtocolError("ACP approval could not be registered.");
          yield { kind: "approval_pending", ...approval };
          const task = this.permissions.awaitRegisteredDecision(id, token, approval.id)
            .then((decision) => this.#send(active.child, {
              jsonrpc: "2.0", id: message.id as RpcId,
              result: {
                outcome: decision.behavior === "allow"
                  ? { outcome: "selected", optionId: allowOnceOption }
                  : { outcome: "cancelled" },
              },
            }))
            .catch(() => this.#send(active.child, {
              jsonrpc: "2.0", id: message.id as RpcId,
              result: { outcome: { outcome: "cancelled" } },
            }))
            .finally(() => approvalTasks.delete(task));
          approvalTasks.add(task);
          continue;
        }
        if (typeof message.method === "string") {
          if (isOptionalKiroNotification(this.adapter.manifest.id, message)) {
            setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
            continue;
          }
          const events = normalizeAcpNotification(message);
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          for (const event of events) yield event;
        }
      }
    } catch (error) {
      protocolFailed = true;
      terminal = true;
      this.#terminate(active.child);
      yield {
        kind: "failed",
        message: error instanceof ProviderProtocolError ? error.message : "ACP stream processing failed.",
      };
    } finally {
      clearTimeout(phaseTimer);
      this.#active.delete(id);
      this.permissions.closeRun(id, active.cancelled ? "cancelled" : "provider_failed");
    }
    if (active.cancelled && !protocolFailed) yield { kind: "cancelled" };
    else if (active.timedOut && !protocolFailed) {
      yield { kind: "failed", message: "The ACP provider stopped responding and was terminated." };
    }
    else if (active.spawnFailed && !protocolFailed) {
      yield { kind: "failed", message: "The adapter executable could not be started." };
    }
    else if (!terminal) yield { kind: "failed", message: "ACP provider exited before completing the turn." };
  }
}
