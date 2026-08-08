import type { IconName, ProviderEvent } from "../types";

export type ToolRowStatus = "running" | "done" | "failed" | "cancelled";

export interface ToolRow {
  toolCallId: string;
  name: string;
  status: ToolRowStatus;
}

/** Keep the transcript readable when providers expose implementation names. */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  browser_click: "Browser click",
  browser_snapshot: "Browser snapshot",
  browser_type: "Browser type",
  edit_file: "Edit file",
  get_command_or_subagent_output: "Get command output",
  glob: "Find files",
  grep: "Search code",
  list_dir: "List directory",
  read_file: "Read file",
  run_terminal_command: "Run terminal command",
  search_replace: "Search & replace",
  write_file: "Write file",
};

function humanizeToolWords(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) =>
      index === 0
        ? `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`
        : word.toLowerCase(),
    )
    .join(" ");
}

/** Convert provider tool names into labels that read like actions. */
export function humanizeToolName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) return "Tool";
  const exact = TOOL_DISPLAY_NAMES[normalized.toLowerCase()];
  if (exact) return exact;

  const prefixed = normalized.match(/^(mcp|subagent)\s+(.+)$/i);
  if (prefixed) {
    const prefix = prefixed[1].toLowerCase() === "mcp" ? "MCP" : "Subagent";
    return `${prefix} · ${humanizeToolWords(prefixed[2])}`;
  }
  return humanizeToolWords(normalized);
}

/** Choose a quiet, semantic icon family without exposing provider internals. */
export function toolIconName(
  name: string,
): Extract<IconName, "code" | "diff" | "route" | "search" | "spark"> {
  const normalized = name.toLowerCase();
  if (/(?:agent|subagent|spawn)/.test(normalized)) return "route";
  if (/(?:write|edit|replace|delete|move|change)/.test(normalized)) return "diff";
  if (/(?:command|terminal|shell|run)/.test(normalized)) return "code";
  if (/(?:read|grep|glob|search|list|find|snapshot|view)/.test(normalized)) return "search";
  return "spark";
}

/** Keep long tool bursts compact while leaving the newest action visible. */
export const MAX_VISIBLE_TOOL_ROWS = 1;

export function visibleToolRows(rows: readonly ToolRow[], expanded: boolean): ToolRow[] {
  if (expanded || rows.length <= MAX_VISIBLE_TOOL_ROWS) return [...rows];
  const runningIds = new Set(
    rows.filter((row) => row.status === "running").map((row) => row.toolCallId),
  );
  const newestId = rows.at(-1)?.toolCallId;
  return rows.filter((row) => row.toolCallId === newestId || runningIds.has(row.toolCallId));
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
      names.set(event.toolCallId, event.name.trim() || "Tool");
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
      name: names.get(toolCallId) ?? "Tool",
      status: failed === undefined ? "running" : failed ? "failed" : "done",
    };
  });
}
