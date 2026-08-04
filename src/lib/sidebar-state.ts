export const SIDEBAR_OPEN_STORAGE_KEY = "aldunis.sidebar.open";
export const DEFAULT_SIDEBAR_OPEN = true;
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

export function resolveSidebarOpenPreference(value: string | null): boolean {
  return value === "false" ? false : DEFAULT_SIDEBAR_OPEN;
}

export function readSidebarOpenPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  try {
    return resolveSidebarOpenPreference(storage?.getItem(SIDEBAR_OPEN_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_SIDEBAR_OPEN;
  }
}

export function writeSidebarOpenPreference(
  storage: Pick<Storage, "setItem"> | null | undefined,
  open: boolean,
): void {
  try {
    storage?.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(open));
  } catch {
    /* Ignore private-mode and quota failures; the shell remains usable. */
  }
}
