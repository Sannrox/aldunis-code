import React, { useEffect, useState } from "react";
import type { Preferences } from "../../preferences";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

const SECTIONS = [
  "General",
  "Providers",
  "Worktrees",
  "Approvals",
  "Access",
  "Keybindings",
  "Diagnostics",
  "Archived",
] as const;

type Section = (typeof SECTIONS)[number];

/**
 * Settings lives outside work chrome (design-system.md). Theme and density
 * belong here, not in the header during an approval.
 */
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
  const [section, setSection] = useState<Section>("General");
  useEffect(() => {
    if (open) {
      setDraft(preferences);
      setSection("General");
    }
  }, [open, preferences]);
  if (!open) return null;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <OverlayDialog title="Settings" onClose={onClose}>
      {recovered && (
        <p className="recovery-note" role="status">
          Invalid preference data was recovered to safe defaults.
        </p>
      )}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              type="button"
              key={item}
              className={section === item ? "active" : ""}
              onClick={() => setSection(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <form
          className="preferences-form settings-body"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void onSave(draft).finally(() => setBusy(false));
          }}
        >
          {section === "General" && (
            <>
              <label>
                Theme
                <select
                  value={draft.theme}
                  onChange={(event) => update("theme", event.target.value as Preferences["theme"])}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label>
                Density
                <select
                  value={draft.density}
                  onChange={(event) => update("density", event.target.value as Preferences["density"])}
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label>
                Zoom
                <select
                  value={draft.zoom}
                  onChange={(event) => update("zoom", Number(event.target.value) as Preferences["zoom"])}
                >
                  {[0.8, 0.9, 1, 1.1, 1.2].map((value) => (
                    <option value={value} key={value}>{Math.round(value * 100)}%</option>
                  ))}
                </select>
              </label>
              <label>
                Reduced motion
                <select
                  value={draft.reducedMotion}
                  onChange={(event) =>
                    update("reducedMotion", event.target.value as Preferences["reducedMotion"])}
                >
                  <option value="system">Follow system</option>
                  <option value="reduce">Reduce</option>
                  <option value="no-preference">Allow motion</option>
                </select>
              </label>
            </>
          )}
          {section === "Providers" && (
            <p className="preference-note">
              Provider profiles and declarative adapters stay in their dedicated dialogs.
              Use Settings only for installation-wide posture — not mid-turn provider switching.
            </p>
          )}
          {section === "Worktrees" && (
            <>
              <label>
                Managed worktree limit
                <select
                  value={draft.managedWorktreeLimit ?? "unlimited"}
                  onChange={(event) =>
                    update(
                      "managedWorktreeLimit",
                      event.target.value === "unlimited" ? null : Number(event.target.value),
                    )}
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value="unlimited">Unlimited</option>
                </select>
              </label>
              <p className="preference-note">
                Applies only to Aldunis-created worktrees. Settling a thread does not release the
                worktree — release is a separate action. Reaching the limit blocks creation until a
                checkout is released or the limit is raised.
              </p>
              <p className="preference-note">
                Max threads per project: <strong>200</strong> (server{" "}
                <code>MAX_THREADS_PER_PROJECT</code>). This is not configurable here; older
                conversations must be deleted when the project hits the retention ceiling.
              </p>
            </>
          )}
          {section === "Approvals" && (
            <p className="preference-note">
              Mutating tools always require an explicit, scoped approval in the conversation.
              There is no ambient grant. Composer access scope states the posture before send.
            </p>
          )}
          {section === "Access" && (
            <p className="preference-note">
              Remote and iPad access are loopback or paired remote sessions only. Credentials and
              provider transcripts never leave this machine except through an explicit provider run.
            </p>
          )}
          {section === "Keybindings" && (
            <>
              <label>
                Command palette
                <select
                  value={draft.commandPaletteShortcut}
                  onChange={(event) =>
                    update(
                      "commandPaletteShortcut",
                      event.target.value as Preferences["commandPaletteShortcut"],
                    )}
                >
                  <option value="mod+k">⌘/Ctrl K</option>
                  <option value="mod+shift+p">⌘/Ctrl Shift P</option>
                </select>
              </label>
              <p className="search-scope">
                Product switch: ⌘⇧1 Code · ⌘⇧2 Sekai · ⌘⇧3 Chisei · ⌘⇧4 Tenkai.
                Bindings are exclusive — selecting one command-palette shortcut releases the other.
              </p>
            </>
          )}
          {section === "Diagnostics" && (
            <p className="preference-note">
              Prefer the existing provider profile probes and adapter administration for connectivity
              checks. There is no ambient “connected” chrome — providers are spawned per session.
            </p>
          )}
          {section === "Archived" && (
            <p className="preference-note">
              Archived threads remain in local history and are available from the sidebar Archived
              filter. Settled is a separate shelf state and does not archive.
            </p>
          )}
          <footer>
            <Button type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
          </footer>
        </form>
      </div>
    </OverlayDialog>
  );
}
