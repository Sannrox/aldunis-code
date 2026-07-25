import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { Preferences } from "../../preferences";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

export function PreferencesDialog({
  open,
  preferences,
  recovered,
  onClose,
  onSave,
}: {
  open: boolean;
  preferences: Preferences;
  recovered: boolean;
  onClose: () => void;
  onSave: (preferences: Preferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState(preferences);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setDraft(preferences); }, [open, preferences]);
  if (!open) return null;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <OverlayDialog title="Appearance & keyboard" onClose={onClose}>
      {recovered && <p className="recovery-note" role="status">Invalid preference data was recovered to safe defaults.</p>}
      <form className="preferences-form" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSave(draft).finally(() => setBusy(false));
      }}>
        <label>Theme<select value={draft.theme} onChange={(event) => update("theme", event.target.value as Preferences["theme"])}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Density<select value={draft.density} onChange={(event) => update("density", event.target.value as Preferences["density"])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        <label>Zoom<select value={draft.zoom} onChange={(event) => update("zoom", Number(event.target.value) as Preferences["zoom"])}>{[0.8, 0.9, 1, 1.1, 1.2].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}</select></label>
        <label>Reduced motion<select value={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.value as Preferences["reducedMotion"])}><option value="system">Follow system</option><option value="reduce">Reduce</option><option value="no-preference">Allow motion</option></select></label>
        <label>Command palette<select value={draft.commandPaletteShortcut} onChange={(event) => update("commandPaletteShortcut", event.target.value as Preferences["commandPaletteShortcut"])}><option value="mod+k">⌘/Ctrl K</option><option value="mod+shift+p">⌘/Ctrl Shift P</option></select></label>
        <label>Managed worktree limit<select value={draft.managedWorktreeLimit ?? "unlimited"} onChange={(event) => update("managedWorktreeLimit", event.target.value === "unlimited" ? null : Number(event.target.value))}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value="unlimited">Unlimited</option></select></label>
        <p className="preference-note">The limit applies only to Aldunis-created worktrees. Reaching it blocks creation until an eligible checkout is explicitly removed or the limit is raised.</p>
        <p className="search-scope">Shortcuts are exclusive: selecting one command-palette binding releases the other, preventing conflicts.</p>
        <footer><Button type="button" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy}>{busy ? "Saving…" : "Save preferences"}</Button></footer>
      </form>
    </OverlayDialog>
  );
}


