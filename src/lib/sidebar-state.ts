export const SIDEBAR_OPEN_STORAGE_KEY = "aldunis.sidebar.open";
export const DEFAULT_SIDEBAR_OPEN = true;

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
