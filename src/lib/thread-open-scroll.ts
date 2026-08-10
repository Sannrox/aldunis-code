/**
 * Where a conversation should place the transcript viewport on open.
 * - latest: always pin to the newest content (default chat behavior)
 * - remember: restore the operator's last scroll place for that thread
 */
export type ConversationOpenScroll = "latest" | "remember";

export const CONVERSATION_OPEN_SCROLL_VALUES = ["latest", "remember"] as const;

export const THREAD_SCROLL_POSITION_STORAGE_KEY = "aldunis.thread.scrollPositions.v1";

/** Cap stored positions so localStorage does not grow without bound. */
export const THREAD_SCROLL_POSITION_MAX_ENTRIES = 100;

export interface ThreadScrollSnapshot {
  /** Operator was holding the tail when they left. */
  following: boolean;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  updatedAt: number;
}

export type ThreadScrollPositionMap = Record<string, ThreadScrollSnapshot>;

export function isConversationOpenScroll(value: unknown): value is ConversationOpenScroll {
  return value === "latest" || value === "remember";
}

export function shouldRestoreThreadScrollOnOpen(
  preference: ConversationOpenScroll,
  snapshot: ThreadScrollSnapshot | null | undefined,
): boolean {
  return preference === "remember" && snapshot != null && snapshot.following !== true;
}

/**
 * Map a saved scroll place onto the current container size.
 * Uses the previous scroll ratio so modest content-height changes still land near the same place.
 */
export function restoreThreadScrollTop(
  target: { scrollTop: number; clientHeight: number; scrollHeight: number },
  snapshot: ThreadScrollSnapshot,
): void {
  if (snapshot.following) {
    target.scrollTop = target.scrollHeight;
    return;
  }
  const previousMax = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
  const currentMax = Math.max(0, target.scrollHeight - target.clientHeight);
  if (previousMax <= 0 || currentMax <= 0) {
    target.scrollTop = 0;
    return;
  }
  const ratio = Math.min(1, Math.max(0, snapshot.scrollTop / previousMax));
  target.scrollTop = Math.round(ratio * currentMax);
}

export function snapshotThreadScroll(metrics: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  following: boolean;
  now?: number;
}): ThreadScrollSnapshot {
  return {
    following: metrics.following,
    scrollTop: Math.max(0, metrics.scrollTop),
    clientHeight: Math.max(0, metrics.clientHeight),
    scrollHeight: Math.max(0, metrics.scrollHeight),
    updatedAt: metrics.now ?? Date.now(),
  };
}

export function parseThreadScrollPositionMap(
  raw: string | null | undefined,
): ThreadScrollPositionMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: ThreadScrollPositionMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id || typeof id !== "string") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const body = value as Record<string, unknown>;
      if (typeof body.following !== "boolean") continue;
      if (typeof body.scrollTop !== "number" || !Number.isFinite(body.scrollTop)) continue;
      if (typeof body.clientHeight !== "number" || !Number.isFinite(body.clientHeight)) continue;
      if (typeof body.scrollHeight !== "number" || !Number.isFinite(body.scrollHeight)) continue;
      if (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)) continue;
      result[id] = {
        following: body.following,
        scrollTop: Math.max(0, body.scrollTop),
        clientHeight: Math.max(0, body.clientHeight),
        scrollHeight: Math.max(0, body.scrollHeight),
        updatedAt: body.updatedAt,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function pruneThreadScrollPositionMap(
  map: ThreadScrollPositionMap,
  maxEntries = THREAD_SCROLL_POSITION_MAX_ENTRIES,
): ThreadScrollPositionMap {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return map;
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export function readThreadScrollPosition(
  conversationId: string | null | undefined,
  storage: Pick<Storage, "getItem"> | null | undefined,
  key = THREAD_SCROLL_POSITION_STORAGE_KEY,
): ThreadScrollSnapshot | null {
  if (!conversationId || !storage) return null;
  try {
    const map = parseThreadScrollPositionMap(storage.getItem(key));
    return map[conversationId] ?? null;
  } catch {
    return null;
  }
}

export function writeThreadScrollPosition(
  conversationId: string | null | undefined,
  snapshot: ThreadScrollSnapshot,
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined,
  key = THREAD_SCROLL_POSITION_STORAGE_KEY,
  maxEntries = THREAD_SCROLL_POSITION_MAX_ENTRIES,
): void {
  if (!conversationId || !storage) return;
  try {
    const map = pruneThreadScrollPositionMap(
      {
        ...parseThreadScrollPositionMap(storage.getItem(key)),
        [conversationId]: snapshot,
      },
      maxEntries,
    );
    storage.setItem(key, JSON.stringify(map));
  } catch {
    /* Ignore private-mode and quota failures; open still works with latest. */
  }
}

export function clearThreadScrollPosition(
  conversationId: string | null | undefined,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined,
  key = THREAD_SCROLL_POSITION_STORAGE_KEY,
): void {
  if (!conversationId || !storage) return;
  try {
    const map = parseThreadScrollPositionMap(storage.getItem(key));
    if (!(conversationId in map)) return;
    delete map[conversationId];
    if (Object.keys(map).length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(map));
  } catch {
    /* Ignore storage failures. */
  }
}
