import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_CLAUDE_MAJOR = 2;
const MAX_PROVIDER_LINE_BYTES = 1024 * 1024;

export type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_started"; toolCallId: string; name: string }
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export class ProviderProtocolError extends Error {}

type JsonRecord = Record<string, unknown>;

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

export function normalizeClaudeEvent(value: unknown): ProviderEvent[] {
  const event = record(value);
  if (!event || typeof event.type !== "string") {
    throw new ProviderProtocolError("Claude emitted a malformed event.");
  }

  if (event.type === "system" && event.subtype === "init") {
    return [{
      kind: "session_started",
      sessionId: requiredString(event.session_id, "session_id"),
      model: typeof event.model === "string" ? event.model : null,
    }];
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
          kind: "tool_started",
          toolCallId: requiredString(block.id, "tool id"),
          name: requiredString(block.name, "tool name"),
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

interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  cancelled: boolean;
  spawnFailed: boolean;
}

export class ClaudeCodeAdapter {
  readonly #active = new Map<string, ActiveRun>();

  constructor(private readonly executable = "claude") {}

  async start(
    worktree: string,
    prompt: string,
    resumeSessionId?: string,
  ): Promise<ProviderRun> {
    let version: { stdout: string };
    try {
      version = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch {
      throw new ProviderProtocolError("Claude Code is not installed or could not be started.");
    }
    assertSupportedClaudeVersion(version.stdout.trim());

    const id = randomUUID();
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
    ];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    const child = spawn(this.executable, args, {
      cwd: worktree,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const active: ActiveRun = { child, cancelled: false, spawnFailed: false };
    child.once("error", () => {
      active.spawnFailed = true;
    });
    child.stderr.resume();
    child.stdin.end(prompt);
    this.#active.set(id, active);

    return { id, events: this.#events(id, active) };
  }

  cancel(id: string): boolean {
    const active = this.#active.get(id);
    if (!active) return false;
    active.cancelled = true;
    active.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (active.child.exitCode === null) active.child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
    return true;
  }

  async *#events(id: string, active: ActiveRun): AsyncIterable<ProviderEvent> {
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
            yield* normalizeClaudeEvent(parsed);
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
      yield { kind: "failed", message: "Claude Code is not installed or could not be started." };
    } else if (!protocolFailed && code !== 0) {
      yield { kind: "failed", message: `Claude Code exited unexpectedly (${code ?? "signal"}).` };
    }
  }
}
