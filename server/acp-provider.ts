import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PermissionBroker } from "./permission.ts";
import {
  type ProviderEvent,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
} from "./provider.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";
import { acpSetModelRequest } from "./acp-models.ts";
import { constrainPath, RepositoryError } from "./repository.ts";

const MAX_ACP_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACP_FS_READ_BYTES = 1024 * 1024;
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
      name: typeof update.title === "string" && update.title.trim()
        ? update.title.trim()
        : "Tool",
    }];
  }
  if (updateType === "tool_call_update") {
    // Agents (notably Grok Build) emit metadata-only tool_call_update frames with
    // no status — title/locations/kind enrichment. Those are progress, not terminal.
    const rawStatus = update.status;
    if (rawStatus === undefined || rawStatus === null || rawStatus === "") return [];
    const status = String(rawStatus).toLowerCase();
    if (status === "completed" || status === "success") {
      return [{
        kind: "tool_finished",
        toolCallId: requiredString(update.toolCallId, "tool call ID"),
        failed: false,
      }];
    }
    if (status === "failed" || status === "error") {
      return [{
        kind: "tool_finished",
        toolCallId: requiredString(update.toolCallId, "tool call ID"),
        failed: true,
      }];
    }
    // Intermediate / soft statuses — ignore without failing the turn.
    if (
      status === "pending"
      || status === "in_progress"
      || status === "running"
      || status === "cancelled"
      || status === "canceled"
    ) {
      return [];
    }
    // Unknown status strings: tolerate rather than kill the conversation.
    return [];
  }
  const informational = new Set([
    "agent_thought_chunk",
    "user_message_chunk",
    "plan",
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "session_info_update",
    "usage_update",
    "turn_end",
  ]);
  if (informational.has(updateType)) return [];
  throw new ProviderProtocolError(`Unsupported ACP session update: ${updateType}.`);
}

export function acpNotificationEvents(
  value: unknown,
  loadingSession: boolean,
): ProviderEvent[] {
  const events = normalizeAcpNotification(value);
  // session/load may replay the provider's native history before replying.
  // Aldunis already owns that timeline, so validate the replay but do not
  // append it as fresh content to the resumed turn.
  return loadingSession ? [] : events;
}

export function acpLoadedSessionId(
  value: unknown,
  resumeSessionId: string | undefined,
): string {
  const result = record(value);
  if (typeof result?.sessionId === "string" && result.sessionId) return result.sessionId;
  if (resumeSessionId) return resumeSessionId;
  throw new ProviderProtocolError("ACP message is missing session ID.");
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

export function isOptionalGrokNotification(adapterId: string, value: unknown): boolean {
  const message = record(value);
  return adapterId === "dev.xai.grok-build"
    && typeof message?.method === "string"
    && message.method.startsWith("_x.ai/")
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

/**
 * Serve ACP `fs/read_text_file` for agents that delegate reads to the client
 * (Grok Build). Path must resolve inside the conversation worktree.
 */
export async function acpReadTextFile(
  worktree: string,
  params: unknown,
): Promise<{ content: string }> {
  const recordParams = record(params);
  const requested = recordParams?.path;
  if (typeof requested !== "string" || !requested) {
    throw new ProviderProtocolError("ACP fs/read_text_file is missing path.");
  }
  const candidate = isAbsolute(requested) ? requested : resolvePath(worktree, requested);
  let path: string;
  try {
    path = await constrainPath(worktree, candidate);
  } catch (error) {
    if (error instanceof RepositoryError) {
      throw new ProviderProtocolError("ACP fs/read_text_file path escapes the conversation worktree.");
    }
    throw new ProviderProtocolError("ACP fs/read_text_file path is not readable.");
  }
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new ProviderProtocolError("ACP fs/read_text_file path is not readable.");
  }
  if (size > MAX_ACP_FS_READ_BYTES) {
    throw new ProviderProtocolError("ACP fs/read_text_file exceeds the host read size limit.");
  }
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new ProviderProtocolError("ACP fs/read_text_file path is not readable.");
  }
  // Optional 1-based line window (ACP clients may request a slice).
  const line = typeof recordParams?.line === "number" && Number.isFinite(recordParams.line)
    ? Math.max(1, Math.floor(recordParams.line))
    : null;
  const limit = typeof recordParams?.limit === "number" && Number.isFinite(recordParams.limit)
    ? Math.max(0, Math.floor(recordParams.limit))
    : null;
  if (line !== null || limit !== null) {
    const lines = content.split("\n");
    const start = (line ?? 1) - 1;
    const end = limit === null ? lines.length : start + limit;
    content = lines.slice(Math.max(0, start), Math.max(0, end)).join("\n");
  }
  return { content };
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
        // Grok Build delegates tool reads via client fs/read_text_file; serve
        // worktree-bounded reads only. Writes stay disabled.
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
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
          active.sessionId = acpLoadedSessionId(message.result, options.resumeSessionId);
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          const selectedModel = options.model?.trim() && options.model !== "default"
            ? options.model.trim()
            : null;
          yield {
            kind: "session_started",
            sessionId: active.sessionId,
            model: selectedModel,
          };
          // Apply model before the first prompt when the agent advertises models.
          if (selectedModel) {
            this.#send(active.child, {
              jsonrpc: "2.0",
              id: 3,
              ...acpSetModelRequest(active.sessionId, selectedModel),
            });
            setPhaseTimeout(ACP_HANDSHAKE_TIMEOUT_MS);
            continue;
          }
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
        if (message.method === undefined && message.id === 3) {
          // session/set_model — proceed even if the agent rejects (best-effort).
          if (!active.sessionId) throw new ProviderProtocolError("ACP completed without a session.");
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
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
          if (message.method === "fs/read_text_file") {
            setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
            try {
              const result = await acpReadTextFile(options.worktree, message.params);
              this.#send(active.child, {
                jsonrpc: "2.0",
                id: message.id as RpcId,
                result,
              });
            } catch (error) {
              this.#send(active.child, {
                jsonrpc: "2.0",
                id: message.id as RpcId,
                error: {
                  code: -32000,
                  message: error instanceof ProviderProtocolError
                    ? error.message
                    : "ACP fs/read_text_file failed.",
                },
              });
            }
            continue;
          }
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
          if (
            isOptionalKiroNotification(this.adapter.manifest.id, message)
            || isOptionalGrokNotification(this.adapter.manifest.id, message)
          ) {
            setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
            continue;
          }
          const events = acpNotificationEvents(
            message,
            Boolean(options.resumeSessionId && active.sessionId === null),
          );
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
