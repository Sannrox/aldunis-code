import React, { useState } from "react";
import { Icon } from "../../components/icon";
import {
  humanizeToolName,
  shortToolCallId,
  toolIconName,
  visibleToolRows,
  type ToolRow,
} from "../../lib/tool-presentation";

function toolStatusLabel(status: ToolRow["status"]): string {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Completed";
}

function toolStatusMark(status: ToolRow["status"]): React.ReactNode {
  if (status === "running") {
    return (
      <span className="tool-log-status-spinner" aria-hidden="true">
        <span />
      </span>
    );
  }
  if (status === "failed") return <span aria-hidden="true">!</span>;
  if (status === "cancelled") return <span aria-hidden="true">–</span>;
  return <span aria-hidden="true">✓</span>;
}

export function ToolActivity({
  rows,
  providerLabel,
  groupId,
}: {
  rows: ToolRow[];
  providerLabel: string;
  groupId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;

  const collapsedRows = visibleToolRows(rows, false);
  const collapsedIds = new Set(collapsedRows.map((row) => row.toolCallId));
  const hiddenRows = rows.filter((row) => !collapsedIds.has(row.toolCallId));
  const hiddenCount = hiddenRows.length;
  const displayedRows = expanded ? rows : collapsedRows;
  const failedCount = hiddenRows.filter((row) => row.status === "failed").length;
  const groupLabel = `${rows.length} ${rows.length === 1 ? "tool call" : "tool calls"}`;
  const toggleLabel = expanded
    ? "Show fewer tool calls"
    : `+${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}${
        failedCount > 0 ? ` · ${failedCount} failed` : ""
      }`;

  return (
    <section className="tool-log" aria-label={`${providerLabel} tool activity: ${groupLabel}`}>
      <div className="tool-log-list" id={groupId} role="list">
        {displayedRows.map((row) => {
          const label = humanizeToolName(row.name);
          const status = toolStatusLabel(row.status);
          const callId = shortToolCallId(row.toolCallId);
          return (
            <div
              className={`tool-log-row tool-log-row-${row.status}`}
              key={row.toolCallId}
              role="listitem"
              aria-label={`${status} ${label} ${callId}`}
              title={`${label} · tool call ${callId}`}
            >
              <span className="tool-log-icon" aria-hidden="true">
                <Icon name={toolIconName(row.name)} />
              </span>
              <span className="tool-log-name">{label}</span>
              <span className={`tool-log-status tool-log-status-${row.status}`}>
                {toolStatusMark(row.status)}
              </span>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="tool-log-toggle"
          aria-controls={groupId}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span
            className={`tool-log-toggle-chevron ${expanded ? "is-expanded" : ""}`}
            aria-hidden="true"
          >
            ›
          </span>
          <span>{toggleLabel}</span>
        </button>
      )}
    </section>
  );
}
