import type { ChildProcess } from "node:child_process";

export interface ProviderTerminationTimer {
  unref(): void;
}

export interface ProviderTerminationTimers {
  setTimeout(callback: () => void, delayMs: number): ProviderTerminationTimer;
  clearTimeout(timer: ProviderTerminationTimer): void;
}

interface ActiveTermination {
  phase: "scheduled" | "terminating";
  timer: ProviderTerminationTimer | null;
  graceMs: number;
  onClose: () => void;
  clearTimeout(timer: ProviderTerminationTimer): void;
  setTimeout(callback: () => void, delayMs: number): ProviderTerminationTimer;
}

const activeTerminations = new WeakMap<ChildProcess, ActiveTermination>();

const defaultTimers: ProviderTerminationTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

function releaseTermination(child: ChildProcess, expected?: ActiveTermination): void {
  const active = activeTerminations.get(child);
  if (!active || (expected && active !== expected)) return;
  activeTerminations.delete(child);
  child.off("close", active.onClose);
  if (active.timer) active.clearTimeout(active.timer);
  active.timer = null;
}

function createTermination(
  child: ChildProcess,
  phase: ActiveTermination["phase"],
  graceMs: number,
  timers: ProviderTerminationTimers,
): ActiveTermination {
  const active: ActiveTermination = {
    phase,
    timer: null,
    graceMs: Math.max(0, graceMs),
    onClose: () => releaseTermination(child, active),
    clearTimeout: (timer) => timers.clearTimeout(timer),
    setTimeout: (callback, delayMs) => timers.setTimeout(callback, delayMs),
  };
  activeTerminations.set(child, active);
  child.once("close", active.onClose);
  return active;
}

function requestTermination(child: ChildProcess, active: ActiveTermination): void {
  if (activeTerminations.get(child) !== active) return;
  active.phase = "terminating";
  if (child.exitCode !== null || child.signalCode !== null) {
    releaseTermination(child, active);
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    releaseTermination(child, active);
    return;
  }
  if (activeTerminations.get(child) !== active) return;
  active.timer = active.setTimeout(() => {
    releaseTermination(child, active);
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      // The provider is already outside this host's process-control boundary.
    }
  }, active.graceMs);
  active.timer.unref();
}

/** Request bounded provider shutdown once per exact child. */
export function terminateProviderChild(
  child: ChildProcess,
  graceMs = 2_000,
  timers: ProviderTerminationTimers = defaultTimers,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    releaseTermination(child);
    return;
  }
  const existing = activeTerminations.get(child);
  if (existing?.phase === "terminating") return;
  if (existing) {
    if (existing.timer) existing.clearTimeout(existing.timer);
    existing.timer = null;
    requestTermination(child, existing);
    return;
  }
  requestTermination(child, createTermination(child, "terminating", graceMs, timers));
}

/** Schedule bounded provider shutdown, coalescing repeated requests by exact child. */
export function scheduleProviderChildTermination(
  child: ChildProcess,
  delayMs: number,
  graceMs = 2_000,
  timers: ProviderTerminationTimers = defaultTimers,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    releaseTermination(child);
    return;
  }
  if (activeTerminations.has(child)) return;
  const active = createTermination(child, "scheduled", graceMs, timers);
  active.timer = active.setTimeout(
    () => {
      active.timer = null;
      requestTermination(child, active);
    },
    Math.max(0, delayMs),
  );
  active.timer.unref();
}

/** Test diagnostic without retaining the child independently of the WeakMap. */
export function hasPendingProviderTermination(child: ChildProcess): boolean {
  return activeTerminations.has(child);
}
