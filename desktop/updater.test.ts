import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopUpdater,
  type DesktopUpdaterEngine,
  getDesktopUpdateDisabledReason,
} from "./updater.ts";

type EventListener = (...args: any[]) => void;

class FakeUpdaterEngine implements DesktopUpdaterEngine {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = true;
  checkResult: unknown = { updateInfo: { version: "0.2.0" } };
  checkError: Error | null = null;
  downloadError: Error | null = null;
  quitArguments: [boolean | undefined, boolean | undefined] | null = null;
  readonly listeners = new Map<string, Set<EventListener>>();

  on(event: string, listener: EventListener): this {
    const listeners = this.listeners.get(event) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: EventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  async checkForUpdates(): Promise<unknown> {
    if (this.checkError) throw this.checkError;
    return this.checkResult;
  }

  async downloadUpdate(): Promise<unknown> {
    if (this.downloadError) throw this.downloadError;
    return undefined;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitArguments = [isSilent, isForceRunAfter];
  }
}

function createUpdater(engine = new FakeUpdaterEngine(), overrides: Partial<ConstructorParameters<typeof DesktopUpdater>[0]> = {}) {
  return {
    engine,
    updater: new DesktopUpdater({
      engine,
      currentVersion: "0.1.0",
      platform: "darwin",
      isPackaged: true,
      hasUpdateManifest: true,
      isAppImage: false,
      scheduleChecks: false,
      ...overrides,
    }),
  };
}

test("desktop updater disables unsupported package contexts before touching the engine", () => {
  assert.equal(getDesktopUpdateDisabledReason({
    isPackaged: false,
    platform: "darwin",
    hasUpdateManifest: true,
    isAppImage: false,
  }), "development");
  assert.equal(getDesktopUpdateDisabledReason({
    isPackaged: true,
    platform: "linux",
    hasUpdateManifest: true,
    isAppImage: false,
  }), "linux-package");
  assert.equal(getDesktopUpdateDisabledReason({
    isPackaged: true,
    platform: "win32",
    hasUpdateManifest: false,
    isAppImage: false,
  }), "no-feed");

  const { engine, updater } = createUpdater(new FakeUpdaterEngine(), {
    isPackaged: false,
  });
  updater.start();
  assert.equal(updater.getState().phase, "disabled");
  assert.equal(engine.autoDownload, true);
});

test("desktop updater keeps checks explicit and exposes an available update", async () => {
  const engine = new FakeUpdaterEngine();
  const states: string[] = [];
  const { updater } = createUpdater(engine, {
    onState: (snapshot) => states.push(snapshot.phase),
  });

  updater.start();
  assert.equal(engine.autoDownload, false);
  assert.equal(engine.autoInstallOnAppQuit, false);
  assert.equal(engine.allowDowngrade, false);
  assert.equal(engine.allowPrerelease, false);

  const state = await updater.checkForUpdate();
  assert.equal(state.phase, "available");
  assert.equal(state.availableVersion, "0.2.0");
  assert.ok(states.includes("checking"));
  assert.ok(states.includes("available"));
});

test("desktop updater reports download progress and installs only after preparation", async () => {
  const engine = new FakeUpdaterEngine();
  let prepared = false;
  const { updater } = createUpdater(engine, {
    prepareForInstall: async () => {
      prepared = true;
    },
  });
  updater.start();
  await updater.checkForUpdate();

  engine.downloadUpdate = async () => {
    engine.emit("download-progress", { percent: 37 });
    engine.emit("update-downloaded", { version: "0.2.0", releaseName: "Desktop update" });
  };
  const downloaded = await updater.downloadUpdate();
  assert.equal(downloaded.phase, "downloaded");
  assert.equal(downloaded.progress, 100);
  assert.equal(downloaded.releaseName, "Desktop update");

  const installing = await updater.installUpdate();
  assert.equal(installing.phase, "installing");
  assert.equal(prepared, true);
  assert.deepEqual(engine.quitArguments, [false, true]);
});

test("desktop updater sanitizes feed errors and can be retried", async () => {
  const engine = new FakeUpdaterEngine();
  engine.checkError = new Error("https://token@example.invalid/private-feed");
  const { updater } = createUpdater(engine);
  updater.start();
  const failed = await updater.checkForUpdate();
  assert.equal(failed.phase, "error");
  assert.equal(failed.error, "The update check failed. Check your connection and try again.");
  assert.doesNotMatch(failed.error ?? "", /token|private-feed/);

  engine.checkError = null;
  engine.checkResult = { updateInfo: null };
  const retried = await updater.checkForUpdate();
  assert.equal(retried.phase, "idle");
});

test("desktop updater cleans event listeners and scheduled work", () => {
  const engine = new FakeUpdaterEngine();
  const timers: string[] = [];
  const scheduler = {
    setTimeout: () => "startup",
    setInterval: () => "poll",
    clearTimeout: (handle: unknown) => timers.push(`timeout:${String(handle)}`),
    clearInterval: (handle: unknown) => timers.push(`interval:${String(handle)}`),
  };
  const { updater } = createUpdater(engine, {
    scheduleChecks: true,
    startupDelayMs: 15_000,
    pollIntervalMs: 360_000,
    scheduler,
  });
  updater.start();
  assert.equal(engine.listeners.size, 6);
  updater.dispose();
  assert.deepEqual(timers, ["timeout:startup", "interval:poll"]);
  assert.equal(engine.listeners.size, 6);
  assert.equal([...engine.listeners.values()].every((listeners) => listeners.size === 0), true);
});
