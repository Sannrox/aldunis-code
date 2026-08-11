/**
 * Coalesce concurrent POST /api/state/load callers (workbench list + boot).
 * The route returns lifecycle metadata without transcript bodies.
 * Does not long-cache: once the inflight settles, the next caller hits the
 * network so mutations stay visible.
 */

let inflight: Promise<unknown> | null = null;
const historyInflight = new Map<string, Promise<unknown>>();
let activeHistoryRequests = 0;
export const LOCAL_STATE_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_INFLIGHT_HISTORY_REQUESTS = 8;

interface LocalStateRequestOptions {
  timeoutMs?: number;
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: ((reason: Error) => void) | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new Error(timeoutMessage));
  }, timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), timeoutResult]);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requestLocalStateProjection(): Promise<unknown> {
  return withDeadline(
    async (signal) => {
      const response = await fetch("/api/state/load", { method: "POST", signal });
      if (!response.ok) throw new Error("Local state could not be loaded.");
      return response.json();
    },
    LOCAL_STATE_REQUEST_TIMEOUT_MS,
    "Local state request timed out.",
  );
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
  options: LocalStateRequestOptions = {},
): Promise<unknown | null> {
  return withDeadline(
    async (signal) => {
      const response = await fetch("/api/state/conversations/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          ...(knownSequence === undefined ? {} : { knownSequence }),
        }),
        signal,
      });
      if (!response.ok) throw new Error("Conversation history could not be loaded.");
      if (response.status === 204) return null;
      return response.json();
    },
    options.timeoutMs ?? LOCAL_STATE_REQUEST_TIMEOUT_MS,
    "Conversation history request timed out.",
  );
}

async function requestBoundedConversationHistory(
  threadId: string,
  knownSequence?: number,
  options: LocalStateRequestOptions = {},
): Promise<unknown | null> {
  if (activeHistoryRequests >= MAX_INFLIGHT_HISTORY_REQUESTS) {
    throw new Error("Too many conversation history requests are already active.");
  }
  activeHistoryRequests += 1;
  try {
    return await requestConversationHistory(threadId, knownSequence, options);
  } finally {
    activeHistoryRequests -= 1;
  }
}

/**
 * Thread-scoped transcript for restore. Coalesces concurrent restores of the
 * same conversation (dual-pane) without long-caching.
 */
export async function loadConversationHistory(
  threadId: string,
  knownSequence?: number,
  options: LocalStateRequestOptions = {},
): Promise<unknown | null> {
  const timeoutMs = options.timeoutMs ?? LOCAL_STATE_REQUEST_TIMEOUT_MS;
  const requestKey = `${threadId}\0${knownSequence ?? "full"}\0${timeoutMs}`;
  const existing = historyInflight.get(requestKey);
  if (existing) return existing;
  const request = requestBoundedConversationHistory(threadId, knownSequence, options).finally(
    () => {
      historyInflight.delete(requestKey);
    },
  );
  historyInflight.set(requestKey, request);
  return request;
}

/** Same as loadConversationHistory but never reuses an in-flight pre-mutation snapshot. */
export function loadFreshConversationHistory(
  threadId: string,
  options: LocalStateRequestOptions = {},
): Promise<unknown> {
  return requestBoundedConversationHistory(threadId, undefined, options);
}
