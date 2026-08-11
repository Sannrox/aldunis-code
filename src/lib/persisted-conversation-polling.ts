export const PERSISTED_CONVERSATION_POLL_INTERVAL_MS = 10_000;
export const PERSISTED_CONVERSATION_RETRY_INTERVAL_MS = 5_000;

interface PollingVisibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface PollingTimers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

const browserTimers: PollingTimers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/**
 * Maintain one serialized fallback history poll. Wake events still refresh the
 * owning effect independently; this coordinator only bounds its timer fallback.
 */
export function startPersistedConversationPolling(
  refresh: () => Promise<boolean>,
  options: { background: boolean },
  visibility: PollingVisibility,
  timers: PollingTimers = browserTimers,
): () => void {
  let timer: number | null = null;
  let inFlight = false;
  let refreshAfterFlight = false;
  let disposed = false;

  const eligible = () => visibility.visibilityState === "visible" || options.background;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay: number) => {
    clear();
    if (disposed || !eligible()) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  };
  const run = async (force = false) => {
    if (disposed || (!force && !eligible())) return;
    if (inFlight) {
      refreshAfterFlight = true;
      return;
    }
    inFlight = true;
    let continuePolling = false;
    let delay = PERSISTED_CONVERSATION_POLL_INTERVAL_MS;
    try {
      continuePolling = await refresh();
    } catch {
      continuePolling = true;
      delay = PERSISTED_CONVERSATION_RETRY_INTERVAL_MS;
    } finally {
      inFlight = false;
      if (disposed) {
        refreshAfterFlight = false;
      } else if (refreshAfterFlight && eligible()) {
        refreshAfterFlight = false;
        void run();
      } else {
        refreshAfterFlight = false;
        if (continuePolling) schedule(delay);
      }
    }
  };
  const requestImmediate = () => {
    clear();
    void run();
  };
  const onVisibilityChange = () => {
    if (visibility.visibilityState !== "visible") {
      if (!options.background) {
        refreshAfterFlight = false;
        clear();
      }
      return;
    }
    requestImmediate();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  void run(true);
  return () => {
    disposed = true;
    refreshAfterFlight = false;
    clear();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
