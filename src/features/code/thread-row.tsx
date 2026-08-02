import React, { useEffect, useId, useRef, useState } from "react";
import type { ConversationSummary } from "../../types";
import type { ProviderId } from "../../types";
import { providerAvatarInitials } from "../../lib/provider-readiness";
import {
  branchFromWorktree,
  formatElapsed,
  isBlockingStatus,
  isUnread,
  providerLabel,
} from "./conversation-list";

export type ConversationLifecycleAction = "rename" | "pin" | "archive" | "restore" | "delete";

/** Three-line row matching workbench-mock.html class structure. */
export function ThreadRow({
  conversation,
  active,
  onOpen,
  onSettle,
  onOpenBeside,
  onAction,
  showSettle = true,
  showBeside = false,
  archivedView = false,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onSettle?: () => void;
  onOpenBeside?: () => void;
  onAction?: (action: ConversationLifecycleAction) => void;
  showSettle?: boolean;
  /** Include "Beside" in the row action menu to open this thread in a split secondary pane. */
  showBeside?: boolean;
  /** When true, show restore instead of settle/archive. */
  archivedView?: boolean;
}) {
  const status = conversation.status ?? "idle";
  const blocks = isBlockingStatus(status);
  const unread = isUnread(conversation);
  const elapsed = formatElapsed(conversation.statusSince ?? conversation.updatedAt);
  const listLabel = providerLabel(conversation.provider);
  const monogram = providerAvatarInitials(conversation.provider as ProviderId, listLabel);
  const branch = branchFromWorktree(conversation.worktree);
  const statusLabel =
    status === "pending_approval" ? "Approval needed"
    : status === "awaiting_input" ? "Awaiting input"
    : status === "failed" ? "Failed"
    : status === "running" ? "Working"
    : status === "completed" ? "Completed"
    : null;
  const openLabel = [
    conversation.projectName ?? "project",
    statusLabel,
    unread ? "Unread" : null,
    conversation.pinnedAt ? "Pinned" : null,
    conversation.title,
    branch,
    listLabel,
    elapsed,
  ].filter(Boolean).join(", ");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const hasMenuActions = Boolean(onAction || (showBeside && onOpenBeside));

  useEffect(() => {
    if (!menuOpen) return;
    const root = menuRef.current;
    if (!root) return;
    const items = () => [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const frame = window.requestAnimationFrame(() => {
      items()[0]?.focus();
    });
    const onPointer = (event: MouseEvent) => {
      if (!root.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        root.querySelector<HTMLElement>(".row-more")?.focus();
        return;
      }
      const list = items();
      if (!list.length) return;
      const currentIndex = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = currentIndex < 0 ? 0 : Math.min(list.length - 1, currentIndex + 1);
        list[next]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = currentIndex < 0 ? list.length - 1 : Math.max(0, currentIndex - 1);
        list[next]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      className={["row", active ? "active" : "", blocks ? "blocks" : "", unread ? "unread" : ""]
        .filter(Boolean)
        .join(" ")}
      role="listitem"
    >
      <button
        type="button"
        className="row-main"
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        aria-label={openLabel}
      >
        <div className="rp">
          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span className="pn" title={conversation.projectName ?? "project"}>
            {conversation.projectName ?? "project"}
          </span>
          {status === "pending_approval" && <span className="pill approval">Approval</span>}
          {status === "awaiting_input" && <span className="pill input">Input</span>}
          {status === "failed" && <span className="pill failed">Failed</span>}
          {status === "running" && <span className="spin" aria-label="Working" />}
          {status === "completed" && !blocks && <span className="mark" aria-hidden="true">✓</span>}
        </div>
        <div className="rt" title={conversation.title}>
          {conversation.pinnedAt ? "◆ " : ""}
          {conversation.title}
        </div>
        <div className="rb">
          <span className="br" title={branch}>{branch}</span>
          {/* Monogram alone is cryptic when several threads share a title (dual-pane stress). */}
          <span className="pv" title={listLabel} aria-hidden="true">{monogram}</span>
          <span className="pl" title={listLabel}>{listLabel}</span>
          <span className="tm" title={elapsed}>{elapsed}</span>
        </div>
      </button>
      <div className="row-actions">
        {showSettle && onSettle && (
          <button
            type="button"
            className="settle"
            aria-label={`Settle "${conversation.title}" · ${listLabel}`}
            onClick={(event) => {
              event.stopPropagation();
              onSettle();
            }}
          >
            Settle
          </button>
        )}
        {hasMenuActions && (
          <div className="row-menu" ref={menuRef}>
            <button
              type="button"
              className="row-more"
              aria-label={`More actions for "${conversation.title}" · ${listLabel}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                id={menuId}
                className="row-menu-pop"
                role="menu"
                aria-label={`Actions for ${conversation.title} · ${listLabel}`}
              >
                {showBeside && onOpenBeside && (
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Open "${conversation.title}" · ${listLabel} beside`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpen(false);
                      onOpenBeside();
                    }}
                  >
                    Beside
                  </button>
                )}
                {onAction && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                        onAction("rename");
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                        onAction("pin");
                      }}
                    >
                      {conversation.pinnedAt ? "Unpin" : "Pin"}
                    </button>
                    {archivedView ? (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpen(false);
                          onAction("restore");
                        }}
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpen(false);
                          onAction("archive");
                        }}
                      >
                        Archive
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                        onAction("delete");
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
