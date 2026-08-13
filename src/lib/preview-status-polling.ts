export const PREVIEW_STATUS_REFRESH_INTERVAL_MS = 1_000;

export interface PreviewPollingVisibility {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface PreviewPollingTimers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

const browserPreviewPollingTimers: PreviewPollingTimers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
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
  let timer: number | null = null;
  let inFlight = false;
  let disposed = false;

  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (disposed || visibility.visibilityState !== "visible") return;
    timer = timers.setTimeout(() => {
      timer = null;
      void run();
    }, PREVIEW_STATUS_REFRESH_INTERVAL_MS);
  };
  const run = async () => {
    if (disposed || visibility.visibilityState !== "visible") return;
    if (inFlight) return;
    inFlight = true;
    try {
      await refresh();
    } finally {
      inFlight = false;
      schedule();
    }
  };
  const start = () => {
    clear();
    if (disposed || visibility.visibilityState !== "visible") return;
    void run();
  };
  const onVisibilityChange = () => {
    if (visibility.visibilityState === "hidden") {
      clear();
      return;
    }
    start();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  start();
  return () => {
    disposed = true;
    clear();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
