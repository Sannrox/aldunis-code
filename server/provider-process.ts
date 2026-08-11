import type { ChildProcess } from "node:child_process";

interface ProviderTerminationTimer {
  unref(): void;
}

interface ProviderTerminationTimers {
  setTimeout(callback: () => void, delayMs: number): ProviderTerminationTimer;
  clearTimeout(timer: ProviderTerminationTimer): void;
}

interface ActiveTermination {
  timer: ProviderTerminationTimer | null;
  onClose: () => void;
  clearTimeout(timer: ProviderTerminationTimer): void;
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
  if (activeTerminations.has(child)) return;

  const active: ActiveTermination = {
    timer: null,
    onClose: () => releaseTermination(child, active),
    clearTimeout: (timer) => timers.clearTimeout(timer),
  };
  activeTerminations.set(child, active);
  child.once("close", active.onClose);
  try {
    child.kill("SIGTERM");
  } catch {
    releaseTermination(child, active);
    return;
  }
  if (activeTerminations.get(child) !== active) return;
  active.timer = timers.setTimeout(
    () => {
      releaseTermination(child, active);
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // The provider is already outside this host's process-control boundary.
      }
    },
    Math.max(0, graceMs),
  );
  active.timer.unref();
}

/** Test diagnostic without retaining the child independently of the WeakMap. */
export function hasPendingProviderTermination(child: ChildProcess): boolean {
  return activeTerminations.has(child);
}
