import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PermissionBroker } from "./permission.ts";
import {
  type ProviderEvent,
  type ProviderId,
  type ProviderBrowserMcpConfiguration,
  type ProviderRun,
  type ProviderStartOptions,
  ProviderProtocolError,
} from "./provider.ts";
import { normalizeBrowserObservation } from "./browser-observation.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";
import { acpSetModelRequest, parseAcpSessionModels } from "./acp-models.ts";
import { terminateProviderChild } from "./provider-process.ts";
import { constrainPath, RepositoryError } from "./repository.ts";

const MAX_ACP_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACP_FS_READ_BYTES = 1024 * 1024;
const ACP_HANDSHAKE_TIMEOUT_MS = 10_000;
const ACP_RUN_TIMEOUT_MS = 30 * 60_000;
type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value)
    throw new ProviderProtocolError(`ACP message is missing ${field}.`);
  return value;
}

function textContent(value: unknown): string {
  const content = record(value);
  if (!content || content.type !== "text")
    throw new ProviderProtocolError("ACP emitted unsupported message content.");
  return requiredString(content.text, "message text");
}

function observationBase(value: string, sequence?: string | number): string {
  return sequence === undefined ? value : `${value}:${sequence}`;
}

function acpBrowserObservation(
  value: unknown,
  provider: ProviderId,
  observationId: string,
  toolCallId: string | undefined,
  enabled: boolean,
): ProviderEvent[] {
  if (!enabled) return [];
  const outer = record(value);
  const image = outer?.type === "content" ? record(outer.content) : outer;
  if (!image || image.type !== "image") return [];
  const observation = normalizeBrowserObservation({
    provider,
    observationId,
    toolCallId,
    imageData: image.data ?? image.imageData,
    mediaType: image.mimeType ?? image.mediaType,
    title: image.title,
    url: image.url,
  });
  return observation ? [observation] : [];
}

function acpBrowserObservations(
  value: unknown,
  provider: ProviderId,
  observationId: string,
  toolCallId?: string,
  enabled = false,
  observationSequence?: string | number,
): ProviderEvent[] {
  if (!enabled) return [];
  const entries = Array.isArray(value) ? value : [value];
  const scopedObservationId = observationBase(observationId, observationSequence);
  return entries.flatMap((entry, index) =>
    acpBrowserObservation(entry, provider, `${scopedObservationId}:${index}`, toolCallId, enabled),
  );
}

function acpMessageEvents(
  value: unknown,
  provider: ProviderId,
  observationId: string,
  browserObservationEnabled: boolean,
  observationSequence?: string | number,
): ProviderEvent[] {
  const entries = Array.isArray(value) ? value : [value];
  const scopedObservationId = observationBase(observationId, observationSequence);
  return entries.flatMap((entry, index) => {
    const outer = record(entry);
    const content = outer?.type === "content" ? record(outer.content) : outer;
    if (content?.type === "text") {
      // Streaming ACP providers may emit an empty text chunk as framing between
      // progress updates. It carries no conversation content, but it is still a
      // valid text payload and must not terminate the provider session.
      if (content.text === "") return [];
      return [{ kind: "assistant_text", text: requiredString(content.text, "message text") }];
    }
    if (content?.type === "image") {
      const observations = acpBrowserObservation(
        entry,
        provider,
        `${scopedObservationId}:${index}`,
        undefined,
        browserObservationEnabled,
      );
      if (observations.length > 0) return observations;
    }
    throw new ProviderProtocolError("ACP emitted unsupported message content.");
  });
}

export function normalizeAcpNotification(
  value: unknown,
  provider: ProviderId = "adapter:test@1.0.0",
  browserObservationEnabled = false,
  observationSequence?: string | number,
): ProviderEvent[] {
  const message = record(value);
  if (
    !message ||
    (message.method !== "session/update" && message.method !== "session/notification")
  ) {
    throw new ProviderProtocolError(`Unsupported ACP notification: ${String(message?.method)}.`);
  }
  const params = record(message.params);
  const update = record(params?.update);
  const updateType =
    typeof update?.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update?.type === "string"
        ? (
            {
              AgentMessageChunk: "agent_message_chunk",
              ToolCall: "tool_call",
              ToolCallUpdate: "tool_call_update",
              TurnEnd: "turn_end",
            } as Record<string, string>
          )[update.type]
        : undefined;
  if (!update || !updateType) {
    throw new ProviderProtocolError("ACP emitted a malformed session update.");
  }
  if (updateType === "agent_message_chunk") {
    return withAcpContextUsage(
      acpMessageEvents(
        update.content,
        provider,
        "agent-message",
        browserObservationEnabled,
        observationSequence,
      ),
      params,
      provider,
    );
  }
  if (updateType === "agent_thought_chunk") {
    return withAcpContextUsage(
      [{ kind: "thinking", text: textContent(update.content) }],
      params,
      provider,
    );
  }
  if (updateType === "tool_call") {
    return withAcpContextUsage(
      [
        {
          kind: "tool_started",
          toolCallId: requiredString(update.toolCallId, "tool call ID"),
          name:
            typeof update.title === "string" && update.title.trim() ? update.title.trim() : "Tool",
        },
      ],
      params,
      provider,
    );
  }
  if (updateType === "tool_call_update") {
    // Agents (notably Grok Build) emit metadata-only tool_call_update frames with
    // no status — title/locations/kind enrichment. Those are progress, not terminal.
    const toolCallId = requiredString(update.toolCallId, "tool call ID");
    const observations = acpBrowserObservations(
      update.content ?? update.output,
      provider,
      `tool:${toolCallId}`,
      toolCallId,
      browserObservationEnabled,
      observationSequence,
    );
    const rawStatus = update.status;
    if (observations.length > 0) {
      if (rawStatus === "completed" || rawStatus === "success") {
        return withAcpContextUsage(
          [...observations, { kind: "tool_finished", toolCallId, failed: false }],
          params,
          provider,
        );
      }
      if (rawStatus === "failed" || rawStatus === "error") {
        return withAcpContextUsage(
          [...observations, { kind: "tool_finished", toolCallId, failed: true }],
          params,
          provider,
        );
      }
      return withAcpContextUsage(observations, params, provider);
    }
    if (rawStatus === undefined || rawStatus === null || rawStatus === "") {
      return withAcpContextUsage([], params, provider);
    }
    const status = String(rawStatus).toLowerCase();
    if (status === "completed" || status === "success") {
      return withAcpContextUsage(
        [
          {
            kind: "tool_finished",
            toolCallId,
            failed: false,
          },
        ],
        params,
        provider,
      );
    }
    if (status === "failed" || status === "error") {
      return withAcpContextUsage(
        [
          {
            kind: "tool_finished",
            toolCallId,
            failed: true,
          },
        ],
        params,
        provider,
      );
    }
    // Intermediate / soft statuses — ignore without failing the turn.
    if (
      status === "pending" ||
      status === "in_progress" ||
      status === "running" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      return withAcpContextUsage([], params, provider);
    }
    // Unknown status strings: tolerate rather than kill the conversation.
    return withAcpContextUsage([], params, provider);
  }
  if (updateType === "plan") {
    const sessionId = requiredString(params?.sessionId, "session ID");
    if (!Array.isArray(update.entries)) {
      throw new ProviderProtocolError("ACP emitted a malformed plan.");
    }
    const steps = update.entries.map((value) => {
      const entry = record(value);
      if (!entry) throw new ProviderProtocolError("ACP emitted a malformed plan entry.");
      const rawStatus = entry.status;
      const status =
        rawStatus === undefined ? "neutral" : rawStatus === "in_progress" ? "active" : rawStatus;
      if (
        status !== "pending" &&
        status !== "active" &&
        status !== "completed" &&
        status !== "neutral"
      ) {
        throw new ProviderProtocolError(`Unsupported ACP plan status: ${String(rawStatus)}.`);
      }
      return { content: requiredString(entry.content, "plan entry content"), status };
    });
    return withAcpContextUsage(
      [
        {
          kind: "plan_updated",
          artifact: {
            id: `session:${sessionId}`,
            provider,
            steps,
          },
        },
      ],
      params,
      provider,
    );
  }
  if (updateType === "usage_update") {
    // Standard ACP usage_update (used/size). Prefer the update body; fall back to
    // Grok-only params._meta when that agent stamps token pressure on meta.
    return withAcpContextUsage(normalizeAcpUsageUpdate(update), params, provider);
  }
  const informational = new Set([
    "user_message_chunk",
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "session_info_update",
    "turn_end",
  ]);
  // Grok Build extension session updates (xAI-specific). Tolerate only for the
  // reviewed Grok adapter so other ACP agents still fail closed on unknowns.
  if (isGrokBuildProvider(provider)) {
    for (const extensionUpdate of [
      "turn_completed",
      "task_backgrounded",
      "task_completed",
      "session_recap",
      "auto_compact_started",
      "auto_compact_completed",
      "compaction_checkpoint",
      "subagent_spawned",
      "subagent_finished",
      "retry_state",
      "image_dropped",
      "image_compressed",
      "hook_execution",
    ]) {
      informational.add(extensionUpdate);
    }
  }
  if (informational.has(updateType)) return withAcpContextUsage([], params, provider);
  throw new ProviderProtocolError(`Unsupported ACP session update: ${updateType}.`);
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function usageFieldsFromRecord(source: Record<string, unknown>): ProviderEvent[] {
  const usedTokens =
    finiteNonNegative(source.usedTokens) ??
    finiteNonNegative(source.used) ??
    finiteNonNegative(source.tokens) ??
    finiteNonNegative(source.totalTokens) ??
    finiteNonNegative(source.contextTokens);
  if (usedTokens === null) return [];
  const maxTokens =
    finiteNonNegative(source.maxTokens) ??
    finiteNonNegative(source.size) ??
    finiteNonNegative(source.contextWindow) ??
    finiteNonNegative(source.contextWindowSize) ??
    finiteNonNegative(source.limit);
  const usage: Extract<ProviderEvent, { kind: "context_usage" }> = {
    kind: "context_usage",
    usedTokens,
    maxTokens,
    totalProcessedTokens:
      finiteNonNegative(source.totalProcessedTokens) ?? finiteNonNegative(source.cumulativeTokens),
    inputTokens: finiteNonNegative(source.inputTokens),
    outputTokens: finiteNonNegative(source.outputTokens),
  };
  const cachedInputTokens =
    finiteNonNegative(source.cachedInputTokens) ??
    finiteNonNegative(source.cacheReadInputTokens) ??
    finiteNonNegative(source.cacheReadTokens);
  const cacheWriteInputTokens =
    finiteNonNegative(source.cacheWriteInputTokens) ??
    finiteNonNegative(source.cacheCreationInputTokens) ??
    finiteNonNegative(source.cacheWriteTokens);
  const reasoningOutputTokens =
    finiteNonNegative(source.reasoningOutputTokens) ?? finiteNonNegative(source.reasoningTokens);
  if (cachedInputTokens !== null) usage.cachedInputTokens = cachedInputTokens;
  if (cacheWriteInputTokens !== null) usage.cacheWriteInputTokens = cacheWriteInputTokens;
  if (reasoningOutputTokens !== null) usage.reasoningOutputTokens = reasoningOutputTokens;
  return [usage];
}

/**
 * Best-effort ACP usage_update → context_usage. Providers disagree on field
 * names; only emit when a usable used/max pair (or used alone) is present.
 * Accepts flat fields or a nested `usage` object (stabilized ACP shape and
 * several agent layouts).
 */
export function normalizeAcpUsageUpdate(update: Record<string, unknown>): ProviderEvent[] {
  const nested = record(update.usage);
  const fromUpdate = usageFieldsFromRecord(update);
  if (fromUpdate.length > 0) return fromUpdate;
  return nested ? usageFieldsFromRecord(nested) : [];
}

/** True for the shipped Grok Build declarative adapter only. */
export function isGrokBuildProvider(provider: ProviderId | string | undefined): boolean {
  if (!provider) return false;
  // Match the reviewed package id exactly — not substring "grok-build" wrappers.
  return (
    provider === "dev.xai.grok-build" ||
    provider.startsWith("adapter:dev.xai.grok-build@") ||
    provider.startsWith("dev.xai.grok-build@")
  );
}

/**
 * Grok Build does not emit ACP `usage_update`. Instead it stamps live context
 * fill on every session/update as `params._meta.totalTokens`. Pull that into
 * the same ephemeral `context_usage` event the composer meter already consumes.
 *
 * Gated to Grok Build: other ACP agents may put differently defined numbers in
 * `_meta.totalTokens`. Nested `update.usage` on non-usage_update frames is also
 * ignored — Grok's `turn_completed.usage` is cumulative API accounting, not
 * context window occupancy.
 */
export function contextUsageFromAcpParams(
  params: JsonRecord | null | undefined,
  provider?: ProviderId | string,
): ProviderEvent[] {
  if (!isGrokBuildProvider(provider)) return [];
  const meta = record(params?._meta);
  if (!meta) return [];
  // Prefer explicit context-window field names when present; Grok Build only
  // stamps totalTokens as the live context fill.
  return usageFieldsFromRecord({
    usedTokens: meta.usedTokens ?? meta.used ?? meta.contextTokens ?? meta.totalTokens,
    maxTokens:
      meta.maxTokens ?? meta.size ?? meta.contextWindow ?? meta.contextWindowSize ?? meta.limit,
    totalProcessedTokens: meta.totalProcessedTokens ?? meta.cumulativeTokens,
    inputTokens: meta.inputTokens,
    outputTokens: meta.outputTokens,
    cachedInputTokens: meta.cachedInputTokens ?? meta.cacheReadInputTokens ?? meta.cacheReadTokens,
    cacheWriteInputTokens:
      meta.cacheWriteInputTokens ?? meta.cacheCreationInputTokens ?? meta.cacheWriteTokens,
    reasoningOutputTokens: meta.reasoningOutputTokens ?? meta.reasoningTokens,
  });
}

function withAcpContextUsage(
  events: ProviderEvent[],
  params: JsonRecord | null | undefined,
  provider: ProviderId | string | undefined,
): ProviderEvent[] {
  if (events.some((event) => event.kind === "context_usage")) return events;
  return [...events, ...contextUsageFromAcpParams(params, provider)];
}

export function acpNotificationEvents(
  value: unknown,
  loadingSession: boolean,
  provider: ProviderId = "adapter:test@1.0.0",
  browserObservationEnabled = false,
  observationSequence?: string | number,
): ProviderEvent[] {
  const events = normalizeAcpNotification(
    value,
    provider,
    browserObservationEnabled,
    observationSequence,
  );
  // session/load may replay the provider's native history before replying.
  // Aldunis already owns that timeline, so validate the replay but do not
  // append it as fresh content to the resumed turn.
  return loadingSession ? [] : events;
}

export function acpLoadedSessionId(value: unknown, resumeSessionId: string | undefined): string {
  const result = record(value);
  if (typeof result?.sessionId === "string" && result.sessionId) return result.sessionId;
  if (resumeSessionId) return resumeSessionId;
  throw new ProviderProtocolError("ACP message is missing session ID.");
}

export function isOptionalKiroNotification(adapterId: string, value: unknown): boolean {
  const message = record(value);
  return (
    adapterId === "dev.kiro.cli" &&
    typeof message?.method === "string" &&
    (message.method.startsWith("_kiro.dev/") || message.method === "_session/terminate") &&
    message.id === undefined
  );
}

export function isOptionalGrokNotification(adapterId: string, value: unknown): boolean {
  const message = record(value);
  return (
    adapterId === "dev.xai.grok-build" &&
    typeof message?.method === "string" &&
    message.method.startsWith("_x.ai/") &&
    message.id === undefined
  );
}

export function acpSessionRequest(
  resumeSessionId: string | undefined,
  manifestSupportsResume: boolean,
  agentSupportsResume: boolean,
  worktree: string,
  browserMcp?: ProviderBrowserMcpConfiguration,
): { method: "session/load" | "session/new"; params: JsonRecord } | null {
  if (resumeSessionId && (!manifestSupportsResume || !agentSupportsResume)) return null;
  const resume = Boolean(resumeSessionId);
  return {
    method: resume ? "session/load" : "session/new",
    params: {
      ...(resume ? { sessionId: resumeSessionId } : {}),
      cwd: worktree,
      mcpServers: browserMcp
        ? [
            {
              name: browserMcp.name,
              command: browserMcp.command,
              args: browserMcp.args,
              env: Object.entries(browserMcp.environment).map(([name, value]) => ({ name, value })),
            },
          ]
        : [],
    },
  };
}

export function assertAcpSelectedModel(result: unknown, selectedModel: string): void {
  if (!parseAcpSessionModels(result).some((model) => model.id === selectedModel)) {
    throw new ProviderProtocolError("ACP did not advertise the selected model for this session.");
  }
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
      throw new ProviderProtocolError(
        "ACP fs/read_text_file path escapes the conversation worktree.",
      );
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
  const line =
    typeof recordParams?.line === "number" && Number.isFinite(recordParams.line)
      ? Math.max(1, Math.floor(recordParams.line))
      : null;
  const limit =
    typeof recordParams?.limit === "number" && Number.isFinite(recordParams.limit)
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
    const environment = buildAcpEnvironment(this.adapter, this.inheritedEnvironment);
    if (options.browserMcp) {
      Object.assign(environment, options.browserMcp.environment);
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
    terminateProviderChild(child);
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
    let notificationSequence = 0;
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
            this.adapter.manifest.capabilities.browserAutomation === true
              ? options.browserMcp
              : undefined,
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
          if (message.error)
            throw new ProviderProtocolError("ACP could not start or load the session.");
          active.sessionId = acpLoadedSessionId(message.result, options.resumeSessionId);
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          const selectedModel =
            options.model?.trim() && options.model !== "default" ? options.model.trim() : null;
          // ACP session/load is not required to repeat the session/new model
          // catalog. A resumed session still gets a live set_model request,
          // whose response is checked below when a concrete model is selected.
          if (selectedModel && !options.resumeSessionId) {
            assertAcpSelectedModel(message.result, selectedModel);
          }
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
            ...acpPromptRequest(active.sessionId, options.prompt),
          });
          continue;
        }
        if (message.method === undefined && message.id === 3) {
          if (message.error) throw new ProviderProtocolError("ACP rejected the selected model.");
          if (!active.sessionId)
            throw new ProviderProtocolError("ACP completed without a session.");
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          this.#send(active.child, {
            jsonrpc: "2.0",
            id: 2,
            ...acpPromptRequest(active.sessionId, options.prompt),
          });
          continue;
        }
        if (message.method === undefined && message.id === 2) {
          setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
          if (message.error) throw new ProviderProtocolError("ACP could not complete the prompt.");
          if (!active.sessionId)
            throw new ProviderProtocolError("ACP completed without a session.");
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
                  message:
                    error instanceof ProviderProtocolError
                      ? error.message
                      : "ACP fs/read_text_file failed.",
                },
              });
            }
            continue;
          }
          if (message.method !== "session/request_permission") {
            this.#send(active.child, {
              jsonrpc: "2.0",
              id: message.id as RpcId,
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
          const toolName =
            kind === "execute"
              ? typeof rawInput?.command === "string"
                ? "Bash"
                : "ProviderAction"
              : kind === "edit"
                ? locationPaths.length > 0
                  ? "Edit"
                  : "ProviderAction"
                : kind === "delete"
                  ? locationPaths.length > 0
                    ? "Delete"
                    : "ProviderAction"
                  : kind === "move"
                    ? locationPaths.length > 0
                      ? "Move"
                      : "ProviderAction"
                    : kind === "read" || kind === "search" || kind === "think" || kind === "fetch"
                      ? ""
                      : "ProviderAction";
          if (
            !toolName ||
            !allowOnceOption ||
            (toolName === "ProviderAction" &&
              locationPaths.length === 0 &&
              typeof toolCall?.title !== "string") ||
            options.mode !== "build" ||
            !this.adapter.manifest.capabilities.tools
          ) {
            this.#send(active.child, {
              jsonrpc: "2.0",
              id: message.id as RpcId,
              result: { outcome: { outcome: "cancelled" } },
            });
            continue;
          }
          const input =
            toolName === "Bash"
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
          const task = this.permissions
            .awaitRegisteredDecision(id, token, approval.id)
            .then((decision) =>
              this.#send(active.child, {
                jsonrpc: "2.0",
                id: message.id as RpcId,
                result: {
                  outcome:
                    decision.behavior === "allow"
                      ? { outcome: "selected", optionId: allowOnceOption }
                      : { outcome: "cancelled" },
                },
              }),
            )
            .catch(() =>
              this.#send(active.child, {
                jsonrpc: "2.0",
                id: message.id as RpcId,
                result: { outcome: { outcome: "cancelled" } },
              }),
            )
            .finally(() => approvalTasks.delete(task));
          approvalTasks.add(task);
          continue;
        }
        if (typeof message.method === "string") {
          if (
            isOptionalKiroNotification(this.adapter.manifest.id, message) ||
            isOptionalGrokNotification(this.adapter.manifest.id, message)
          ) {
            setPhaseTimeout(ACP_RUN_TIMEOUT_MS);
            continue;
          }
          const events = acpNotificationEvents(
            message,
            Boolean(options.resumeSessionId && active.sessionId === null),
            `adapter:${this.adapter.manifest.id}@${this.adapter.manifest.version}`,
            this.adapter.manifest.capabilities.browserObservation,
            `${id}:${notificationSequence++}`,
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
        message:
          error instanceof ProviderProtocolError ? error.message : "ACP stream processing failed.",
      };
    } finally {
      clearTimeout(phaseTimer);
      this.#active.delete(id);
      this.permissions.closeRun(id, active.cancelled ? "cancelled" : "provider_failed");
    }
    if (active.cancelled && !protocolFailed) yield { kind: "cancelled" };
    else if (active.timedOut && !protocolFailed) {
      yield { kind: "failed", message: "The ACP provider stopped responding and was terminated." };
    } else if (active.spawnFailed && !protocolFailed) {
      yield { kind: "failed", message: "The adapter executable could not be started." };
    } else if (!terminal)
      yield { kind: "failed", message: "ACP provider exited before completing the turn." };
  }
}

/**
 * Reconstruct the bounded environment used by an ACP adapter process.
 * Discovery probes and real runs must see the same reviewed inputs.
 */
export function buildAcpEnvironment(
  adapter: InstalledProviderAdapter,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const reference of adapter.manifest.environment) {
    const value = inheritedEnvironment[reference.name];
    if (reference.required && value === undefined) {
      throw new ProviderProtocolError(`Required environment ${reference.name} is unavailable.`);
    }
    if (value !== undefined) environment[reference.name] = value;
  }
  // A minimal process environment is required for predictable subprocess
  // behavior; no unrelated credential-bearing values are inherited.
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
    const value = inheritedEnvironment[name];
    if (value !== undefined && environment[name] === undefined) environment[name] = value;
  }
  return environment;
}
