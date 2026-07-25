import React from "react";
import type { ConversationSummary } from "../../types";
import {
  branchFromWorktree,
  formatElapsed,
  isBlockingStatus,
  isUnread,
  providerLabel,
} from "./conversation-list";

/** Three-line row matching workbench-mock.html class structure. */
export function ThreadRow({
  conversation,
  active,
  onOpen,
  onSettle,
  showSettle = true,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onSettle?: () => void;
  showSettle?: boolean;
}) {
  const status = conversation.status ?? "idle";
  const blocks = isBlockingStatus(status);
  const unread = isUnread(conversation);
  const elapsed = formatElapsed(conversation.statusSince ?? conversation.updatedAt);
  const monogram = providerMonogram(conversation.provider);

  return (
    <div
      className={["row", active ? "active" : "", blocks ? "blocks" : "", unread ? "unread" : ""]
        .filter(Boolean)
        .join(" ")}
      role="listitem"
    >
      <button type="button" className="row-main" onClick={onOpen} aria-current={active ? "true" : undefined}>
        <div className="rp">
          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="pn">{conversation.projectName ?? "project"}</span>
          {status === "pending_approval" && <span className="pill approval">Approval</span>}
          {status === "awaiting_input" && <span className="pill input">Input</span>}
          {status === "failed" && <span className="pill failed">Failed</span>}
          {status === "running" && <span className="spin" aria-label="Working" />}
          {status === "completed" && !blocks && <span className="mark" aria-hidden="true">✓</span>}
        </div>
        <div className="rt">
          {conversation.pinnedAt ? "◆ " : ""}
          {conversation.title}
        </div>
        <div className="rb">
          <span className="br">{branchFromWorktree(conversation.worktree)}</span>
          <span className="pv" title={providerLabel(conversation.provider)}>{monogram}</span>
          <span className="tm">{elapsed}</span>
        </div>
      </button>
      {showSettle && onSettle && (
        <button
          type="button"
          className="settle"
          onClick={(event) => {
            event.stopPropagation();
            onSettle();
          }}
        >
          Settle
        </button>
      )}
    </div>
  );
}

function providerMonogram(provider: string): string {
  if (provider === "claude-code") return "CC";
  if (provider === "codex-cli") return "CX";
  if (provider.startsWith("adapter:")) {
    const id = provider.slice("adapter:".length).split("@")[0] ?? "AD";
    return id.slice(0, 2).toUpperCase();
  }
  return provider.slice(0, 2).toUpperCase();
}
