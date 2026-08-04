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

export function matchesSidebarToggleShortcut(event: SidebarToggleShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey)
    && !event.shiftKey
    && !event.altKey
    && event.repeat !== true
    && event.key.toLocaleLowerCase() === SIDEBAR_TOGGLE_KEY;
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
