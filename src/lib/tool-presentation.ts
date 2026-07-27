import type { ProviderEvent } from "../types";

export type ToolRowStatus = "running" | "done" | "failed";

export interface ToolRow {
  toolCallId: string;
  name: string;
  status: ToolRowStatus;
}

/** Compact id for tool chrome — not the useless first 8 chars of "call-…". */
export function shortToolCallId(id: string): string {
  const stripped = id.replace(/^call[-_]?/i, "");
  // ACP batches share a UUID prefix with a trailing index: call-<uuid>-0, -1, …
  const tail = stripped.match(/-(\d+)$/);
  const hex = stripped.match(/[a-f0-9]{6,}/i);
  if (hex && tail) return `${hex[0].slice(0, 6)}-${tail[1]}`;
  if (hex) return hex[0].slice(0, 8);
  return (stripped || id).slice(0, 8);
}

/**
 * Collapse tool_started / tool_finished events into one row per call id,
 * preserving start order and carrying the tool name onto the finished state.
 */
export function presentToolRows(
  events: Array<Extract<ProviderEvent, { kind: "tool_started" | "tool_finished" }>>,
): ToolRow[] {
  const names = new Map<string, string>();
  const order: string[] = [];
  const finished = new Map<string, boolean>();
  for (const event of events) {
    if (event.kind === "tool_started") {
      if (!names.has(event.toolCallId)) order.push(event.toolCallId);
      names.set(event.toolCallId, event.name.trim() || "Provider tool");
      continue;
    }
    if (!names.has(event.toolCallId) && !finished.has(event.toolCallId)) {
      order.push(event.toolCallId);
    }
    finished.set(event.toolCallId, event.failed);
  }
  return order.map((toolCallId) => {
    const failed = finished.get(toolCallId);
    return {
      toolCallId,
      name: names.get(toolCallId) ?? "Provider tool",
      status: failed === undefined ? "running" : failed ? "failed" : "done",
    };
  });
}
