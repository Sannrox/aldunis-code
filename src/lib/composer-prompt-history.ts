/**
 * Shell-style prompt history for the conversation composer.
 *
 * Entries are conversation-local user prompts (oldest → newest). Index
 * `entries.length` is the live draft slot; smaller indices are recalled prompts.
 * ArrowUp/Down only when the caret is at the history boundary (empty draft or
 * caret at position 0 with a collapsed selection), and never while @/ suggestions
 * own the keys.
 */

export const COMPOSER_PROMPT_HISTORY_MAX = 50;

/** Build a bounded stack from sent user message texts (oldest → newest). */
export function promptHistoryFromMessages(
  messages: ReadonlyArray<{ text: string }>,
  max = COMPOSER_PROMPT_HISTORY_MAX,
): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  if (out.length > max) return out.slice(-max);
  return out;
}

/**
 * True when ↑ may load history: no suggestion popup, collapsed caret at the
 * start of the draft (includes empty). Mid-text / multi-line mid-line caret
 * keeps normal movement.
 */
export function isComposerHistoryBoundary(input: {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}): boolean {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  if (start !== end) return false;
  return start === 0;
}

export type PromptHistoryBrowse = {
  /** Index into entries, or `entries.length` for the live draft. */
  index: number;
  /** Draft text captured when the user first left the live slot via ↑. */
  draftBeforeHistory: string;
};

export function livePromptHistoryIndex(entries: readonly string[]): number {
  return entries.length;
}

export function isBrowsingPromptHistory(
  browse: PromptHistoryBrowse,
  entries: readonly string[],
): boolean {
  return browse.index < entries.length;
}

/**
 * Move one step older (↑). Returns null when history cannot apply (empty stack
 * or already at oldest while browsing).
 */
export function stepPromptHistoryUp(
  entries: readonly string[],
  browse: PromptHistoryBrowse,
  currentDraft: string,
): PromptHistoryBrowse | null {
  if (entries.length === 0) return null;
  if (browse.index <= 0) return null;
  const nextIndex = browse.index - 1;
  if (browse.index >= entries.length) {
    return { index: nextIndex, draftBeforeHistory: currentDraft };
  }
  return { index: nextIndex, draftBeforeHistory: browse.draftBeforeHistory };
}

/**
 * Move one step newer (↓). Only meaningful while browsing. At the live slot,
 * restores `draftBeforeHistory`.
 */
export function stepPromptHistoryDown(
  entries: readonly string[],
  browse: PromptHistoryBrowse,
): PromptHistoryBrowse | null {
  if (!isBrowsingPromptHistory(browse, entries)) return null;
  const nextIndex = browse.index + 1;
  return {
    index: nextIndex,
    draftBeforeHistory: browse.draftBeforeHistory,
  };
}

/** Draft text for the current browse index (live slot → draftBeforeHistory). */
export function draftForPromptHistoryIndex(
  entries: readonly string[],
  browse: PromptHistoryBrowse,
): string {
  if (browse.index >= entries.length) return browse.draftBeforeHistory;
  return entries[browse.index] ?? browse.draftBeforeHistory;
}

/** Reset to the live draft slot (after send, Escape, or user edits while browsing). */
export function resetPromptHistoryBrowse(entries: readonly string[]): PromptHistoryBrowse {
  return { index: livePromptHistoryIndex(entries), draftBeforeHistory: "" };
}
