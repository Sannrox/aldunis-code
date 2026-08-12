import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export type PreviewState =
  "approval_pending" | "starting" | "running" | "stopping" | "stopped" | "failed";

export interface PreviewSnapshot {
  id: string;
  repository: string;
  worktree: string;
  command: string;
  origin: string;
  state: PreviewState;
  approvalExpiresAt: string | null;
  message: string | null;
}

interface PreviewRecord extends PreviewSnapshot {
  child: ChildProcess | null;
  approvalTimer: NodeJS.Timeout | null;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Keep terminal snapshots long enough for the 1s status poller to observe them. */
const TERMINAL_RETAIN_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const STOP_FORCE_MS = 2_000;

interface PreviewTerminationTimer {
  unref(): void;
}

export interface PreviewTerminationRuntime {
  platform: NodeJS.Platform;
  setTimeout(callback: () => void, delayMs: number): PreviewTerminationTimer;
  clearTimeout(timer: PreviewTerminationTimer): void;
  killProcessGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): void;
}

interface ActivePreviewTermination {
  timer: PreviewTerminationTimer | null;
  runtime: PreviewTerminationRuntime;
  onExit: () => void;
}

const defaultPreviewTerminationRuntime: PreviewTerminationRuntime = {
  platform: process.platform,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  },
};

const activePreviewTerminations = new WeakMap<ChildProcess, ActivePreviewTermination>();

function releasePreviewTermination(child: ChildProcess, expected?: ActivePreviewTermination): void {
  const active = activePreviewTerminations.get(child);
  if (!active || (expected && active !== expected)) return;
  activePreviewTerminations.delete(child);
  child.off("exit", active.onExit);
  child.off("close", active.onExit);
  if (active.timer) active.runtime.clearTimeout(active.timer);
  active.timer = null;
}

/** End one bounded attempt so a still-live failed preview can be stopped again. */
export function releasePreviewTerminationAttempt(child: ChildProcess): void {
  releasePreviewTermination(child);
}

function signalPreviewChild(
  child: ChildProcess,
  pid: number | undefined,
  signal: NodeJS.Signals,
  runtime: PreviewTerminationRuntime,
): boolean {
  if (runtime.platform !== "win32" && pid !== undefined) {
    try {
      runtime.killProcessGroup(pid, signal);
      return true;
    } catch {
      // Fall back to the exact child when its process group is already unavailable.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/**
 * Terminate npm and its descendants. Posix spawns use a new process group so
 * SIGTERM/SIGKILL can target the whole tree; Windows uses taskkill /T.
 */
export function terminatePreviewProcess(
  child: ChildProcess,
  runtime: PreviewTerminationRuntime = defaultPreviewTerminationRuntime,
): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    releasePreviewTermination(child);
    return;
  }
  if (activePreviewTerminations.has(child)) return;

  const active: ActivePreviewTermination = {
    timer: null,
    runtime,
    onExit: () => releasePreviewTermination(child, active),
  };
  activePreviewTerminations.set(child, active);
  child.once("exit", active.onExit);
  child.once("close", active.onExit);

  const pid = child.pid;
  if (runtime.platform === "win32") {
    if (typeof pid === "number") {
      try {
        runtime.killWindowsTree(pid);
      } catch {
        releasePreviewTermination(child, active);
      }
      return;
    }
    if (!signalPreviewChild(child, undefined, "SIGTERM", runtime)) {
      releasePreviewTermination(child, active);
    }
    return;
  }

  if (!signalPreviewChild(child, pid, "SIGTERM", runtime)) {
    releasePreviewTermination(child, active);
    return;
  }
  if (activePreviewTerminations.get(child) !== active) return;
  active.timer = runtime.setTimeout(() => {
    if (activePreviewTerminations.get(child) !== active) return;
    active.timer = null;
    if (child.exitCode !== null || child.signalCode !== null) {
      releasePreviewTermination(child, active);
      return;
    }
    signalPreviewChild(child, pid, "SIGKILL", runtime);
  }, STOP_FORCE_MS);
  active.timer.unref();
}

/** Test diagnostic without retaining the child outside its lifecycle. */
export function hasPendingPreviewTermination(child: ChildProcess): boolean {
  return activePreviewTerminations.has(child);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

export class PreviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function assertPreviewOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PreviewError("Preview URL must be a valid loopback HTTP(S) origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_NAMES.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new PreviewError("Preview navigation is limited to loopback HTTP(S) origins.", 403);
  }
  return url.origin;
}

async function developmentCommand(worktree: string): Promise<{ command: string; args: string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
  } catch {
    throw new PreviewError("The selected worktree has no readable package.json.", 404);
  }
  const scripts =
    typeof value === "object" && value !== null ? (value as { scripts?: unknown }).scripts : null;
  const dev =
    typeof scripts === "object" && scripts !== null
      ? (scripts as Record<string, unknown>).dev
      : null;
  if (typeof dev !== "string" || !dev.trim()) {
    throw new PreviewError("The selected worktree does not declare a development script.", 404);
  }
  return { command: "npm run dev", args: ["run", "dev"] };
}

export class PreviewManager {
  readonly #previews = new Map<string, PreviewRecord>();

  async requestStart(
    repository: string,
    worktree: string,
    originInput: string,
  ): Promise<PreviewSnapshot> {
    const origin = assertPreviewOrigin(originInput);
    const { command } = await developmentCommand(worktree);
    for (const preview of this.#previews.values()) {
      if (
        preview.worktree === worktree &&
        ["approval_pending", "starting", "running", "stopping"].includes(preview.state)
      ) {
        throw new PreviewError("This worktree already has an active preview.", 409);
      }
    }
    const id = randomUUID();
    const record: PreviewRecord = {
      id,
      repository,
      worktree,
      command,
      origin,
      state: "approval_pending",
      approvalExpiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
      message: null,
      child: null,
      approvalTimer: null,
    };
    record.approvalTimer = setTimeout(() => {
      if (record.state === "approval_pending") {
        record.state = "failed";
        record.message = "Start approval expired.";
        record.approvalExpiresAt = null;
        this.#scheduleRelease(record);
      }
    }, APPROVAL_TIMEOUT_MS);
    record.approvalTimer.unref();
    this.#previews.set(id, record);
    return this.#snapshot(record);
  }

  decide(
    id: string,
    context: { repository: string; worktree: string },
    decision: "allow_once" | "deny",
  ): PreviewSnapshot {
    const preview = this.#get(id);
    if (preview.repository !== context.repository || preview.worktree !== context.worktree) {
      throw new PreviewError(
        "Preview approval is bound to a different repository or worktree.",
        403,
      );
    }
    if (preview.state !== "approval_pending") {
      throw new PreviewError("Preview approval has already been resolved.", 409);
    }
    if (preview.approvalTimer) clearTimeout(preview.approvalTimer);
    preview.approvalTimer = null;
    preview.approvalExpiresAt = null;
    if (decision === "deny") {
      preview.state = "stopped";
      preview.message = "Start denied.";
      const snapshot = this.#snapshot(preview);
      this.#release(preview);
      return snapshot;
    }
    this.#start(preview);
    return this.#snapshot(preview);
  }

  snapshot(id: string): PreviewSnapshot {
    return this.#snapshot(this.#get(id));
  }

  async stop(
    id: string,
    context: { repository: string; worktree: string },
  ): Promise<PreviewSnapshot> {
    const preview = this.#get(id);
    if (preview.repository !== context.repository || preview.worktree !== context.worktree) {
      throw new PreviewError("Preview is bound to a different repository or worktree.", 403);
    }
    if (preview.state === "approval_pending") {
      if (preview.approvalTimer) clearTimeout(preview.approvalTimer);
      preview.approvalTimer = null;
      preview.approvalExpiresAt = null;
      preview.state = "stopped";
      preview.message = "Start cancelled.";
      const cancelled = this.#snapshot(preview);
      this.#release(preview);
      return cancelled;
    }
    if (!preview.child || !["starting", "running", "failed"].includes(preview.state)) {
      throw new PreviewError("Preview is not running.", 409);
    }
    preview.state = "stopping";
    const child = preview.child;
    terminatePreviewProcess(child);
    if (!(await waitForExit(child, STOP_GRACE_MS + STOP_FORCE_MS))) {
      // This bounded termination attempt is over. Release its idempotence
      // guard so the failed snapshot's documented later-stop retry can signal
      // the still-live process tree again.
      releasePreviewTerminationAttempt(child);
      preview.state = "failed";
      preview.message = "The development process did not stop after SIGTERM/SIGKILL.";
      const failed = this.#snapshot(preview);
      // Keep the record while the child may still be alive so a later stop can
      // still target it; only release when the process handle is cleared.
      return failed;
    }
    preview.child = null;
    preview.state = "stopped";
    preview.message = null;
    const stopped = this.#snapshot(preview);
    this.#release(preview);
    return stopped;
  }

  /**
   * Host shutdown: stop every preview process tree and drop in-memory records.
   * Best-effort; does not throw when a child has already exited.
   */
  async stopAll(): Promise<void> {
    const records = [...this.#previews.values()];
    await Promise.all(
      records.map(async (preview) => {
        if (preview.approvalTimer) {
          clearTimeout(preview.approvalTimer);
          preview.approvalTimer = null;
        }
        const child = preview.child;
        if (child && child.exitCode === null && child.signalCode === null) {
          preview.state = "stopping";
          terminatePreviewProcess(child);
          if (!(await waitForExit(child, STOP_GRACE_MS + STOP_FORCE_MS))) {
            releasePreviewTerminationAttempt(child);
          }
        }
        preview.child = null;
        this.#release(preview);
      }),
    );
  }

  #start(preview: PreviewRecord): void {
    preview.state = "starting";
    const executable = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(executable, ["run", "dev"], {
      cwd: preview.worktree,
      env: { ...process.env, BROWSER: "none" },
      shell: false,
      // New process group on POSIX so stop/kill reaches npm and its vite child.
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    preview.child = child;
    child.once("spawn", () => {
      if (preview.state === "starting") void this.#awaitReady(preview);
    });
    child.once("error", () => {
      preview.state = "failed";
      preview.message = "The configured development command could not be started.";
      preview.child = null;
      // Retain the terminal snapshot so the status poller can observe failure.
      this.#scheduleRelease(preview);
    });
    child.once("exit", (code, signal) => {
      if (preview.state === "stopping" || preview.state === "stopped") return;
      if (preview.state === "failed" && preview.child === null) return;
      preview.state = code === 0 ? "stopped" : "failed";
      preview.message =
        code === 0
          ? "The development process exited."
          : `The development process exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}).`;
      preview.child = null;
      // Retain so the UI poller can leave starting/running for a real terminal state.
      this.#scheduleRelease(preview);
    });
  }

  async #awaitReady(preview: PreviewRecord): Promise<void> {
    const deadline = Date.now() + 8_000;
    while (preview.state === "starting" && Date.now() < deadline) {
      try {
        await fetch(preview.origin, { signal: AbortSignal.timeout(600) });
        if (preview.state === "starting") preview.state = "running";
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (preview.state !== "starting") return;
    preview.state = "failed";
    preview.message = `The development server is unavailable at ${preview.origin}.`;
    if (preview.child) terminatePreviewProcess(preview.child);
    preview.child = null;
    this.#scheduleRelease(preview);
  }

  #get(id: string): PreviewRecord {
    const preview = this.#previews.get(id);
    if (!preview) throw new PreviewError("Preview session does not exist.", 404);
    return preview;
  }

  #scheduleRelease(preview: PreviewRecord): void {
    if (preview.approvalTimer) {
      clearTimeout(preview.approvalTimer);
      preview.approvalTimer = null;
    }
    const timer = setTimeout(() => {
      if (
        this.#previews.get(preview.id) === preview &&
        !preview.child &&
        (preview.state === "stopped" || preview.state === "failed")
      ) {
        this.#release(preview);
      }
    }, TERMINAL_RETAIN_MS);
    timer.unref();
  }

  #release(preview: PreviewRecord): void {
    if (preview.approvalTimer) {
      clearTimeout(preview.approvalTimer);
      preview.approvalTimer = null;
    }
    this.#previews.delete(preview.id);
  }

  #snapshot(preview: PreviewRecord): PreviewSnapshot {
    const { child: _child, approvalTimer: _approvalTimer, ...snapshot } = preview;
    return { ...snapshot };
  }
}
