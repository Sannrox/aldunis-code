/**
 * Composer prompt stash (T3 Code–inspired).
 *
 * Parks unfinished drafts in profile-local storage so operators can switch
 * threads and restore later. Text only — no provider, model, or image
 * payload — because the point of stashing is to move a prompt into a
 * different conversation without dragging the old run settings along.
 *
 * Not durable conversation history. Not a server transcript. Fail soft on
 * storage quota or private-mode storage denial.
 */

/** Unscoped legacy key (pre multi-account). Migrated into the local scope once. */
export const PROMPT_STASH_STORAGE_KEY = "aldunis-code:prompt-stash:v1";
export const PROMPT_STASH_STORAGE_KEY_PREFIX = "aldunis-code:prompt-stash:v1:";
export const PROMPT_STASH_STORAGE_VERSION = 1;
export const MAX_STASH_ENTRIES = 20;
/** Soft cap so a single pasted blob cannot exhaust origin storage. */
export const MAX_STASH_PROMPT_CHARS = 100_000;
const SNIPPET_MAX_CHARS = 90;
/** Matches `src/remote-auth.ts` session blob so remote logouts can isolate stash. */
const REMOTE_SESSION_STORAGE_KEY = "aldunis-code.remote-session.v1";

export interface PromptStashEntry {
  id: string;
  createdAt: string;
  prompt: string;
}

export interface PromptStashState {
  version: typeof PROMPT_STASH_STORAGE_VERSION;
  entries: PromptStashEntry[];
}

export type PromptStashMutation =
  | { ok: true; entries: PromptStashEntry[]; message: string }
  | { ok: false; entries: PromptStashEntry[]; message: string };

export type PromptStashRestore = PromptStashMutation & {
  prompt?: string;
};

/**
 * The complete prompt-stash interface used by the composer and its tests.
 * Storage selection, validation, capacity, and atomic draft swapping stay
 * behind this seam so callers cannot assemble a partial stash transaction.
 */
export interface PromptStash {
  load(): PromptStashEntry[];
  stash(prompt: string): PromptStashMutation;
  restore(entryId: string, currentDraft: string): PromptStashRestore;
  remove(entryId: string): PromptStashMutation;
}

export type PromptStashStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromptStashEntry(value: unknown): value is PromptStashEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.prompt === "string"
  );
}

export function normalizeStashPrompt(prompt: string): string | null {
  // Preserve intentional leading/trailing newlines the operator typed, but
  // refuse pure whitespace so Mod+S on an empty box opens the menu instead.
  // Oversized drafts are rejected (not truncated) so stash never destroys the
  // tail of a pasted prompt while reporting success.
  if (!prompt.trim()) return null;
  if (prompt.length > MAX_STASH_PROMPT_CHARS) return null;
  return prompt;
}

/** Why a draft cannot be stashed, for operator-facing status copy. */
export function stashPromptRejectionReason(prompt: string): string | null {
  if (!prompt.trim()) return "Nothing to stash.";
  if (prompt.length > MAX_STASH_PROMPT_CHARS) {
    return `Prompt is too large to stash (max ${MAX_STASH_PROMPT_CHARS.toLocaleString()} characters).`;
  }
  return null;
}

/** Safe localStorage access — SecurityError when storage is blocked must not crash render. */
export function getPromptStashStorage(
  scope: { localStorage?: PromptStashStorage } | null | undefined = typeof window === "undefined"
    ? null
    : window,
): PromptStashStorage | null {
  if (!scope) return null;
  try {
    const storage = scope.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage;
  } catch {
    return null;
  }
}

/**
 * Resolve the operator-bound stash namespace.
 * - remote session id when paired
 * - managed operator key (`tenantId:displayName`) when provided
 * - otherwise `local` for the single-operator desktop/loopback case
 *
 * Managed scope must identify the person, not only the tenant: shared
 * browser profiles in the same tenant must not read each other's drafts.
 */
export function resolvePromptStashScope(
  input: {
    remoteSessionId?: string | null;
    /** Managed operator key — prefer `tenantId:displayName`, not tenant alone. */
    tenantId?: string | null;
  } = {},
): string {
  const remote = input.remoteSessionId?.trim();
  if (remote) return `remote:${remote}`;
  const operator = input.tenantId?.trim();
  if (operator) return `managed:${operator}`;
  return "local";
}

/** Encode scope so distinct identities never collide after sanitization. */
export function promptStashStorageKey(scope: string = "local"): string {
  const normalized = scope.trim() || "local";
  // base64url keeps the key charset-safe without lossy character folding.
  const encoded =
    typeof btoa === "function"
      ? btoa(unescape(encodeURIComponent(normalized)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
      : Buffer.from(normalized, "utf8").toString("base64url");
  return `${PROMPT_STASH_STORAGE_KEY_PREFIX}${encoded}`;
}

/**
 * Managed hosts intentionally omit a stable unique subject from the client
 * projection. Persisting managed drafts in browser storage would therefore
 * risk cross-user reads when display names collide or are reassigned. Keep
 * managed stashes in process memory only (survive thread switches in the same
 * SPA load; cleared on reload / account change). Local and remote scopes keep
 * durable storage, with remote keys cleared on logout.
 */
const managedMemoryBuckets = new Map<string, Map<string, string>>();

function memoryStorageForManagedScope(scope: string): PromptStashStorage {
  const store = () => {
    let bucket = managedMemoryBuckets.get(scope);
    if (!bucket) {
      bucket = new Map<string, string>();
      managedMemoryBuckets.set(scope, bucket);
    }
    return bucket;
  };
  return {
    getItem(key: string) {
      return store().get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store().set(key, value);
    },
    removeItem(key: string) {
      store().delete(key);
    },
  };
}

/** Drop every in-memory managed stash (account switch or explicit logout). */
export function clearManagedPromptStashes(): void {
  managedMemoryBuckets.clear();
}

export function getPromptStashBackend(
  scope: string = "local",
  windowLike: {
    localStorage?: PromptStashStorage;
    sessionStorage?: PromptStashStorage;
  } | null = typeof window === "undefined" ? null : window,
): PromptStashStorage | null {
  if (scope.startsWith("managed:")) {
    return memoryStorageForManagedScope(scope);
  }
  return getPromptStashStorage(windowLike);
}

export function readRemoteSessionIdForStash(
  storage: PromptStashStorage | null | undefined,
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(REMOTE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.sessionId !== "string") return null;
    const sessionId = parsed.sessionId.trim();
    if (!sessionId) return null;
    if (typeof parsed.expiresAt === "string" && Date.parse(parsed.expiresAt) <= Date.now()) {
      return null;
    }
    return sessionId;
  } catch {
    return null;
  }
}

export function resolveActivePromptStashScope(
  storage: PromptStashStorage | null | undefined,
  tenantId?: string | null,
): string {
  return resolvePromptStashScope({
    remoteSessionId: readRemoteSessionIdForStash(storage),
    tenantId,
  });
}

function decodePromptStashScopeFromKey(key: string): string | null {
  if (!key.startsWith(PROMPT_STASH_STORAGE_KEY_PREFIX)) return null;
  const encoded = key.slice(PROMPT_STASH_STORAGE_KEY_PREFIX.length);
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    if (typeof atob === "function") {
      return decodeURIComponent(escape(atob(padded + pad)));
    }
    return Buffer.from(padded + pad, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Drop remote-scoped stashes after logout/revoke so the next pair cannot read them. */
export function clearRemotePromptStashes(storage: PromptStashStorage | null | undefined): void {
  if (!storage) return;
  try {
    const removable: string[] = [];
    // Storage.length / key() are available on real localStorage; memory mocks may omit them.
    const length = "length" in storage ? Number((storage as Storage).length) : 0;
    if (typeof (storage as Storage).key === "function" && Number.isFinite(length)) {
      for (let index = 0; index < length; index += 1) {
        const key = (storage as Storage).key(index);
        if (!key || !key.startsWith(PROMPT_STASH_STORAGE_KEY_PREFIX)) continue;
        const scope = decodePromptStashScopeFromKey(key);
        if (scope?.startsWith("remote:")) removable.push(key);
      }
    }
    for (const key of removable) {
      try {
        storage.removeItem(key);
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

export function createPromptStashEntry(
  prompt: string,
  options: { id?: string; createdAt?: string } = {},
): PromptStashEntry | null {
  const normalized = normalizeStashPrompt(prompt);
  if (normalized === null) return null;
  return {
    id: options.id ?? `stash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    prompt: normalized,
  };
}

export function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (!trimmed) return "(empty)";
  return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
}

/** Pure insert: newest first, hard cap, optional eviction of the oldest. */
export function insertStashEntry(
  entries: ReadonlyArray<PromptStashEntry>,
  entry: PromptStashEntry,
  max = MAX_STASH_ENTRIES,
): { entries: PromptStashEntry[]; evicted: PromptStashEntry | null } {
  const withoutDup = entries.filter((item) => item.id !== entry.id);
  const next = [entry, ...withoutDup];
  if (next.length <= max) {
    return { entries: next, evicted: null };
  }
  const kept = next.slice(0, max);
  const evicted = next[max] ?? null;
  return { entries: kept, evicted };
}

export function removeStashEntry(
  entries: ReadonlyArray<PromptStashEntry>,
  entryId: string,
): { entries: PromptStashEntry[]; removed: PromptStashEntry | null } {
  const removed = entries.find((item) => item.id === entryId) ?? null;
  if (!removed) return { entries: [...entries], removed: null };
  return {
    entries: entries.filter((item) => item.id !== entryId),
    removed,
  };
}

export function parsePromptStashState(raw: string | null | undefined): PromptStashEntry[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return [];
    if (parsed.version !== PROMPT_STASH_STORAGE_VERSION) return [];
    if (!Array.isArray(parsed.entries)) return [];
    const entries: PromptStashEntry[] = [];
    for (const item of parsed.entries) {
      if (!isPromptStashEntry(item)) continue;
      const prompt = normalizeStashPrompt(item.prompt);
      if (prompt === null) continue;
      entries.push({
        id: item.id,
        createdAt: item.createdAt,
        prompt,
      });
      if (entries.length >= MAX_STASH_ENTRIES) break;
    }
    return entries;
  } catch {
    return [];
  }
}

export function serializePromptStashState(entries: ReadonlyArray<PromptStashEntry>): string {
  const state: PromptStashState = {
    version: PROMPT_STASH_STORAGE_VERSION,
    entries: entries.slice(0, MAX_STASH_ENTRIES).map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      prompt: entry.prompt,
    })),
  };
  return JSON.stringify(state);
}

export function readPromptStash(
  storage: PromptStashStorage | null | undefined,
  scope: string = "local",
): PromptStashEntry[] {
  if (!storage) return [];
  try {
    const key = promptStashStorageKey(scope);
    const scoped = parsePromptStashState(storage.getItem(key));
    // One-time migration: unscoped v1 data becomes the local operator stash.
    if (scoped.length === 0 && scope === "local") {
      const legacy = parsePromptStashState(storage.getItem(PROMPT_STASH_STORAGE_KEY));
      if (legacy.length > 0) {
        try {
          storage.setItem(key, serializePromptStashState(legacy));
          storage.removeItem(PROMPT_STASH_STORAGE_KEY);
        } catch {
          // Keep reading legacy payload if migration write fails.
        }
        return legacy;
      }
    }
    return scoped;
  } catch {
    return [];
  }
}

export function writePromptStash(
  storage: PromptStashStorage | null | undefined,
  entries: ReadonlyArray<PromptStashEntry>,
  scope: string = "local",
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(promptStashStorageKey(scope), serializePromptStashState(entries));
    if (scope === "local") {
      try {
        storage.removeItem(PROMPT_STASH_STORAGE_KEY);
      } catch {
        // best-effort cleanup of the unscoped legacy key
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function createPromptStash(
  scope: string = "local",
  windowLike: {
    localStorage?: PromptStashStorage;
    sessionStorage?: PromptStashStorage;
  } | null = typeof window === "undefined" ? null : window,
): PromptStash {
  const storage = getPromptStashBackend(scope, windowLike);
  const load = () => readPromptStash(storage, scope);
  const persist = (entries: PromptStashEntry[]) => writePromptStash(storage, entries, scope);

  return {
    load,
    stash(prompt) {
      const entries = load();
      const rejection = stashPromptRejectionReason(prompt);
      if (rejection) return { ok: false, entries, message: rejection };
      const entry = createPromptStashEntry(prompt);
      if (!entry) return { ok: false, entries, message: "Nothing to stash." };
      const nextEntries = insertStashEntry(entries, entry).entries;
      if (!persist(nextEntries)) {
        return {
          ok: false,
          entries,
          message: "Could not stash prompt (storage unavailable).",
        };
      }
      return { ok: true, entries: nextEntries, message: "Prompt stashed." };
    },
    restore(entryId, currentDraft) {
      const entries = load();
      const hasDraft = Boolean(currentDraft.trim());
      if (hasDraft) {
        const rejection = stashPromptRejectionReason(currentDraft);
        if (rejection) {
          return {
            ok: false,
            entries,
            message: `Cannot restore while the composer has a draft: ${rejection.replace(/\.$/, "")}.`,
          };
        }
      }
      const { entries: withoutTarget, removed } = removeStashEntry(entries, entryId);
      if (!removed) {
        return {
          ok: false,
          entries,
          message: "That stashed prompt is no longer available.",
        };
      }
      const parked = hasDraft ? createPromptStashEntry(currentDraft) : null;
      if (hasDraft && !parked) {
        return {
          ok: false,
          entries,
          message: "Cannot restore while the composer has a draft.",
        };
      }
      const nextEntries = parked ? insertStashEntry(withoutTarget, parked).entries : withoutTarget;
      if (!persist(nextEntries)) {
        return {
          ok: false,
          entries,
          message: "Could not update stash (storage unavailable).",
        };
      }
      return {
        ok: true,
        entries: nextEntries,
        prompt: removed.prompt,
        message: hasDraft ? "Current draft parked; stashed prompt restored." : "Prompt restored.",
      };
    },
    remove(entryId) {
      const entries = load();
      const { entries: nextEntries, removed } = removeStashEntry(entries, entryId);
      if (!removed) {
        return {
          ok: false,
          entries,
          message: "That stashed prompt is no longer available.",
        };
      }
      if (!persist(nextEntries)) {
        return {
          ok: false,
          entries,
          message: "Could not update stash (storage unavailable).",
        };
      }
      return { ok: true, entries: nextEntries, message: "Stashed prompt removed." };
    },
  };
}

/** True when Mod+S should act as stash (no shift/alt; key is s). */
export function matchesPromptStashShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}): boolean {
  if (event.repeat) return false;
  if (event.shiftKey || event.altKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key === "s" || event.key === "S";
}

export const PROMPT_STASH_SHORTCUT_LABEL = "⌘S / Ctrl+S";
