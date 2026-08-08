import type {
  DesktopUpdateChannel,
  DesktopUpdateDisabledReason,
  DesktopUpdateErrorStage,
  DesktopUpdatePhase,
  DesktopUpdateSnapshot,
} from "./update-contract.ts";

export const DESKTOP_UPDATE_STARTUP_DELAY_MS = 15_000;
export const DESKTOP_UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function resolveDesktopUpdateChannel(version: string): DesktopUpdateChannel {
  return /-nightly\.\d{8}\.[1-9]\d*$/u.test(version) ? "nightly" : "stable";
}

type UpdateEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "error"
  | "download-progress"
  | "update-downloaded";

type UpdateListener = (...args: any[]) => void;

export interface DesktopUpdaterEngine {
  channel: string | null;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on: (event: UpdateEvent, listener: UpdateListener) => unknown;
  removeListener: (event: UpdateEvent, listener: UpdateListener) => unknown;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
}

export interface DesktopUpdaterScheduler {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  setInterval: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  clearInterval: (handle: unknown) => void;
}

export interface DesktopUpdaterOptions {
  engine: DesktopUpdaterEngine;
  currentVersion: string;
  platform: string;
  isPackaged: boolean;
  hasUpdateManifest: boolean;
  isAppImage: boolean;
  disabledByEnvironment?: boolean;
  channel?: DesktopUpdateChannel;
  startupDelayMs?: number;
  pollIntervalMs?: number;
  scheduleChecks?: boolean;
  scheduler?: DesktopUpdaterScheduler;
  onState?: (snapshot: DesktopUpdateSnapshot) => void;
  prepareForInstall?: () => Promise<void>;
}

interface UpdateInfo {
  version: string;
  releaseName?: string;
  releaseDate?: string;
}

const defaultScheduler: DesktopUpdaterScheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

const ACTIVE_PHASES: ReadonlySet<DesktopUpdatePhase> = new Set([
  "checking",
  "downloading",
  "downloaded",
  "installing",
]);

export function getDesktopUpdateDisabledReason(options: {
  isPackaged: boolean;
  platform: string;
  hasUpdateManifest: boolean;
  isAppImage: boolean;
  disabledByEnvironment?: boolean;
}): DesktopUpdateDisabledReason | null {
  if (options.disabledByEnvironment) return "environment";
  if (!options.isPackaged) return "development";
  if (!options.hasUpdateManifest) return "no-feed";
  if (options.platform === "linux" && !options.isAppImage) return "linux-package";
  return null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function readUpdateInfo(value: unknown): UpdateInfo | null {
  const outer = objectRecord(value);
  const record = objectRecord(outer?.updateInfo) ?? outer;
  if (!record || typeof record.version !== "string" || record.version.length === 0) return null;
  return {
    version: record.version,
    ...(typeof record.releaseName === "string" ? { releaseName: record.releaseName } : {}),
    ...(typeof record.releaseDate === "string" ? { releaseDate: record.releaseDate } : {}),
  };
}

function readProgress(value: unknown): number | null {
  const record = objectRecord(value);
  if (!record || typeof record.percent !== "number" || !Number.isFinite(record.percent)) return null;
  return Math.max(0, Math.min(100, record.percent));
}

function safeUpdateError(stage: DesktopUpdateErrorStage): string {
  if (stage === "download") return "The update download failed. Check your connection and try again.";
  if (stage === "install") return "The update could not be installed. Try again later.";
  return "The update check failed. Check your connection and try again.";
}

export class DesktopUpdater {
  private readonly options: DesktopUpdaterOptions;
  private readonly scheduler: DesktopUpdaterScheduler;
  private readonly listeners = new Set<(snapshot: DesktopUpdateSnapshot) => void>();
  private readonly eventListeners = new Map<UpdateEvent, UpdateListener>();
  private state: DesktopUpdateSnapshot;
  private pendingUpdate: UpdateInfo | null = null;
  private startupTimer: unknown = null;
  private pollTimer: unknown = null;
  private started = false;
  private disposed = false;

  constructor(options: DesktopUpdaterOptions) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler;
    const disabledReason = getDesktopUpdateDisabledReason(options);
    const channel = options.channel ?? resolveDesktopUpdateChannel(options.currentVersion);
    this.state = {
      channel,
      currentVersion: options.currentVersion,
      phase: disabledReason ? "disabled" : "idle",
      ...(disabledReason ? { disabledReason } : {}),
    };
    if (options.onState) this.listeners.add(options.onState);
  }

  getState(): DesktopUpdateSnapshot {
    return { ...this.state };
  }

  subscribe(listener: (snapshot: DesktopUpdateSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.disposed || this.state.phase === "disabled") return;
    this.started = true;
    this.options.engine.channel = this.state.channel === "nightly" ? "nightly" : "latest";
    this.options.engine.autoDownload = false;
    this.options.engine.autoInstallOnAppQuit = false;
    this.options.engine.allowDowngrade = false;
    this.options.engine.allowPrerelease = this.state.channel === "nightly";
    this.registerEventListeners();

    if (this.options.scheduleChecks === false) return;
    const startupDelayMs = this.options.startupDelayMs ?? DESKTOP_UPDATE_STARTUP_DELAY_MS;
    const pollIntervalMs = this.options.pollIntervalMs ?? DESKTOP_UPDATE_POLL_INTERVAL_MS;
    if (startupDelayMs >= 0) {
      this.startupTimer = this.scheduler.setTimeout(() => {
        void this.checkForUpdate();
      }, startupDelayMs);
    }
    if (pollIntervalMs > 0) {
      this.pollTimer = this.scheduler.setInterval(() => {
        if (this.state.phase === "idle" || this.state.phase === "error") {
          void this.checkForUpdate();
        }
      }, pollIntervalMs);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startupTimer !== null) this.scheduler.clearTimeout(this.startupTimer);
    if (this.pollTimer !== null) this.scheduler.clearInterval(this.pollTimer);
    this.startupTimer = null;
    this.pollTimer = null;
    for (const [event, listener] of this.eventListeners) {
      this.options.engine.removeListener(event, listener);
    }
    this.eventListeners.clear();
    this.listeners.clear();
  }

  async checkForUpdate(): Promise<DesktopUpdateSnapshot> {
    if (this.disposed || this.state.phase === "disabled") return this.getState();
    if (ACTIVE_PHASES.has(this.state.phase)) return this.getState();
    if (!this.started) this.start();
    this.pendingUpdate = null;
    this.setState({
      phase: "checking",
      availableVersion: undefined,
      releaseName: undefined,
      releaseDate: undefined,
      progress: undefined,
      error: undefined,
      errorStage: undefined,
    });
    try {
      const result = await this.options.engine.checkForUpdates();
      if (this.disposed) return this.getState();
      if (this.state.phase !== "checking") return this.getState();
      const info = readUpdateInfo(result);
      if (info && info.version !== this.options.currentVersion) {
        this.setAvailable(info);
      } else {
        this.finishCheck("idle");
      }
    } catch {
      if (!this.disposed) {
        this.setState({
          phase: "error",
          error: safeUpdateError("check"),
          errorStage: "check",
          lastCheckedAt: new Date().toISOString(),
        });
      }
    }
    return this.getState();
  }

  async downloadUpdate(): Promise<DesktopUpdateSnapshot> {
    if (this.disposed || this.state.phase !== "available" || !this.pendingUpdate) return this.getState();
    this.setState({ phase: "downloading", progress: 0, error: undefined, errorStage: undefined });
    try {
      await this.options.engine.downloadUpdate();
      if (!this.disposed && this.state.phase === "downloading") {
        this.setState({
          phase: "downloaded",
          progress: 100,
          availableVersion: this.pendingUpdate.version,
          releaseName: this.pendingUpdate.releaseName,
          releaseDate: this.pendingUpdate.releaseDate,
        });
      }
    } catch {
      if (!this.disposed) {
        this.setState({ phase: "error", error: safeUpdateError("download"), errorStage: "download" });
      }
    }
    return this.getState();
  }

  async installUpdate(): Promise<DesktopUpdateSnapshot> {
    if (this.disposed || this.state.phase !== "downloaded") return this.getState();
    this.setState({ phase: "installing", error: undefined, errorStage: undefined });
    try {
      await this.options.prepareForInstall?.();
      if (this.disposed || this.state.phase !== "installing") return this.getState();
      this.options.engine.quitAndInstall(false, true);
    } catch {
      if (!this.disposed) {
        this.setState({
          phase: "error",
          error: safeUpdateError("install"),
          errorStage: "install",
        });
      }
    }
    return this.getState();
  }

  private registerEventListeners(): void {
    const listeners: Record<UpdateEvent, UpdateListener> = {
      "checking-for-update": () => {
        if (!this.disposed) this.setState({ phase: "checking", error: undefined, errorStage: undefined });
      },
      "update-available": (value: unknown) => {
        const info = readUpdateInfo(value);
        if (info && info.version !== this.options.currentVersion && !this.disposed) this.setAvailable(info);
      },
      "update-not-available": () => {
        if (!this.disposed) this.finishCheck("idle");
      },
      error: () => {
        if (!this.disposed) {
          const stage: DesktopUpdateErrorStage = this.state.phase === "downloading"
            ? "download"
            : this.state.phase === "installing"
              ? "install"
              : "check";
          this.setState({
            phase: "error",
            error: safeUpdateError(stage),
            errorStage: stage,
            lastCheckedAt: new Date().toISOString(),
          });
        }
      },
      "download-progress": (value: unknown) => {
        const progress = readProgress(value);
        if (progress !== null && !this.disposed) this.setState({ phase: "downloading", progress });
      },
      "update-downloaded": (value: unknown) => {
        const info = readUpdateInfo(value) ?? this.pendingUpdate;
        if (!info || this.disposed) return;
        this.pendingUpdate = info;
        this.setState({
          phase: "downloaded",
          progress: 100,
          availableVersion: info.version,
          releaseName: info.releaseName,
          releaseDate: info.releaseDate,
        });
      },
    };
    for (const [event, listener] of Object.entries(listeners) as [UpdateEvent, UpdateListener][]) {
      this.eventListeners.set(event, listener);
      this.options.engine.on(event, listener);
    }
  }

  private setAvailable(info: UpdateInfo): void {
    this.pendingUpdate = info;
    this.setState({
      phase: "available",
      availableVersion: info.version,
      releaseName: info.releaseName,
      releaseDate: info.releaseDate,
      progress: undefined,
      error: undefined,
      errorStage: undefined,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  private finishCheck(phase: "idle"): void {
    this.setState({
      phase,
      error: undefined,
      errorStage: undefined,
      progress: undefined,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  private setState(patch: Partial<DesktopUpdateSnapshot>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
