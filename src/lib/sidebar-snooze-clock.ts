export const SIDEBAR_SNOOZE_CLOCK_INTERVAL_MS = 60_000;
const MINIMUM_SNOOZE_CLOCK_DELAY_MS = 250;

export interface SidebarSnoozeClockVisibility {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface SidebarSnoozeClockTimers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

const browserTimers: SidebarSnoozeClockTimers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/**
 * Keep visible relative snooze labels current without waking a collapsed or
 * backgrounded Workbench. Conversation changes restart this scheduler with a
 * new immutable set of deadlines.
 */
export function startSidebarSnoozeClock(
  wakeTimes: readonly number[],
  onTick: (nowMs: number) => void,
  visibility: SidebarSnoozeClockVisibility = document,
  timers: SidebarSnoozeClockTimers = browserTimers,
  now: () => number = Date.now,
): () => void {
  let timer: number | null = null;
  let stopped = false;

  const clear = () => {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (stopped || visibility.visibilityState !== "visible") return;
    const current = now();
    const nextWake = wakeTimes
      .filter((wakeTime) => Number.isFinite(wakeTime) && wakeTime > current)
      .reduce((earliest, wakeTime) => Math.min(earliest, wakeTime), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextWake)) return;
    const delay = Math.min(
      Math.max(nextWake - current, MINIMUM_SNOOZE_CLOCK_DELAY_MS),
      SIDEBAR_SNOOZE_CLOCK_INTERVAL_MS,
    );
    timer = timers.setTimeout(() => {
      timer = null;
      onTick(now());
      schedule();
    }, delay);
  };
  const onVisibilityChange = () => {
    if (visibility.visibilityState !== "visible") {
      clear();
      return;
    }
    onTick(now());
    schedule();
  };

  visibility.addEventListener("visibilitychange", onVisibilityChange);
  if (visibility.visibilityState === "visible") onTick(now());
  schedule();
  return () => {
    stopped = true;
    clear();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
