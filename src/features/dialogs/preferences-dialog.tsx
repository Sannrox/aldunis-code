import React, { useEffect, useRef, useState } from "react";
import type { Preferences } from "../../preferences";
import { Button } from "../../components/ui";
import { SIDEBAR_TOGGLE_SHORTCUT_LABEL } from "../../lib/sidebar-state";
import { VOICE_INPUT_SHORTCUT_LABEL } from "../../lib/voice-input";
import { PROMPT_STASH_SHORTCUT_LABEL } from "../../lib/composer-prompt-stash";
import { shortcutLabel } from "../../lib/workspace-shortcuts";
import { DesktopUpdateSettings, type DesktopUpdateControls } from "../updates/desktop-update";

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

export type Section = (typeof SECTIONS)[number] | "Updates";

export function preferenceSectionHasEditableFields(section: Section): boolean {
  return section === "General" || section === "Worktrees" || section === "Keybindings";
}

export function preferencesHaveUnsavedChanges(draft: Preferences, saved: Preferences): boolean {
  return (
    draft.theme !== saved.theme ||
    draft.density !== saved.density ||
    draft.zoom !== saved.zoom ||
    draft.reducedMotion !== saved.reducedMotion ||
    draft.orchestrationThreadsBeta !== saved.orchestrationThreadsBeta ||
    draft.showThinking !== saved.showThinking ||
    draft.conversationOpenScroll !== saved.conversationOpenScroll ||
    draft.commandPaletteShortcut !== saved.commandPaletteShortcut ||
    draft.conversationSearchShortcut !== saved.conversationSearchShortcut ||
    draft.managedWorktreeLimit !== saved.managedWorktreeLimit
  );
}

export function ProviderSettingsLinks({
  onOpenProviderManagement,
  disabled = false,
}: {
  onOpenProviderManagement: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="provider-settings-links">
      <p className="preference-note">
        Profiles, adapter package trust, and readiness diagnostics share one navigation shell. Their
        credentials, approvals, and mutation APIs remain separate.
      </p>
      <div>
        <Button
          type="button"
          variant="primary"
          onClick={onOpenProviderManagement}
          disabled={disabled}
        >
          Open provider management
        </Button>
      </div>
      {disabled && (
        <p className="preference-note" role="status">
          Save or cancel your preference changes before opening provider management.
        </p>
      )}
    </div>
  );
}

export function ArchivedSettingsLinks({
  onOpenArchivedThreads,
  disabled = false,
}: {
  onOpenArchivedThreads: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="provider-settings-links">
      <p className="preference-note">
        Archived threads remain in local history. Settled is a separate shelf state and does not
        archive.
      </p>
      <div>
        <Button type="button" variant="primary" onClick={onOpenArchivedThreads} disabled={disabled}>
          Open archived threads
        </Button>
      </div>
      {disabled && (
        <p className="preference-note" role="status">
          Save or cancel your preference changes before opening archived threads.
        </p>
      )}
    </div>
  );
}

export function AccessSettingsLinks({
  onOpenConnections,
  disabled = false,
}: {
  onOpenConnections: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="provider-settings-links">
      <p className="preference-note">
        Remote and iPad access use loopback-host controls for pairing and revocation. Paired devices
        can use a session, but cannot administer access.
      </p>
      <div>
        <Button type="button" variant="primary" onClick={onOpenConnections} disabled={disabled}>
          Open Connections
        </Button>
      </div>
      {disabled && (
        <p className="preference-note" role="status">
          Save or cancel your preference changes before opening Connections.
        </p>
      )}
    </div>
  );
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Full-screen settings surface matching workbench-mock.html (.settings / .snav / .sw).
 * Theme and density belong here, not in the header during an approval.
 */
export function PreferencesDialog({
  open,
  preferences,
  recovered,
  onClose,
  onSave,
  onOpenProviderManagement,
  onOpenConnections = () => undefined,
  onOpenArchivedThreads,
  desktopUpdates,
}: {
  open: boolean;
  preferences: Preferences;
  recovered: boolean;
  onClose: () => void;
  onSave: (preferences: Preferences) => Promise<void>;
  onOpenProviderManagement: () => void;
  onOpenConnections?: () => void;
  onOpenArchivedThreads: () => void;
  desktopUpdates?: DesktopUpdateControls;
}) {
  const [draft, setDraft] = useState(preferences);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("General");
  const sections = desktopUpdates ? [...SECTIONS, "Updates" as const] : SECTIONS;
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft(preferences);
    setSection("General");
    const focusInitial = () => {
      const root = rootRef.current;
      if (!root) return;
      const preferred = root.querySelector<HTMLElement>("[data-dialog-initial-focus]");
      const first = preferred ?? root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const timer = window.setTimeout(focusInitial, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      const restore = returnFocusRef.current;
      returnFocusRef.current = null;
      // Only restore if the element is still in the document and focusable.
      if (restore?.isConnected) restore.focus();
    };
  }, [open, preferences]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !rootRef.current) return;
      const focusables = Array.from(
        rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => {
        if (element.hasAttribute("disabled")) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none";
      });
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      // Keep Tab cycling inside the modal (aria-modal without Base UI focus trap).
      if (!rootRef.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const draftDirty = preferencesHaveUnsavedChanges(draft, preferences);

  return (
    <div
      ref={rootRef}
      className="settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <nav className="snav" aria-label="Settings sections">
        <button type="button" className="sback" data-dialog-initial-focus onClick={onClose}>
          ← Back to threads
        </button>
        <div className="snav-sections">
          {sections.map((item) => (
            <button
              type="button"
              key={item}
              className={`snav-i ${section === item ? "on" : ""}`}
              aria-current={section === item ? "true" : undefined}
              onClick={() => setSection(item)}
            >
              {item === "Archived" ? "Archived threads" : item}
            </button>
          ))}
        </div>
      </nav>
      <div className="sbody">
        <div className="sw">
          {recovered && (
            <p className="recovery-note" role="status">
              Invalid preference data was recovered to safe defaults.
            </p>
          )}
          <h2 id="settings-title">{section === "Archived" ? "Archived threads" : section}</h2>
          <div className="lead">
            {section === "General" &&
              "Appearance and startup. None of this changes while you work."}
            {section === "Providers" &&
              "Installation-wide provider posture — not mid-turn switching."}
            {section === "Worktrees" && "Managed checkout limits for Aldunis-created worktrees."}
            {section === "Approvals" && "How mutating tools ask for consent."}
            {section === "Access" && "Loopback and paired remote sessions."}
            {section === "Keybindings" &&
              "Command palette, conversation search, product switch, sidebar, and composer shortcuts."}
            {section === "Diagnostics" && "Where to look when a provider will not start."}
            {section === "Updates" &&
              "Keep the packaged desktop shell current without interrupting an active turn."}
            {section === "Archived" && "Review conversations hidden from the active sidebar."}
          </div>

          <form
            className="preferences-form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              void onSave(draft).finally(() => setBusy(false));
            }}
          >
            {section === "General" && (
              <>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Theme</div>
                    <div className="fd">
                      Changes apply when you save. System follows your operating system setting.
                    </div>
                  </div>
                  <div className="fc">
                    <div className="seg" role="group" aria-label="Theme">
                      {(["light", "dark", "system"] as const).map((value) => (
                        <button
                          type="button"
                          key={value}
                          className={draft.theme === value ? "on" : ""}
                          aria-pressed={draft.theme === value}
                          onClick={() => update("theme", value)}
                        >
                          {value[0]!.toUpperCase() + value.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Conversation search</div>
                    <div className="fd">
                      Search bounded local thread metadata. Messages and repository contents stay
                      excluded.
                    </div>
                  </div>
                  <div className="fc">
                    <div className="seg" role="group" aria-label="Conversation search shortcut">
                      <button
                        type="button"
                        className={draft.conversationSearchShortcut === "mod+shift+f" ? "on" : ""}
                        aria-pressed={draft.conversationSearchShortcut === "mod+shift+f"}
                        onClick={() => update("conversationSearchShortcut", "mod+shift+f")}
                      >
                        ⌘⇧F
                      </button>
                      <button
                        type="button"
                        className={draft.conversationSearchShortcut === "mod+shift+o" ? "on" : ""}
                        aria-pressed={draft.conversationSearchShortcut === "mod+shift+o"}
                        onClick={() => update("conversationSearchShortcut", "mod+shift+o")}
                      >
                        ⌘⇧O
                      </button>
                    </div>
                    <kbd>{shortcutLabel(draft.conversationSearchShortcut)}</kbd>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Density</div>
                    <div className="fd">Comfortable is the default. Compact tightens rows.</div>
                  </div>
                  <div className="fc">
                    <div className="seg" role="group" aria-label="Density">
                      {(["comfortable", "compact"] as const).map((value) => (
                        <button
                          type="button"
                          key={value}
                          className={draft.density === value ? "on" : ""}
                          aria-pressed={draft.density === value}
                          onClick={() => update("density", value)}
                        >
                          {value[0]!.toUpperCase() + value.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-zoom">
                      Zoom
                    </label>
                    <div className="fd">Scales the whole workbench UI.</div>
                  </div>
                  <div className="fc">
                    <select
                      id="preferences-zoom"
                      name="preferences-zoom"
                      className="num"
                      style={{ width: "auto", minWidth: 72, padding: "0 8px" }}
                      value={draft.zoom}
                      onChange={(event) =>
                        update("zoom", Number(event.target.value) as Preferences["zoom"])
                      }
                    >
                      {[0.8, 0.9, 1, 1.1, 1.2].map((value) => (
                        <option value={value} key={value}>
                          {Math.round(value * 100)}%
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-reduced-motion">
                      Reduced motion
                    </label>
                    <div className="fd">Settle transitions and shelf chevrons respect this.</div>
                  </div>
                  <div className="fc">
                    <select
                      id="preferences-reduced-motion"
                      name="preferences-reduced-motion"
                      value={draft.reducedMotion}
                      onChange={(event) =>
                        update("reducedMotion", event.target.value as Preferences["reducedMotion"])
                      }
                    >
                      <option value="system">Follow system</option>
                      <option value="reduce">Reduce</option>
                      <option value="no-preference">Allow motion</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-show-thinking">
                      Show provider thinking
                    </label>
                    <div className="fd">
                      Display provider-emitted reasoning in the live timeline. Thinking is never
                      saved to local history.
                    </div>
                  </div>
                  <div className="fc">
                    <input
                      id="preferences-show-thinking"
                      name="preferences-show-thinking"
                      type="checkbox"
                      checked={draft.showThinking}
                      onChange={(event) => update("showThinking", event.target.checked)}
                    />
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-conversation-open-scroll">
                      Open conversation at
                    </label>
                    <div className="fd">
                      Jump to the latest message, or restore where you last scrolled in that thread.
                      Live auto-follow while reading is unchanged.
                    </div>
                  </div>
                  <div className="fc">
                    <select
                      id="preferences-conversation-open-scroll"
                      name="preferences-conversation-open-scroll"
                      value={draft.conversationOpenScroll}
                      onChange={(event) =>
                        update(
                          "conversationOpenScroll",
                          event.target.value as Preferences["conversationOpenScroll"],
                        )
                      }
                    >
                      <option value="latest">Latest message</option>
                      <option value="remember">Last scroll position</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-orchestration-threads">
                      Orchestration threads beta
                    </label>
                    <div className="fd">
                      Link existing conversations and show read-only child status in their parent.
                    </div>
                  </div>
                  <div className="fc">
                    <input
                      id="preferences-orchestration-threads"
                      name="preferences-orchestration-threads"
                      type="checkbox"
                      checked={draft.orchestrationThreadsBeta}
                      onChange={(event) => update("orchestrationThreadsBeta", event.target.checked)}
                    />
                  </div>
                </div>
              </>
            )}
            {section === "Providers" && (
              <ProviderSettingsLinks
                disabled={draftDirty}
                onOpenProviderManagement={() => {
                  onClose();
                  onOpenProviderManagement();
                }}
              />
            )}
            {section === "Worktrees" && (
              <>
                <div className="field">
                  <div className="fl">
                    <label className="fn" htmlFor="preferences-worktree-limit">
                      Managed worktree limit
                    </label>
                    <div className="fd">
                      Dispatch fails once this many Aldunis worktrees exist. Settled threads still
                      count.
                    </div>
                  </div>
                  <div className="fc">
                    <select
                      id="preferences-worktree-limit"
                      name="preferences-worktree-limit"
                      className="num"
                      style={{ width: "auto", minWidth: 72, padding: "0 8px" }}
                      value={draft.managedWorktreeLimit ?? "unlimited"}
                      onChange={(event) =>
                        update(
                          "managedWorktreeLimit",
                          event.target.value === "unlimited" ? null : Number(event.target.value),
                        )
                      }
                    >
                      <option value={5}>5</option>
                      <option value={8}>8</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value="unlimited">∞</option>
                    </select>
                  </div>
                </div>
                <p className="preference-note">
                  Max threads per project: <strong>200</strong> (server{" "}
                  <code>MAX_THREADS_PER_PROJECT</code>). This is not configurable here.
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
              <AccessSettingsLinks
                onOpenConnections={() => {
                  onClose();
                  onOpenConnections();
                }}
                disabled={draftDirty}
              />
            )}
            {section === "Keybindings" && (
              <>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Command palette</div>
                    <div className="fd">Selecting one shortcut releases the other.</div>
                  </div>
                  <div className="fc">
                    <div className="seg" role="group" aria-label="Command palette shortcut">
                      <button
                        type="button"
                        className={draft.commandPaletteShortcut === "mod+k" ? "on" : ""}
                        aria-pressed={draft.commandPaletteShortcut === "mod+k"}
                        onClick={() => update("commandPaletteShortcut", "mod+k")}
                      >
                        ⌘K
                      </button>
                      <button
                        type="button"
                        className={draft.commandPaletteShortcut === "mod+shift+p" ? "on" : ""}
                        aria-pressed={draft.commandPaletteShortcut === "mod+shift+p"}
                        onClick={() => update("commandPaletteShortcut", "mod+shift+p")}
                      >
                        ⌘⇧P
                      </button>
                    </div>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Sidebar</div>
                    <div className="fd">Collapse or reopen the workbench sidebar.</div>
                  </div>
                  <div className="fc">
                    <kbd>{SIDEBAR_TOGGLE_SHORTCUT_LABEL}</kbd>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Voice input</div>
                    <div className="fd">Toggle dictation in the active conversation pane.</div>
                  </div>
                  <div className="fc">
                    <kbd>{VOICE_INPUT_SHORTCUT_LABEL}</kbd>
                  </div>
                </div>
                <div className="field">
                  <div className="fl">
                    <div className="fn">Prompt stash</div>
                    <div className="fd">
                      Park the current draft across threads, or open the stash when empty.
                    </div>
                  </div>
                  <div className="fc">
                    <kbd>{PROMPT_STASH_SHORTCUT_LABEL}</kbd>
                  </div>
                </div>
                <p className="search-scope">Product switch: ⌘1–4 (with Ctrl on Windows/Linux).</p>
              </>
            )}
            {section === "Diagnostics" && (
              <p className="preference-note">
                Prefer the existing provider profile probes and adapter administration for
                connectivity checks. There is no ambient “connected” chrome — providers are spawned
                per session.
              </p>
            )}
            {section === "Updates" && desktopUpdates && (
              <DesktopUpdateSettings {...desktopUpdates} />
            )}
            {section === "Archived" && (
              <ArchivedSettingsLinks
                onOpenArchivedThreads={onOpenArchivedThreads}
                disabled={draftDirty}
              />
            )}
            {(preferenceSectionHasEditableFields(section) || draftDirty) && (
              <footer
                style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 24 }}
              >
                <Button type="button" onClick={onClose} aria-label="Cancel settings changes">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !draftDirty}
                  aria-label={busy ? "Saving settings" : "Save settings"}
                >
                  {busy ? "Saving…" : "Save settings"}
                </Button>
              </footer>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
