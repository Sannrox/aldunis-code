/**
 * Local-only composer draft stash (T3-inspired).
 * Never sent to the host; size- and entry-capped for browser storage safety.
 * All storage access is best-effort and must never throw into send/navigation.
 */

export const COMPOSER_DRAFT_STORAGE_KEY = "aldunis.composerDrafts.v1";
export const COMPOSER_DRAFT_MAX_CHARS = 50_000;
export const COMPOSER_DRAFT_MAX_ENTRIES = 40;

export interface ComposerDraftEntry {
  text: string;
  updatedAt: string;
}

export type ComposerDraftStore = Record<string, ComposerDraftEntry>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function composerDraftKey(input: {
  conversationId: string | null | undefined;
  projectId: string | null | undefined;
  pane: string;
}): string {
  if (input.conversationId) return `thread:${input.conversationId}`;
  const project = input.projectId?.trim() || "unknown";
  return `new:${project}:${input.pane}`;
}

export function readComposerDraftStore(
  storage: StorageLike | null | undefined,
): ComposerDraftStore {
  if (!storage) return {};
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: ComposerDraftStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || typeof key !== "string") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.text !== "string" || typeof entry.updatedAt !== "string") continue;
      store[key] = {
        text: entry.text.slice(0, COMPOSER_DRAFT_MAX_CHARS),
        updatedAt: entry.updatedAt,
      };
    }
    return store;
  } catch {
    return {};
  }
}

function writeComposerDraftStore(storage: StorageLike, store: ComposerDraftStore): void {
  try {
    const entries = Object.entries(store).sort((left, right) =>
      right[1].updatedAt.localeCompare(left[1].updatedAt),
    );
    const capped = Object.fromEntries(entries.slice(0, COMPOSER_DRAFT_MAX_ENTRIES));
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Best-effort only: quota / privacy mode must not break send or navigation.
  }
}

export function loadComposerDraft(
  storage: StorageLike | null | undefined,
  key: string,
): ComposerDraftEntry | null {
  if (!key) return null;
  return readComposerDraftStore(storage)[key] ?? null;
}

export function saveComposerDraft(
  storage: StorageLike | null | undefined,
  key: string,
  text: string,
  now = new Date().toISOString(),
): void {
  if (!storage || !key) return;
  try {
    const trimmedCapacity = text.slice(0, COMPOSER_DRAFT_MAX_CHARS);
    const store = readComposerDraftStore(storage);
    if (!trimmedCapacity.trim()) {
      if (!(key in store)) return;
      delete store[key];
      if (Object.keys(store).length === 0) {
        try {
          storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
        } catch {
          // ignore
        }
        return;
      }
      writeComposerDraftStore(storage, store);
      return;
    }
    store[key] = { text: trimmedCapacity, updatedAt: now };
    writeComposerDraftStore(storage, store);
  } catch {
    // Best-effort only.
  }
}

export function clearComposerDraft(storage: StorageLike | null | undefined, key: string): void {
  if (!storage || !key) return;
  try {
    const store = readComposerDraftStore(storage);
    if (!(key in store)) return;
    delete store[key];
    if (Object.keys(store).length === 0) {
      try {
        storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      } catch {
        // ignore
      }
      return;
    }
    writeComposerDraftStore(storage, store);
  } catch {
    // Best-effort only — never throw into the send lifecycle.
  }
}
