import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import { OverlayDialog } from "./overlay-dialog";

export const CREATE_WORKTREE_ACTION_COPY = {
  label: "Create worktree",
  detail: "Create an isolated managed checkout for conversation work",
} as const;

export function CommandPalette({
  open,
  onClose,
  onOpenRepository,
  onSearch,
  onPreferences,
  onProviderManagement,
  onConnections = () => undefined,
  onManageWorktrees,
  onAutomations,
  hasRepository = false,
}: {
  open: boolean;
  onClose: () => void;
  onOpenRepository: () => void;
  onSearch: () => void;
  onPreferences: () => void;
  onProviderManagement: () => void;
  onConnections?: () => void;
  onManageWorktrees: () => void;
  onAutomations: () => void;
  /** Worktree management requires an open repository; omit the action otherwise. */
  hasRepository?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const focusInput = () => inputRef.current?.focus();
    // Dialog focus trap may run after first paint; re-claim the search field.
    focusInput();
    const frame = window.requestAnimationFrame(focusInput);
    const timer = window.setTimeout(focusInput, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open]);

  const actions = useMemo(
    () =>
      [
        {
          label: "Add project",
          detail: "Register a local git repository once; new threads reuse it",
          run: onOpenRepository,
        },
        {
          label: "Search conversations",
          detail: "Search bounded local thread metadata",
          run: onSearch,
        },
        {
          label: "Appearance & keyboard",
          detail: "Theme, density, zoom, motion, and keybindings",
          run: onPreferences,
        },
        {
          label: "Provider management",
          detail: "Profiles, adapter package trust, and readiness diagnostics",
          run: onProviderManagement,
        },
        {
          label: "Connections",
          detail: "Pair devices and revoke local remote sessions",
          run: onConnections,
        },
        {
          label: "Automations",
          detail: "Schedule interval or cron prompts into existing conversations",
          run: onAutomations,
        },
        ...(hasRepository
          ? [
              {
                ...CREATE_WORKTREE_ACTION_COPY,
                run: onManageWorktrees,
              },
            ]
          : []),
      ].filter((action) => {
        const q = query.toLocaleLowerCase();
        return (
          action.label.toLocaleLowerCase().includes(q) ||
          action.detail.toLocaleLowerCase().includes(q)
        );
      }),
    [hasRepository, onAutomations, onConnections, onManageWorktrees, onOpenRepository, onPreferences, onProviderManagement, onSearch, query],
  );

  useEffect(() => {
    setActiveIndex((index) => {
      if (actions.length === 0) return 0;
      return Math.min(index, actions.length - 1);
    });
  }, [actions.length]);

  if (!open) return null;

  const runAction = (index: number) => {
    const action = actions[index];
    if (!action) return;
    onClose();
    action.run();
  };

  const onPaletteKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((index) => (index + 1) % actions.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((index) => (index - 1 + actions.length) % actions.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runAction(activeIndex);
    }
  };

  return (
    <OverlayDialog title="Command palette" onClose={onClose}>
      <div className="command-palette-body" onKeyDown={onPaletteKeyDown}>
        <label className="quick-search">
          <Icon name="search" />
          <input
            ref={inputRef}
            id="command-palette-query"
            name="command-palette-query"
            data-dialog-initial-focus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search available actions"
            aria-label="Search available actions"
            aria-controls="command-palette-results"
            aria-activedescendant={
              actions[activeIndex] ? `command-palette-action-${activeIndex}` : undefined
            }
          />
        </label>
        <div
          className="quick-results"
          id="command-palette-results"
          role="listbox"
          aria-label="Available actions"
        >
          {actions.length === 0 && <p>No matching actions.</p>}
          {actions.map((action, index) => (
            <button
              key={action.label}
              type="button"
              id={`command-palette-action-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              aria-label={`${action.label}. ${action.detail}`}
              title={`${action.label} — ${action.detail}`}
              className={index === activeIndex ? "active" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runAction(index)}
            >
              <strong title={action.label}>{action.label}</strong>
              <small title={action.detail}>{action.detail}</small>
            </button>
          ))}
        </div>
      </div>
    </OverlayDialog>
  );
}
