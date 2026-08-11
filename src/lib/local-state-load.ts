/**
 * Coalesce concurrent POST /api/state/load callers (workbench list + boot).
 * The route returns lifecycle metadata without transcript bodies.
 * Does not long-cache: once the inflight settles, the next caller hits the
 * network so mutations stay visible.
 */

let inflight: Promise<unknown> | null = null;
const historyInflight = new Map<string, Promise<unknown>>();

function requestLocalStateProjection(): Promise<unknown> {
  return fetch("/api/state/load", { method: "POST" }).then(async (response) => {
    if (!response.ok) throw new Error("Local state could not be loaded.");
    return response.json();
  });
}

export async function loadLocalStateProjection(): Promise<unknown> {
  if (inflight) return inflight;
  inflight = requestLocalStateProjection().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Read after a mutation without reusing a snapshot that may have started
 * before that mutation completed.
 */
export function loadFreshLocalStateProjection(): Promise<unknown> {
  return requestLocalStateProjection();
}

function requestConversationHistory(
  threadId: string,
  knownSequence?: number,
): Promise<unknown | null> {
  return fetch("/api/state/conversations/history", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      ...(knownSequence === undefined ? {} : { knownSequence }),
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error("Conversation history could not be loaded.");
    if (response.status === 204) return null;
    return response.json();
  });
}

/**
 * Thread-scoped transcript for restore. Coalesces concurrent restores of the
 * same conversation (dual-pane) without long-caching.
 */
export async function loadConversationHistory(
  threadId: string,
  knownSequence?: number,
): Promise<unknown | null> {
  const requestKey = `${threadId}\0${knownSequence ?? "full"}`;
  const existing = historyInflight.get(requestKey);
  if (existing) return existing;
  const request = requestConversationHistory(threadId, knownSequence).finally(() => {
    historyInflight.delete(requestKey);
  });
  historyInflight.set(requestKey, request);
  return request;
}

/** Same as loadConversationHistory but never reuses an in-flight pre-mutation snapshot. */
export function loadFreshConversationHistory(threadId: string): Promise<unknown> {
  return requestConversationHistory(threadId);
}
