/**
 * Discover and apply ACP session models (Kiro, Grok Build, OpenCode, …).
 *
 * Agents expose models on session/new as:
 *   { models: { currentModelId, availableModels: [{ modelId, name, ... }] } }
 * Selection uses session/set_model { sessionId, modelId }.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
    ? value as JsonRecord
    : null;
}

const EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];

function parseEffort(value: unknown): ReasoningEffort | null {
  return value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh"
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
  const preferred = parseEffort(meta?.reasoningEffort) ?? list.find((effort) => {
    if (!Array.isArray(raw)) return false;
    return raw.some((entry) => {
      const row = record(entry);
      return row?.default === true && parseEffort(row?.value ?? row?.id) === effort;
    });
  }) ?? list[0]!;
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
  const available = Array.isArray(modelsState?.availableModels)
    ? modelsState.availableModels
    : [];
  const currentId = typeof modelsState?.currentModelId === "string"
    ? modelsState.currentModelId
    : null;

  const fromModelsField = available.flatMap((entry): AcpDiscoveredModel[] => {
    const row = record(entry);
    if (!row) return [];
    const id = typeof row.modelId === "string" && row.modelId
      ? row.modelId
      : typeof row.id === "string" && row.id
      ? row.id
      : null;
    if (!id) return [];
    const meta = record(row._meta);
    const efforts = effortsFromMeta(meta);
    return [{
      id,
      displayName: typeof row.name === "string" && row.name ? row.name : id,
      isDefault: currentId === id,
      ...efforts,
    }];
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
      return [{
        id: row.value,
        displayName: typeof row.name === "string" && row.name ? row.name : row.value,
        isDefault: current === row.value,
        reasoningEfforts: [],
        defaultReasoningEffort: "medium",
      }];
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
export async function probeAcpModels(options: {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionCwd?: string;
  timeoutMs?: number;
}): Promise<AcpDiscoveredModel[]> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const source = options.environment ?? process.env;
  const env: NodeJS.ProcessEnv = { ...source };

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (models: AcpDiscoveredModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (child.exitCode === null) child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(models);
    };

    const child: ChildProcessWithoutNullStreams = spawn(
      options.executable,
      options.arguments,
      {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => finish([]));

    const timer = setTimeout(() => finish([]), timeoutMs);
    timer.unref();

    const decoder = new StringDecoder("utf8");
    let buffer = "";
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
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
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
    });

    child.stdout.on("end", () => {
      if (!sawInit) finish([]);
    });
  });
}
