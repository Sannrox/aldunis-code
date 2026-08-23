export const PICTURE_IN_PICTURE_CAPTURE_FPS = 12;
export const PICTURE_IN_PICTURE_CAPTURE_INTERVAL_MS = Math.round(
  1_000 / PICTURE_IN_PICTURE_CAPTURE_FPS,
);

type CaptureWindowEvent = "show" | "restore" | "hide" | "minimize" | "closed";

export interface PictureInPictureCaptureWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: CaptureWindowEvent, listener: () => void): void;
  removeListener(event: CaptureWindowEvent, listener: () => void): void;
}

export interface PictureInPictureCaptureTimer {
  unref(): void;
}

export interface PictureInPictureCaptureTimers {
  setTimeout(callback: () => void, delay: number): PictureInPictureCaptureTimer;
  clearTimeout(handle: PictureInPictureCaptureTimer): void;
}

const nodeCaptureTimers: PictureInPictureCaptureTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Run the expensive capture/encode/send pipeline only while the PiP window can
 * display its frames. Each frame schedules the next only after capture settles,
 * leaving the configured cadence as a quiet period between expensive frames.
 */
export function startPictureInPictureCapture(
  window: PictureInPictureCaptureWindow,
  capture: () => Promise<void>,
  timers: PictureInPictureCaptureTimers = nodeCaptureTimers,
): () => void {
  let timer: PictureInPictureCaptureTimer | null = null;
  let inFlight = false;
  let captureAfterFlight = false;
  let disposed = false;

  const observable = () => !window.isDestroyed() && window.isVisible() && !window.isMinimized();
  const pause = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    captureAfterFlight = false;
  };
  const schedule = () => {
    if (timer || disposed || !observable()) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void tick();
    }, PICTURE_IN_PICTURE_CAPTURE_INTERVAL_MS);
    timer.unref();
  };
  const tick = async () => {
    if (disposed || !observable()) return;
    if (inFlight) {
      captureAfterFlight = true;
      return;
    }
    inFlight = true;
    try {
      await capture();
    } catch {
      // A transient capture failure must not stop subsequent visible frames.
    } finally {
      inFlight = false;
      if (captureAfterFlight && !disposed && observable()) {
        captureAfterFlight = false;
        void tick();
      } else {
        schedule();
      }
    }
  };
  const resume = () => {
    pause();
    if (disposed || !observable()) return;
    void tick();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pause();
    window.removeListener("show", resume);
    window.removeListener("restore", resume);
    window.removeListener("hide", pause);
    window.removeListener("minimize", pause);
    window.removeListener("closed", dispose);
  };

  window.on("show", resume);
  window.on("restore", resume);
  window.on("hide", pause);
  window.on("minimize", pause);
  window.on("closed", dispose);
  resume();
  return dispose;
}
