import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { MAX_APPROVAL_PATHS, PermissionBroker } from "./permission.ts";
import {
  type ProviderEvent,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
  type ReasoningEffort,
} from "./provider.ts";

const execFileAsync = promisify(execFile);
const SUPPORTED_CODEX_MAJOR = 0;
const SUPPORTED_CODEX_MINOR = 144;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
  threadId: string | null;
  turnId: string | null;
  fileChanges: Map<string, string[]>;
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
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ProviderProtocolError(`Codex event is missing ${field}.`);
  }
  return value;
}

export function assertSupportedCodexVersion(output: string): string {
  const match = output.match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/);
  if (
    !match
    || Number(match[1]) !== SUPPORTED_CODEX_MAJOR
    || Number(match[2]) !== SUPPORTED_CODEX_MINOR
  ) {
    throw new ProviderProtocolError(
      `Unsupported Codex CLI version. Aldunis Code requires ${SUPPORTED_CODEX_MAJOR}.${SUPPORTED_CODEX_MINOR}.x.`,
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
      !entry
      || typeof entry.path !== "string"
      || !kind
      || (kind.type !== "add" && kind.type !== "delete" && kind.type !== "update")
      || (kind.type === "update" && kind.move_path != null && typeof kind.move_path !== "string")
    ) {
      throw new ProviderProtocolError("Codex emitted a malformed file change.");
    }
    paths.push(
      entry.path,
      ...(kind.type === "update" && typeof kind.move_path === "string"
        ? [kind.move_path]
        : []),
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
      canonicalRelative === ".."
      || canonicalRelative.startsWith(`..${sep}`)
      || isAbsolute(canonicalRelative)
    ) return false;
  }
  return true;
}

function itemEvents(itemValue: unknown, completed: boolean): ProviderEvent[] {
  const item = record(itemValue);
  if (!item) throw new ProviderProtocolError("Codex emitted a malformed item.");
  const id = string(item.id, "item id");
  if (item.type === "agentMessage") {
    return completed ? [{ kind: "assistant_text", text: string(item.text, "agent text") }] : [];
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
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    throw new ProviderProtocolError(
      "Codex attempted external tool activity that Aldunis Code does not authorize.",
    );
  }
  const informationalItemTypes = new Set([
    "userMessage",
    "hookPrompt",
    "plan",
    "reasoning",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
    "subAgentActivity",
  ]);
  if (informationalItemTypes.has(String(item.type))) return [];
  throw new ProviderProtocolError(`Unsupported Codex item type: ${String(item.type)}.`);
}

export function normalizeCodexNotification(value: unknown): ProviderEvent[] {
  const message = record(value);
  const method = string(message?.method, "method");
  const params = record(message?.params);
  if (!params) throw new ProviderProtocolError("Codex emitted malformed notification parameters.");
  if (method === "item/started") return itemEvents(params.item, false);
  if (method === "item/completed") return itemEvents(params.item, true);
  if (method === "turn/completed") {
    const turn = record(params.turn);
    if (!turn) throw new ProviderProtocolError("Codex emitted a malformed completed turn.");
    const error = record(turn.error);
    if (turn.status === "failed") {
      return [{ kind: "failed", message: typeof error?.message === "string"
        ? error.message
        : "Codex could not complete the turn." }];
    }
    if (turn.status === "interrupted") return [{ kind: "cancelled" }];
    if (turn.status === "completed") return [];
    throw new ProviderProtocolError(`Unsupported Codex turn status: ${String(turn.status)}.`);
  }
  if (method === "error") {
    const error = record(params.error);
    return [{ kind: "failed", message: typeof error?.message === "string"
      ? error.message
      : "Codex reported a provider error." }];
  }
  const informational = new Set([
    "turn/started",
    "turn/diff/updated",
    "turn/plan/updated",
    "turn/moderationMetadata",
    "thread/started",
    "thread/status/changed",
    "thread/tokenUsage/updated",
    "skills/changed",
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "item/mcpToolCall/progress",
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
    "serverRequest/resolved",
    "model/rerouted",
    "model/verification",
    "model/safetyBuffering/updated",
    "warning",
    "deprecationNotice",
    "configWarning",
    "remoteControl/status/changed",
    "mcpServer/startupStatus/updated",
    "account/updated",
    "account/rateLimits/updated",
    "app/list/updated",
  ]);
  if (informational.has(method)) return [];
  throw new ProviderProtocolError(`Unsupported Codex notification: ${method}.`);
}

export class CodexCliAdapter {
  readonly id = "codex-cli" as const;
  readonly #active = new Map<string, ActiveRun>();

  constructor(
    private readonly executable = "codex",
    private readonly permissions = new PermissionBroker(),
  ) {}

  #appServerArguments(): string[] {
    return [
      "app-server",
      "--stdio",
      "--strict-config",
      // Aldunis Code has no mid-turn question UI yet, so the provider must not
      // advertise a request type the host cannot complete.
      "--disable",
      "default_mode_request_user_input",
      "-c",
      "mcp_servers={}",
      "-c",
      "apps._default.enabled=false",
      "-c",
      'web_search="disabled"',
    ];
  }

  async readiness(): Promise<CodexReadiness> {
    let version: string;
    try {
      const result = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      version = assertSupportedCodexVersion(result.stdout.trim());
    } catch {
      return { id: this.id, installed: false, authenticated: false, version: null, models: [] };
    }
    const child = spawn(this.executable, this.#appServerArguments(), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const lines = this.#lines(child);
    let authenticated = false;
    let models: CodexModel[] = [];
    let gotAccount = false;
    let gotModels = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1_000);
      force.unref();
    }, 5_000);
    timeout.unref();
    try {
      this.#send(child, { method: "initialize", id: 0, params: {
        clientInfo: { name: "aldunis_code", title: "Aldunis Code", version: "0.1.0" },
      } });
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
                return effort === "minimal" || effort === "low" || effort === "medium"
                  || effort === "high" || effort === "xhigh" ? [effort] : [];
              })
              : [];
            return [{
              id: model.id,
              displayName: typeof model.displayName === "string" ? model.displayName : model.id,
              isDefault: model.isDefault === true,
              reasoningEfforts: efforts,
              defaultReasoningEffort: efforts.includes(model.defaultReasoningEffort as ReasoningEffort)
                ? model.defaultReasoningEffort as ReasoningEffort
                : efforts[0] ?? "medium",
            }];
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
      return { id: this.id, installed: false, authenticated: false, version: null, models: [] };
    }
    if (!gotAccount || !gotModels) {
      return { id: this.id, installed: true, authenticated: false, version, models: [] };
    }
    return { id: this.id, installed: true, authenticated, version, models };
  }

  async start(options: ProviderStartOptions): Promise<ProviderRun> {
    try {
      const result = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8", timeout: 5_000,
      });
      assertSupportedCodexVersion(result.stdout.trim());
    } catch {
      throw new ProviderProtocolError("Codex CLI is not installed or could not be started.");
    }
    const id = randomUUID();
    const child = spawn(this.executable, this.#appServerArguments(), {
      cwd: options.worktree,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const active: ActiveRun = {
      child, cancelled: false, spawnFailed: false, threadId: null, turnId: null,
      fileChanges: new Map(),
    };
    child.once("error", () => { active.spawnFailed = true; });
    this.#active.set(id, active);
    return { id, events: this.#events(id, active, options) };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    this.permissions.closeRun(id, "cancelled");
    if (active.threadId && active.turnId) {
      this.#send(active.child, {
        method: "turn/interrupt", id: 99,
        params: { threadId: active.threadId, turnId: active.turnId },
      });
      const terminate = setTimeout(() => {
        if (active.child.exitCode === null) active.child.kill("SIGTERM");
        const force = setTimeout(() => {
          if (active.child.exitCode === null) active.child.kill("SIGKILL");
        }, 2_000);
        force.unref();
      }, 2_000);
      terminate.unref();
    } else {
      active.child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (active.child.exitCode === null) active.child.kill("SIGKILL");
      }, 2_000);
      force.unref();
    }
    return true;
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
      if (Buffer.byteLength(buffer) > MAX_PROVIDER_LINE_BYTES) {
        throw new ProviderProtocolError("Codex emitted an oversized message.");
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let value: unknown;
          try { value = JSON.parse(line); } catch {
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
    if (buffer.trim()) throw new ProviderProtocolError("Codex emitted an incomplete message.");
  }

  async *#events(
    id: string,
    active: ActiveRun,
    options: ProviderStartOptions,
  ): AsyncIterable<ProviderEvent> {
    const token = this.permissions.createRunToken(id);
    this.#send(active.child, { method: "initialize", id: 0, params: {
      clientInfo: { name: "aldunis_code", title: "Aldunis Code", version: "0.1.0" },
    } });
    let protocolFailed = false;
    let terminalEmitted = false;
    const approvalTasks = new Set<Promise<void>>();
    try {
      for await (const message of this.#lines(active.child)) {
        if (message.id === 0) {
          if (message.error) throw new ProviderProtocolError("Codex app-server initialization failed.");
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
          if (message.error) throw new ProviderProtocolError("Codex could not start or resume the thread.");
          const result = record(message.result);
          const thread = record(result?.thread);
          active.threadId = string(thread?.id, "thread id");
          yield {
            kind: "session_started",
            sessionId: active.threadId,
            model: typeof result?.model === "string" ? result.model : options.model ?? null,
          };
          this.#send(active.child, { method: "turn/start", id: 2, params: {
            threadId: active.threadId,
            input: [{ type: "text", text: options.prompt, text_elements: [] }],
            cwd: options.worktree,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            model: options.model ?? null,
            effort: options.reasoningEffort ?? null,
          } });
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
          const params = record(message.params);
          if (!params) throw new ProviderProtocolError("Codex emitted malformed approval parameters.");
          const isCommand = message.method === "item/commandExecution/requestApproval";
          const isFile = message.method === "item/fileChange/requestApproval";
          if (!isCommand && !isFile) {
            this.#send(active.child, { id: message.id as RpcId, error: {
              code: -32601, message: "Aldunis Code does not support this provider request.",
            } });
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
          const toolCallId = isCommand && typeof params.approvalId === "string"
            ? `${itemId}:${params.approvalId}`
            : itemId;
          const toolName = isCommand ? "Bash" : "Edit";
          const network = record(params.networkApprovalContext);
          if (isCommand && params.command == null && (
            typeof network?.host !== "string" || typeof network.protocol !== "string"
          )) {
            this.#send(active.child, {
              id: message.id as RpcId,
              result: { decision: "decline" },
            });
            continue;
          }
          const changedPaths = active.fileChanges.get(toolCallId);
          if (
            isFile
            && (
              !changedPaths
              || changedPaths.length === 0
              || changedPaths.length > MAX_APPROVAL_PATHS
              || !(await pathsWithinWorktree(options.worktree, changedPaths))
            )
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
          const approvalTask = this.permissions.awaitRegisteredDecision(id, token, approval.id)
            .then(async (decision) => {
              const currentPaths = isFile ? active.fileChanges.get(toolCallId) ?? [] : [];
              const scopeUnchanged = !isFile || (
                currentPaths.length === changedPaths?.length
                && currentPaths.every((path, index) => path === changedPaths[index])
              );
              const remainsWithinWorktree = currentPaths.length === 0
                || await pathsWithinWorktree(options.worktree, currentPaths);
              this.#send(active.child, {
                id: message.id as RpcId,
                result: {
                  decision: decision.behavior === "allow"
                    && scopeUnchanged
                    && remainsWithinWorktree
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
              active.fileChanges.set(params.itemId, codexFileChangePaths({
                type: "fileChange",
                changes: params.changes,
              }));
            }
          }
          for (const event of normalizeCodexNotification(message)) {
            yield event;
            if (event.kind === "cancelled" || event.kind === "failed") {
              terminalEmitted = true;
              this.#terminate(active.child);
            }
          }
          if (message.method === "turn/completed") {
            const params = record(message.params);
            const turn = record(params?.turn);
            if (turn?.status === "completed" && active.threadId) {
              terminalEmitted = true;
              yield { kind: "turn_completed", sessionId: active.threadId, costUsd: null };
              this.#terminate(active.child);
            }
          }
        }
      }
    } catch (error) {
      protocolFailed = true;
      this.#terminate(active.child);
      terminalEmitted = true;
      yield { kind: "failed", message: error instanceof ProviderProtocolError
        ? error.message
        : "Codex stream processing failed." };
    } finally {
      this.#active.delete(id);
      this.permissions.closeRun(id, active.cancelled ? "cancelled" : "provider_failed");
    }
    if (active.cancelled && !protocolFailed && !terminalEmitted) yield { kind: "cancelled" };
    else if (active.spawnFailed && !protocolFailed) {
      yield { kind: "failed", message: "Codex CLI is not installed or could not be started." };
    } else if (!protocolFailed && !terminalEmitted) {
      yield { kind: "failed", message: "Codex CLI exited before completing the turn." };
    }
  }
}
