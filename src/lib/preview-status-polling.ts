export const PREVIEW_STATUS_REFRESH_INTERVAL_MS = 1_000;

export interface PreviewPollingVisibility {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PreviewPollingTimers {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(handle: number): void;
}

const browserPreviewPollingTimers: PreviewPollingTimers = {
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (handle) => window.clearInterval(handle),
};

/**
 * Poll one live preview projection only while its surface can be observed.
 * Visibility refreshes serialize behind an active request so a slow host never
 * accumulates status work.
 */
export function startPreviewStatusPolling(
  refresh: () => Promise<void>,
  visibility: PreviewPollingVisibility,
  timers: PreviewPollingTimers = browserPreviewPollingTimers,
): () => void {
  let interval: number | null = null;
  let inFlight = false;
  let refreshAfterFlight = false;
  let disposed = false;

  const clear = () => {
    if (interval !== null) timers.clearInterval(interval);
    interval = null;
  };
  const run = async () => {
    if (disposed || visibility.visibilityState !== "visible") return;
    if (inFlight) {
      refreshAfterFlight = true;
      return;
    }
    inFlight = true;
    try {
      await refresh();
    } finally {
      inFlight = false;
      if (refreshAfterFlight && !disposed && visibility.visibilityState === "visible") {
        refreshAfterFlight = false;
        void run();
      }
    }
  };
  const start = () => {
    clear();
    if (disposed || visibility.visibilityState !== "visible") return;
    void run();
    interval = timers.setInterval(() => void run(), PREVIEW_STATUS_REFRESH_INTERVAL_MS);
  };
  const onVisibilityChange = () => {
    if (visibility.visibilityState === "hidden") {
      refreshAfterFlight = false;
      clear();
      return;
    }
    start();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  start();
  return () => {
    disposed = true;
    refreshAfterFlight = false;
    clear();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
