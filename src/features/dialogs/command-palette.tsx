import React, { FormEvent, useEffect, useRef, useState } from "react";
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
  if (!open) return null;
  const actions = [
    { label: "Open repository", detail: "Choose an explicit local repository root", run: onOpenRepository, available: true },
    { label: "Search conversations", detail: "Search bounded local thread metadata", run: onSearch, available: true },
    { label: "Appearance & keyboard", detail: "Theme, density, zoom, motion, and keybindings", run: onPreferences, available: true },
    { label: "Provider settings", detail: "Configure local Claude profiles", run: onProviderSettings, available: true },
    { label: "Provider adapters", detail: "Inspect and administer declarative ACP adapters", run: onAdapterSettings, available: true },
  ].filter((action) => action.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <OverlayDialog title="Command palette" onClose={onClose}>
      <label className="quick-search"><Icon name="search" /><input data-dialog-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search available actions" /></label>
      <div className="quick-results">{actions.map((action) => <button key={action.label} onClick={() => { onClose(); action.run(); }}><strong>{action.label}</strong><small>{action.detail}</small></button>)}</div>
    </OverlayDialog>
  );
}


