import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/icon";
import { OverlayDialog } from "./overlay-dialog";

export function CommandPalette({
  open,
  onClose,
  onOpenRepository,
  onSearch,
  onPreferences,
  onProviderSettings,
  onAdapterSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenRepository: () => void;
  onSearch: () => void;
  onPreferences: () => void;
  onProviderSettings: () => void;
  onAdapterSettings: () => void;
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
          label: "Open repository",
          detail: "Choose an explicit local repository root",
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
          label: "Provider settings",
          detail: "Configure local Claude profiles",
          run: onProviderSettings,
        },
        {
          label: "Provider adapters",
          detail: "Inspect and administer declarative ACP adapters",
          run: onAdapterSettings,
        },
      ].filter((action) =>
        action.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
      ),
    [onAdapterSettings, onOpenRepository, onPreferences, onProviderSettings, onSearch, query],
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
            data-dialog-initial-focus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search available actions"
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
              className={index === activeIndex ? "active" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runAction(index)}
            >
              <strong>{action.label}</strong>
              <small>{action.detail}</small>
            </button>
          ))}
        </div>
      </div>
    </OverlayDialog>
  );
}
