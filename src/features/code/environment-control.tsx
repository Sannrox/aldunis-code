import React, { useEffect, useRef, useState } from "react";
import type { RepositoryMetadata } from "../../types";
import { Icon } from "../../components/icon";
import type { ChangesPanelMode } from "../changes/changes-panel";

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
        title={repository ? "Open environment actions" : "Open a repository to manage its environment"}
        aria-label={repository ? `Environment, ${pane} pane` : `Environment unavailable: open a repository, ${pane} pane`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active}
        onKeyDown={onKeyDown}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="route" />
        <span className="environment-trigger__label">Environment</span>
        <span className={`workspace-panel-count ${changesError ? "error" : ""}`}>
          {changesLoading ? "…" : changesCount}
        </span>
        <span className="environment-trigger__chevron" aria-hidden="true"><Icon name="chevron" /></span>
      </button>
      {open && (
        <div
          className="environment-menu"
          role="menu"
          aria-label={`Environment actions, ${pane} pane`}
        >
          <div className="environment-menu__header">
            <div>
              <span className="environment-menu__eyebrow">Environment</span>
              <strong title={repository?.selectedWorktree}>{worktreeLabel}</strong>
            </div>
            <span className="environment-menu__scope">{repository?.name ?? "Repository required"}</span>
          </div>
          <div className="environment-menu__divider" />
          <EnvironmentMenuRow
            icon="diff"
            label="Changes"
            detail={changesDetail}
            trailing={(
              <span className="environment-menu__delta" aria-label={`${additions} additions, ${deletions} deletions`}>
                <b>+{additions}</b> <b>−{deletions}</b>
              </span>
            )}
            onClick={() => run(() => onOpenChanges("review"))}
          />
          <EnvironmentMenuRow
            icon="branch"
            label="Worktree"
            detail={worktreeLabel}
            trailing={<Icon name="chevron" />}
            onClick={() => run(onManageWorktrees)}
          />
          <EnvironmentMenuRow
            icon="branch"
            label="Create branch"
            detail="Open a new isolated worktree"
            onClick={() => run(onManageWorktrees)}
          />
          <EnvironmentMenuRow
            icon="rocket"
            label="Commit or push"
            detail={canDeliver ? "Review and prepare delivery" : "No changes to deliver yet"}
            disabled={!canDeliver}
            onClick={() => run(() => onOpenChanges("deliver"))}
          />
        </div>
      )}
    </div>
  );
}
