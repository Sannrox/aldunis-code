import React, { useEffect, useRef, useState } from "react";
import type { RepositoryMetadata } from "../../types";
import { Icon } from "../../components/icon";
import type { ChangesPanelMode } from "../changes/changes-panel";

function formatChangeCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(absolute >= 10_000_000_000 ? 0 : 1)}B`;
  }
  if (absolute >= 1_000_000) {
    const rounded = Number((absolute / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1));
    if (rounded >= 1_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    return `${value < 0 ? "-" : ""}${rounded}M`;
  }
  if (absolute >= 1_000) {
    const rounded = Number((absolute / 1_000).toFixed(absolute >= 10_000 ? 0 : 1));
    if (rounded >= 1_000) return `${(value / 1_000_000).toFixed(1)}M`;
    return `${value < 0 ? "-" : ""}${rounded}k`;
  }
  return String(value);
}

export type EnvironmentControlProps = {
  repository: RepositoryMetadata | null;
  pane: "primary" | "secondary";
  changesCount: number;
  additions: number;
  deletions: number;
  changesLoading: boolean;
  changesError: string | null;
  canDeliver: boolean;
  active: boolean;
  tabIndex: number;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
  onOpenChanges: (mode: ChangesPanelMode) => void;
  onManageWorktrees: () => void;
};

function EnvironmentMenuRow({
  icon,
  label,
  detail,
  trailing,
  disabled = false,
  onClick,
}: {
  icon: "branch" | "diff" | "rocket";
  label: string;
  detail: string;
  trailing?: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="environment-menu-row"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="environment-menu-row__icon" aria-hidden="true"><Icon name={icon} /></span>
      <span className="environment-menu-row__copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      {trailing && <span className="environment-menu-row__trailing">{trailing}</span>}
    </button>
  );
}

function EnvironmentMenuGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="environment-menu-group" role="group" aria-label={label}>
      <div className="environment-menu-group__label">{label}</div>
      {children}
    </div>
  );
}

export function EnvironmentControl({
  repository,
  pane,
  changesCount,
  additions,
  deletions,
  changesLoading,
  changesError,
  canDeliver,
  active,
  tabIndex,
  triggerRef,
  onKeyDown,
  onOpenChanges,
  onManageWorktrees,
}: EnvironmentControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const worktree = repository?.worktrees.find((item) => item.path === repository.selectedWorktree);
  const worktreeLabel = worktree?.branch ?? (repository ? "Detached worktree" : "No repository selected");
  const changesDetail = changesLoading
    ? "Inspecting active worktree…"
    : changesError
      ? "Could not inspect active worktree"
      : changesCount === 0
        ? "Active worktree is clean"
        : `${changesCount} file${changesCount === 1 ? "" : "s"} changed`;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  const run = (action: () => void) => {
    close();
    action();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className="environment-control" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-ghost btn-sm environment-trigger ${active ? "on" : ""}`}
        data-workspace-panel="changes"
        disabled={!repository}
        tabIndex={tabIndex}
        title={repository ? "Review changes and workspace actions" : "Choose a project to review changes"}
        aria-label={repository ? `Review changes and workspace actions, ${pane} pane` : `Review unavailable: choose a project, ${pane} pane`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="route" />
        <span className="environment-trigger__label">Review</span>
        <span className={`workspace-panel-count ${changesError ? "error" : ""}`}>
          {changesLoading ? "…" : changesCount}
        </span>
        <span className="environment-trigger__chevron" aria-hidden="true"><Icon name="chevron" /></span>
      </button>
      {open && (
        <div
          className="environment-menu"
          role="menu"
          aria-label={`Review changes and workspace actions, ${pane} pane`}
        >
          <div className="environment-menu__header">
            <div>
              <span className="environment-menu__eyebrow">Review &amp; deliver</span>
              <strong title={repository?.selectedWorktree}>{worktreeLabel}</strong>
            </div>
            <span className="environment-menu__scope">{repository?.name ?? "Repository required"}</span>
          </div>
          <div className="environment-menu__divider" />
          <EnvironmentMenuGroup label="Changes">
            <EnvironmentMenuRow
              icon="diff"
              label="Review changes"
              detail={changesDetail}
              trailing={(
                <span
                  className="environment-menu__delta"
                  aria-label={`${additions} additions, ${deletions} deletions`}
                  title={`${additions} additions, ${deletions} deletions`}
                >
                  <b>+{formatChangeCount(additions)}</b> <b>−{formatChangeCount(deletions)}</b>
                </span>
              )}
              onClick={() => run(() => onOpenChanges("review"))}
            />
          </EnvironmentMenuGroup>
          <EnvironmentMenuGroup label="Workspace">
            <EnvironmentMenuRow
              icon="branch"
              label="Manage worktree"
              detail={worktreeLabel}
              trailing={<Icon name="chevron" />}
              onClick={() => run(onManageWorktrees)}
            />
            <EnvironmentMenuRow
              icon="branch"
              label="Create isolated worktree"
              detail="Start a new branch from this repository"
              onClick={() => run(onManageWorktrees)}
            />
          </EnvironmentMenuGroup>
          <EnvironmentMenuGroup label="Delivery">
            <EnvironmentMenuRow
              icon="rocket"
              label="Prepare delivery"
              detail={canDeliver ? "Review changes before commit or push" : "No changes ready to deliver"}
              disabled={!canDeliver}
              onClick={() => run(() => onOpenChanges("deliver"))}
            />
          </EnvironmentMenuGroup>
        </div>
      )}
    </div>
  );
}
