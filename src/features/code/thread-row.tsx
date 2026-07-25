import React from "react";
import type { ConversationSummary } from "../../types";
import { Icon } from "../../components/icon";
import { Spinner } from "../../components/ui";
import {
  branchFromWorktree,
  formatElapsed,
  isBlockingStatus,
  isUnread,
  providerLabel,
} from "./conversation-list";

/**
 * Three-line thread row (design-system.md):
 *   project · status|time
 *   title
 *   branch · provider
 */
export function ThreadRow({
  conversation,
  active,
  onOpen,
  onSettle,
  onOpenBeside,
  canOpenBeside,
  showSettle = true,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onSettle?: () => void;
  onOpenBeside?: () => void;
  canOpenBeside?: boolean;
  showSettle?: boolean;
}) {
  const status = conversation.status ?? "idle";
  const blocks = isBlockingStatus(status);
  const unread = isUnread(conversation);
  const topRight = blocks
    ? statusLabel(status)
    : formatElapsed(conversation.statusSince ?? conversation.updatedAt);
  const titleStrong = blocks || active;

  return (
    <div
      className={[
        "thread-row",
        active ? "active" : "",
        blocks ? "blocks" : "",
        unread ? "unread" : "",
      ].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        className="thread-row__main"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        aria-label={`${conversation.title}${blocks ? `, ${statusLabel(status)}` : ""}${unread ? ", unread" : ""}`}
      >
        <div className="thread-row__top">
          <span className="thread-row__project" title={conversation.projectName}>
            <Icon name="branch" />
            <span>{conversation.projectName ?? "Project"}</span>
          </span>
          <span className={`thread-row__meta ${blocks ? `status-${status}` : ""}`}>
            {status === "running" && <Spinner size="sm" label="Working" />}
            {status === "completed" && !blocks && <span className="thread-row__check" aria-hidden="true">✓</span>}
            {status !== "running" && (
              <span className={blocks ? `pill pill-${status}` : "thread-row__time"}>
                {topRight}
              </span>
            )}
          </span>
        </div>
        <div className={`thread-row__title ${titleStrong ? "strong" : ""}`}>
          {conversation.pinnedAt ? "◆ " : ""}
          {conversation.title}
          {unread && <i className="thread-row__unread" aria-hidden="true" />}
        </div>
        <div className="thread-row__bottom">
          <span className="thread-row__branch" title={conversation.worktree}>
            {branchFromWorktree(conversation.worktree)}
          </span>
          <span className="thread-row__provider">{providerLabel(conversation.provider)}</span>
        </div>
      </button>
      {showSettle && onSettle && (
        <button
          type="button"
          className="thread-row__settle"
          onClick={(event) => {
            event.stopPropagation();
            onSettle();
          }}
        >
          Settle
        </button>
      )}
      {onOpenBeside && (
        <button
          type="button"
          className="thread-row__beside"
          disabled={!canOpenBeside}
          onClick={(event) => {
            event.stopPropagation();
            onOpenBeside();
          }}
          aria-label={`Open ${conversation.title} beside`}
        >
          ▥
        </button>
      )}
    </div>
  );
}

function statusLabel(status: ConversationSummary["status"]): string {
  switch (status) {
    case "pending_approval":
      return "Approval";
    case "awaiting_input":
      return "Input";
    case "failed":
      return "Failed";
    case "running":
      return "Working";
    case "completed":
      return "Done";
    default:
      return "";
  }
}
