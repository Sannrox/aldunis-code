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
  setInterval(callback: () => void, delay: number): PictureInPictureCaptureTimer;
  clearInterval(handle: PictureInPictureCaptureTimer): void;
}

const nodeCaptureTimers: PictureInPictureCaptureTimers = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Run the expensive capture/encode/send pipeline only while the PiP window can
 * display its frames. Window lifecycle events remove the interval rather than
 * leaving a high-frequency no-op wakeup behind.
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
    if (timer) timers.clearInterval(timer);
    timer = null;
    captureAfterFlight = false;
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
    } finally {
      inFlight = false;
      if (captureAfterFlight && !disposed && observable()) {
        captureAfterFlight = false;
        void tick();
      }
    }
  };
  const resume = () => {
    pause();
    if (disposed || !observable()) return;
    void tick();
    timer = timers.setInterval(() => void tick(), PICTURE_IN_PICTURE_CAPTURE_INTERVAL_MS);
    timer.unref();
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
