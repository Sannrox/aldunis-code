export const SIDEBAR_OPEN_STORAGE_KEY = "aldunis.sidebar.open";
export const MOBILE_SIDEBAR_OPEN_STORAGE_KEY = "aldunis.sidebar.mobileOpen";
export const DEFAULT_SIDEBAR_OPEN = true;
export const DEFAULT_MOBILE_SIDEBAR_OPEN = false;
export const SIDEBAR_TOGGLE_SHORTCUT = "mod+b" as const;
export const SIDEBAR_TOGGLE_SHORTCUT_LABEL = "⌘B / Ctrl+B";
const SIDEBAR_TOGGLE_KEY = SIDEBAR_TOGGLE_SHORTCUT.slice(-1);

export interface SidebarToggleShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export type SidebarTransitionSource = "user" | "responsive" | "navigation" | "dialog";

export interface SidebarLifecycleState {
  open: boolean;
  narrowViewport: boolean;
}

export type SidebarLifecycleEvent =
  | { type: "initialize" }
  | { type: "toggle" }
  | { type: "set_open"; open: boolean; source: Exclude<SidebarTransitionSource, "responsive"> }
  | { type: "viewport_change"; narrowViewport: boolean; preferredOpen: boolean };

export type SidebarFocusTarget = "collapse_toggle" | "open_toggle" | "main" | "escape_hidden";

export type SidebarLifecycleEffect =
  | { type: "persist"; open: boolean; narrowViewport: boolean }
  | { type: "focus"; target: SidebarFocusTarget };

export interface SidebarLifecycleTransition {
  state: SidebarLifecycleState;
  effects: SidebarLifecycleEffect[];
}

export interface SidebarShortcutTarget {
  isContentEditable: boolean;
  closest(selectors: string): unknown;
  matches(selectors: string): boolean;
}

export function initialSidebarLifecycle(
  open: boolean,
  narrowViewport: boolean,
): SidebarLifecycleState {
  return { open, narrowViewport };
}

export function transitionSidebarLifecycle(
  current: SidebarLifecycleState,
  event: SidebarLifecycleEvent,
): SidebarLifecycleTransition {
  if (event.type === "initialize") {
    return {
      state: current,
      effects: [{ type: "persist", open: current.open, narrowViewport: current.narrowViewport }],
    };
  }
  if (event.type === "viewport_change") {
    const state = { open: event.preferredOpen, narrowViewport: event.narrowViewport };
    const effects: SidebarLifecycleEffect[] = [
      { type: "persist", open: state.open, narrowViewport: state.narrowViewport },
    ];
    if (current.open && !state.open) effects.push({ type: "focus", target: "escape_hidden" });
    return { state, effects };
  }

  const open = event.type === "toggle" ? !current.open : event.open;
  if (open === current.open) return { state: current, effects: [] };
  const source: SidebarTransitionSource = event.type === "toggle" ? "user" : event.source;
  const state = { ...current, open };
  const effects: SidebarLifecycleEffect[] = [
    { type: "persist", open, narrowViewport: current.narrowViewport },
  ];
  if (source === "navigation") effects.push({ type: "focus", target: "main" });
  else if (source === "user") {
    effects.push({ type: "focus", target: open ? "collapse_toggle" : "open_toggle" });
  }
  return { state, effects };
}

export function isSidebarShortcutCapturedTarget(
  target: SidebarShortcutTarget | null | undefined,
): boolean {
  return Boolean(
    target &&
    (target.isContentEditable ||
      target.closest("[data-keybinding-capture]") !== null ||
      target.matches("input, textarea, select")),
  );
}

export function matchesSidebarToggleShortcut(event: SidebarToggleShortcutEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.repeat !== true &&
    event.key.toLocaleLowerCase() === SIDEBAR_TOGGLE_KEY
  );
}

export function resolveSidebarOpenPreference(
  value: string | null,
  fallback = DEFAULT_SIDEBAR_OPEN,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function readSidebarOpenPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
  key = SIDEBAR_OPEN_STORAGE_KEY,
  fallback = DEFAULT_SIDEBAR_OPEN,
): boolean {
  try {
    return resolveSidebarOpenPreference(storage?.getItem(key) ?? null, fallback);
  } catch {
    return fallback;
  }
}

export function writeSidebarOpenPreference(
  storage: Pick<Storage, "setItem"> | null | undefined,
  open: boolean,
  key = SIDEBAR_OPEN_STORAGE_KEY,
): void {
  try {
    storage?.setItem(key, String(open));
  } catch {
    /* Ignore private-mode and quota failures; the shell remains usable. */
  }
}
