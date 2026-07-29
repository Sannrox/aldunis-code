export const COMPOSER_MAX_HEIGHT = 160;

export interface ComposerHeightTarget {
  scrollHeight: number;
  style: {
    height: string;
  };
}

export function syncComposerHeight(
  target: ComposerHeightTarget,
  maxHeight = COMPOSER_MAX_HEIGHT,
): void {
  target.style.height = "auto";
  target.style.height = `${Math.min(target.scrollHeight, maxHeight)}px`;
}
