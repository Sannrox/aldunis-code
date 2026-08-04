export type ModifierShortcut =
  | "mod+k"
  | "mod+shift+p"
  | "mod+shift+f"
  | "mod+shift+o";

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
}

export function matchesModifierShortcut(
  event: ShortcutEvent,
  shortcut: ModifierShortcut,
): boolean {
  const [modifier, maybeShift, expectedKey] = shortcut.split("+");
  const hasModifier = event.metaKey || event.ctrlKey;
  const needsShift = maybeShift === "shift";
  return modifier === "mod"
    && hasModifier
    && event.shiftKey === needsShift
    && event.altKey !== true
    && event.key.toLocaleLowerCase() === expectedKey;
}

export function isKeybindingCaptured(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.closest("[data-keybinding-capture]") !== null
    || target.matches("input, textarea, select");
}

export function shortcutLabel(shortcut: "mod+shift+f" | "mod+shift+o"): string {
  return shortcut === "mod+shift+f" ? "⌘⇧F / Ctrl+Shift+F" : "⌘⇧O / Ctrl+Shift+O";
}
