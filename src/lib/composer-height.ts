export const COMPOSER_MAX_HEIGHT = 160;

export interface ComposerHeightTarget {
  scrollHeight: number;
  style: {
    height: string;
  };
}

let fieldSizingSupported: boolean | null = null;

/** Chromium/Electron and modern Safari can size the textarea without a layout thrash. */
export function supportsComposerFieldSizing(
  supports:
    ((property: string, value: string) => boolean) | undefined = globalThis.CSS?.supports?.bind(
    globalThis.CSS,
  ),
): boolean {
  if (fieldSizingSupported !== null) return fieldSizingSupported;
  fieldSizingSupported = Boolean(supports?.("field-sizing", "content"));
  return fieldSizingSupported;
}

/** Test helper — drop the cached feature probe between cases. */
export function resetComposerFieldSizingSupportForTests(): void {
  fieldSizingSupported = null;
}

export function syncComposerHeight(
  target: ComposerHeightTarget,
  maxHeight = COMPOSER_MAX_HEIGHT,
): void {
  // Native field-sizing owns growth when the stylesheet advertises support.
  if (supportsComposerFieldSizing()) return;
  // Collapse first so shrink paths re-measure correctly without retaining the
  // previous assigned height (which would inflate scrollHeight).
  target.style.height = "0px";
  target.style.height = `${Math.min(target.scrollHeight, maxHeight)}px`;
}
