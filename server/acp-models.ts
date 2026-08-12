/**
 * Discover and apply ACP session models (Kiro, Grok Build, OpenCode, …).
 *
 * Agents expose models on session/new as:
 *   { models: { currentModelId, availableModels: [{ modelId, name, ... }] } }
 * Selection uses session/set_model { sessionId, modelId }.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ReasoningEffort } from "./provider.ts";

export interface AcpDiscoveredModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function parseEffort(value: unknown): ReasoningEffort | null {
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : null;
}

function effortsFromMeta(meta: JsonRecord | null): {
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
} {
  const list: ReasoningEffort[] = [];
  const raw = meta?.reasoningEfforts;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const row = record(entry);
      const effort = parseEffort(row?.value ?? row?.id ?? row?.reasoningEffort);
      if (effort && !list.includes(effort)) list.push(effort);
    }
  }
  const single = parseEffort(meta?.reasoningEffort);
  if (single && !list.includes(single)) list.push(single);
  if (list.length === 0) {
    return { reasoningEfforts: [], defaultReasoningEffort: "medium" };
  }
  const preferred =
    parseEffort(meta?.reasoningEffort) ??
    list.find((effort) => {
      if (!Array.isArray(raw)) return false;
      return raw.some((entry) => {
        const row = record(entry);
        return row?.default === true && parseEffort(row?.value ?? row?.id) === effort;
      });
    }) ??
    list[0]!;
  return {
    reasoningEfforts: list.filter((effort) => EFFORTS.includes(effort)),
    defaultReasoningEffort: preferred,
  };
}

/** Parse models from a session/new (or initialize) result payload. */
export function parseAcpSessionModels(result: unknown): AcpDiscoveredModel[] {
  const body = record(result);
  if (!body) return [];

  const modelsState = record(body.models);
  const available = Array.isArray(modelsState?.availableModels) ? modelsState.availableModels : [];
  const currentId =
    typeof modelsState?.currentModelId === "string" ? modelsState.currentModelId : null;

  const fromModelsField = available.flatMap((entry): AcpDiscoveredModel[] => {
    const row = record(entry);
    if (!row) return [];
    const id =
      typeof row.modelId === "string" && row.modelId
        ? row.modelId
        : typeof row.id === "string" && row.id
          ? row.id
          : null;
    if (!id) return [];
    const meta = record(row._meta);
    const efforts = effortsFromMeta(meta);
    return [
      {
        id,
        displayName: typeof row.name === "string" && row.name ? row.name : id,
        isDefault: currentId === id,
        ...efforts,
      },
    ];
  });

  // configOptions category=model (preferred ACP config selectors).
  const configOptions = Array.isArray(body.configOptions) ? body.configOptions : [];
  const fromConfig = configOptions.flatMap((entry): AcpDiscoveredModel[] => {
    const option = record(entry);
    if (!option || option.category !== "model" || option.type !== "select") return [];
    const values = Array.isArray(option.options) ? option.options : [];
    const current = typeof option.currentValue === "string" ? option.currentValue : null;
    return values.flatMap((value): AcpDiscoveredModel[] => {
      const row = record(value);
      if (!row || typeof row.value !== "string" || !row.value) return [];
      return [
        {
          id: row.value,
          displayName: typeof row.name === "string" && row.name ? row.name : row.value,
          isDefault: current === row.value,
          reasoningEfforts: [],
          defaultReasoningEffort: "medium",
        },
      ];
    });
  });

  // Prefer session models field; merge config options that add new ids.
  const byId = new Map<string, AcpDiscoveredModel>();
  for (const model of [...fromModelsField, ...fromConfig]) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  const list = [...byId.values()];
  if (list.length > 0 && !list.some((model) => model.isDefault)) {
    list[0] = { ...list[0]!, isDefault: true };
  }
  return list;
}

export function acpSetModelRequest(
  sessionId: string,
  modelId: string,
): { method: "session/set_model"; params: { sessionId: string; modelId: string } } {
  return {
    method: "session/set_model",
    params: { sessionId, modelId },
  };
}

/**
 * Short-lived ACP probe: initialize + session/new, parse models, kill process.
 * Does not send a prompt. Failures return an empty list (discovery is best-effort).
 */
export const MAX_ACTIVE_ACP_MODEL_PROBES = 4;
export const MAX_PENDING_ACP_MODEL_PROBES = 32;
export const MAX_ACP_MODEL_PROBE_MESSAGE_BYTES = 1024 * 1024;
let activeAcpModelProbes = 0;
interface PendingAcpModelProbe {
  resolve(release: (() => void) | null): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}
const pendingAcpModelProbes: PendingAcpModelProbe[] = [];

function releaseAcpModelProbeSlot(): void {
  const next = pendingAcpModelProbes.shift();
  if (next) {
    clearTimeout(next.timer);
    if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
    next.resolve(releaseAcpModelProbeSlot);
  } else {
    activeAcpModelProbes -= 1;
  }
}

function acquireAcpModelProbeSlot(
  waitMs: number,
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  signal?.throwIfAborted();
  if (activeAcpModelProbes < MAX_ACTIVE_ACP_MODEL_PROBES) {
    activeAcpModelProbes += 1;
    return Promise.resolve(releaseAcpModelProbeSlot);
  }
  if (pendingAcpModelProbes.length >= MAX_PENDING_ACP_MODEL_PROBES) {
    return Promise.resolve(null);
  }
  if (waitMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const pending: PendingAcpModelProbe = {
      resolve,
      timer: setTimeout(() => {
        const index = pendingAcpModelProbes.indexOf(pending);
        if (index >= 0) pendingAcpModelProbes.splice(index, 1);
        if (pending.signal && pending.abort) {
          pending.signal.removeEventListener("abort", pending.abort);
        }
        resolve(null);
      }, waitMs),
      signal,
    };
    pending.abort = () => {
      const index = pendingAcpModelProbes.indexOf(pending);
      if (index < 0) return;
      pendingAcpModelProbes.splice(index, 1);
      clearTimeout(pending.timer);
      resolve(null);
    };
    signal?.addEventListener("abort", pending.abort, { once: true });
    pending.timer.unref();
    pendingAcpModelProbes.push(pending);
    if (signal?.aborted) pending.abort();
  });
}

export async function probeAcpModels(options: {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionCwd?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
}): Promise<AcpDiscoveredModel[]> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;
  const releaseSlot = await acquireAcpModelProbeSlot(timeoutMs, options.signal);
  if (!releaseSlot) {
    options.signal?.throwIfAborted();
    return [];
  }
  if (options.signal?.aborted) {
    releaseSlot();
    options.signal.throwIfAborted();
  }
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    releaseSlot();
    return [];
  }
  const terminationGraceMs = options.terminationGraceMs ?? 500;
  const source = options.environment ?? process.env;
  const env: NodeJS.ProcessEnv = { ...source };
  let slotReleased = false;
  const releaseOwnedSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot();
  };

  try {
    return await new Promise((resolve) => {
      let settled = false;
      let forceTimer: NodeJS.Timeout | null = null;
      let completionTimer: NodeJS.Timeout | null = null;
      let timer: NodeJS.Timeout | null = null;
      let abort = () => {};
      const clearForceTimer = () => {
        if (forceTimer) clearTimeout(forceTimer);
        forceTimer = null;
      };
      const finish = (models: AcpDiscoveredModel[]) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        let completed = false;
        const complete = () => {
          if (completed) return;
          completed = true;
          clearForceTimer();
          if (completionTimer) clearTimeout(completionTimer);
          options.signal?.removeEventListener("abort", abort);
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          resolve(models);
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          complete();
          return;
        }
        child.once("exit", complete);
        child.once("close", complete);
        try {
          child.kill("SIGTERM");
          forceTimer = setTimeout(
            () => {
              forceTimer = null;
              try {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              } catch {
                complete();
              }
            },
            Math.max(0, terminationGraceMs),
          );
          forceTimer.unref();
          completionTimer = setTimeout(complete, Math.max(0, terminationGraceMs) + 1_000);
          completionTimer.unref();
        } catch {
          complete();
        }
      };

      const child: ChildProcessWithoutNullStreams = spawn(options.executable, options.arguments, {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", () => finish([]));
      child.once("exit", releaseOwnedSlot);
      child.once("close", () => {
        clearForceTimer();
        releaseOwnedSlot();
      });

      timer = setTimeout(() => finish([]), remainingMs);
      timer.unref();

      abort = () => finish([]);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();

      let buffer = Buffer.alloc(0);
      let sawInit = false;

      const send = (value: unknown) => {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.write(`${JSON.stringify(value)}\n`);
        }
      };

      send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "aldunis-code-model-probe", version: "0.1.0" },
        },
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const incoming = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        let offset = 0;
        let newline = incoming.indexOf(0x0a, offset);
        while (newline !== -1) {
          const segment = incoming.subarray(offset, newline);
          if (buffer.length + segment.length > MAX_ACP_MODEL_PROBE_MESSAGE_BYTES) {
            finish([]);
            return;
          }
          const line =
            buffer.length === 0
              ? segment.toString("utf8").trim()
              : Buffer.concat([buffer, segment]).toString("utf8").trim();
          buffer = Buffer.alloc(0);
          offset = newline + 1;
          newline = incoming.indexOf(0x0a, offset);
          if (!line) continue;
          let message: JsonRecord;
          try {
            message = JSON.parse(line) as JsonRecord;
          } catch {
            continue;
          }
          if (message.id === 0) {
            if (message.error) {
              finish([]);
              return;
            }
            sawInit = true;
            send({
              jsonrpc: "2.0",
              id: 1,
              method: "session/new",
              params: {
                cwd: options.sessionCwd ?? options.cwd ?? process.cwd(),
                mcpServers: [],
              },
            });
            continue;
          }
          if (message.id === 1) {
            if (message.error) {
              finish([]);
              return;
            }
            finish(parseAcpSessionModels(message.result));
            return;
          }
        }
        const remainder = incoming.subarray(offset);
        if (buffer.length + remainder.length > MAX_ACP_MODEL_PROBE_MESSAGE_BYTES) {
          finish([]);
          return;
        }
        if (remainder.length > 0) {
          buffer =
            buffer.length === 0 ? Buffer.from(remainder) : Buffer.concat([buffer, remainder]);
        }
      });

      child.stdout.on("end", () => {
        if (!sawInit) finish([]);
      });
    }).then((models) => {
      options.signal?.throwIfAborted();
      return models;
    });
  } catch (error) {
    releaseOwnedSlot();
    throw error;
  }
}
