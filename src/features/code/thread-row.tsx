import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BranchPrStatus, ConversationSummary, ProviderId } from "../../types";
import { providerAvatarInitials } from "../../lib/provider-readiness";
import {
  branchFromWorktree,
  formatElapsed,
  isBlockingStatus,
  isUnread,
  providerLabel,
} from "./conversation-list";
import { WORKSPACE_MODE_COPY } from "../../lib/workspace-mode";
import {
  canSettleConversation,
  canSnooze,
  resolveSnoozePresets,
  type SnoozePreset,
} from "../../lib/thread-snooze";
import { prStatusAriaLabel, prStatusLabel } from "../../lib/branch-pr-status";

export type ConversationLifecycleAction = "rename" | "pin" | "archive" | "restore" | "delete";

/** Three-line row matching workbench-mock.html class structure. */
export function ThreadRow({
  conversation,
  active,
  onOpen,
  onSettle,
  onSnooze,
  onOpenBeside,
  onAction,
  prStatus = null,
  showSettle = true,
  showBeside = false,
  archivedView = false,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onSettle?: () => void;
  onSnooze?: (preset: SnoozePreset) => void;
  onOpenBeside?: () => void;
  onAction?: (action: ConversationLifecycleAction, returnFocus: HTMLElement | null) => void;
  /** Live GitHub PR for this worktree branch, if known. */
  prStatus?: BranchPrStatus | null;
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
  const prLabel = prStatus ? prStatusLabel(prStatus) : null;
  const workspaceLabel = WORKSPACE_MODE_COPY[conversation.workspaceMode ?? "shared"].shortLabel;
  const statusLabel =
    status === "pending_approval"
      ? "Approval needed"
      : status === "awaiting_input"
        ? "Awaiting input"
        : status === "failed"
          ? "Failed"
          : status === "running"
            ? "Working"
            : status === "completed"
              ? "Completed"
              : null;
  const openLabel = [
    conversation.projectName ?? "project",
    statusLabel,
    unread ? "Unread" : null,
    conversation.pinnedAt ? "Pinned" : null,
    conversation.title,
    branch,
    prLabel,
    workspaceLabel,
    listLabel,
    elapsed,
  ]
    .filter(Boolean)
    .join(", ");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPopupRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const snoozePresets = useMemo(
    () => (menuOpen && onSnooze ? resolveSnoozePresets() : []),
    [menuOpen, onSnooze],
  );
  const snoozeAllowed = Boolean(onSnooze) && canSnooze(conversation) && !archivedView;
  const settleAllowed =
    Boolean(showSettle && onSettle) && canSettleConversation(conversation) && !archivedView;
  const lifecycleMutationAllowed = canSettleConversation(conversation);
  const hasMenuActions = Boolean(
    onAction || (showBeside && onOpenBeside) || snoozeAllowed || prStatus,
  );

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = menuTriggerRef.current;
    const popup = menuPopupRef.current;
    if (!trigger || !popup) return;

    const updatePosition = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const popupWidth = popup.offsetWidth || popupRect.width;
      const popupHeight = popup.offsetHeight || popupRect.height;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const edge = 8;
      const gap = 4;
      const scrollContainer = trigger.closest<HTMLElement>(".list");
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const visibleTop = Math.max(0, scrollRect?.top ?? 0);
      const visibleBottom = Math.min(viewportHeight, scrollRect?.bottom ?? viewportHeight);
      const hasTriggerGeometry = triggerRect.width > 0 || triggerRect.height > 0;
      if (
        hasTriggerGeometry &&
        (triggerRect.bottom <= visibleTop || triggerRect.top >= visibleBottom)
      ) {
        setMenuOpen(false);
        return;
      }
      const maxLeft = Math.max(edge, viewportWidth - popupWidth - edge);
      const left = Math.max(edge, Math.min(triggerRect.right - popupWidth, maxLeft));
      const belowTop = triggerRect.bottom + gap;
      const aboveTop = triggerRect.top - popupHeight - gap;
      const maxTop = Math.max(edge, viewportHeight - popupHeight - edge);
      const top =
        popupHeight > viewportHeight - edge * 2
          ? edge
          : popupHeight <= viewportHeight - triggerRect.bottom - edge - gap
            ? Math.min(belowTop, maxTop)
            : Math.max(edge, Math.min(aboveTop, maxTop));

      setMenuPosition({ top, left });
    };

    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    // Capture scroll events from the sidebar's nested scroll container as well
    // as the document, keeping the fixed menu attached to its trigger.
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const root = menuRef.current;
    if (!root) return;
    const items = () => [
      ...(menuPopupRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    ];
    const frame = window.requestAnimationFrame(() => {
      items()[0]?.focus();
    });
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!root.contains(target) && !menuPopupRef.current?.contains(target)) setMenuOpen(false);
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
          {status === "completed" && !blocks && (
            <span className="mark" aria-hidden="true">
              ✓
            </span>
          )}
        </div>
        <div className="rt" title={conversation.title}>
          {conversation.pinnedAt ? "◆ " : ""}
          {conversation.title}
        </div>
        <div className="rb">
          <span className="br" title={branch}>
            {branch}
          </span>
          {prStatus && prLabel && (
            <span
              className={`pr-status pr-status--${prStatus.state}`}
              title={prStatusAriaLabel(prStatus)}
            >
              {prLabel}
            </span>
          )}
          {/* Monogram alone is cryptic when several threads share a title (dual-pane stress). */}
          <span className="pv" title={listLabel} aria-hidden="true">
            {monogram}
          </span>
          <span className="pl" title={listLabel}>
            {listLabel}
          </span>
          <span className="pl" title={`Workspace: ${workspaceLabel}`}>
            {workspaceLabel}
          </span>
          <span className="tm" title={elapsed}>
            {elapsed}
          </span>
        </div>
      </button>
      <div className="row-actions">
        {settleAllowed && (
          <button
            type="button"
            className="settle"
            aria-label={`Settle "${conversation.title}" · ${listLabel}`}
            onClick={(event) => {
              event.stopPropagation();
              onSettle?.();
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
              ref={menuTriggerRef}
              aria-label={`More actions for "${conversation.title}" · ${listLabel}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setMenuPosition(null);
                setMenuOpen((open) => !open);
              }}
            >
              ⋮
            </button>
            {menuOpen &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  id={menuId}
                  ref={menuPopupRef}
                  className="row-menu-pop row-menu-pop--portal"
                  role="menu"
                  aria-label={`Actions for ${conversation.title} · ${listLabel}`}
                  style={
                    menuPosition
                      ? { top: menuPosition.top, left: menuPosition.left }
                      : { visibility: "hidden" }
                  }
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
                  {prStatus && (
                    <a
                      role="menuitem"
                      className="row-menu-pr"
                      href={prStatus.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
                      }}
                    >
                      Open {prStatusLabel(prStatus)}
                    </a>
                  )}
                  {onAction && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuOpen(false);
                          onAction("rename", menuTriggerRef.current);
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
                          onAction("pin", menuTriggerRef.current);
                        }}
                      >
                        {conversation.pinnedAt ? "Unpin" : "Pin"}
                      </button>
                      {snoozeAllowed &&
                        onSnooze &&
                        snoozePresets.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            role="menuitem"
                            className="row-menu-snooze"
                            aria-label={`Snooze · ${preset.label} · ${preset.whenLabel}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuOpen(false);
                              onSnooze(preset);
                            }}
                          >
                            <span>Snooze · {preset.label}</span>
                            <span className="row-menu-snooze__when">{preset.whenLabel}</span>
                          </button>
                        ))}
                      {archivedView ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpen(false);
                            onAction("restore", menuTriggerRef.current);
                          }}
                        >
                          Restore
                        </button>
                      ) : lifecycleMutationAllowed ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpen(false);
                            onAction("archive", menuTriggerRef.current);
                          }}
                        >
                          Archive
                        </button>
                      ) : null}
                      {lifecycleMutationAllowed && (
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOpen(false);
                            onAction("delete", menuTriggerRef.current);
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>,
                document.body,
              )}
          </div>
        )}
      </div>
    </div>
  );
}
