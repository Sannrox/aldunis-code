import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalHost } from "../server/host.ts";
import { LocalStateStore } from "../server/state.ts";
import {
  RemoteEnvironmentManager,
  RemoteEnvironmentStore,
  type RemoteEnvironmentInput,
} from "./remote-environments.ts";
import {
  closeServer,
  DESKTOP_PROTOCOL,
  isLocalApplicationOrigin,
  isSupportedDeepLink,
  listenOnLoopback,
  selectedDirectoryPath,
} from "./lifecycle.ts";
import {
  BROWSER_PICTURE_IN_PICTURE_CHANNEL,
  CHECK_DESKTOP_UPDATE_CHANNEL,
  CHOOSE_DIRECTORY_CHANNEL,
  DESKTOP_CAPABILITIES_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
  DOWNLOAD_DESKTOP_UPDATE_CHANNEL,
  GET_DESKTOP_UPDATE_STATE_CHANNEL,
  INSTALL_DESKTOP_UPDATE_CHANNEL,
  REGISTER_BROWSER_VIEW_CHANNEL,
  REMOTE_ENVIRONMENT_CONFIRM_CHANNEL,
  REMOTE_ENVIRONMENT_CONNECT_CHANNEL,
  REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL,
  REMOTE_ENVIRONMENT_LOCAL_CHANNEL,
  REMOTE_ENVIRONMENT_REMOVE_CHANNEL,
  REMOTE_ENVIRONMENT_SAVE_CHANNEL,
  REMOTE_ENVIRONMENTS_LIST_CHANNEL,
  UNREGISTER_BROWSER_VIEW_CHANNEL,
  type DesktopCapabilities,
} from "./channels.ts";
import { SharedBrowserManager } from "./shared-browser.ts";
import { DesktopUpdater, resolveDesktopUpdateChannel, type DesktopUpdaterEngine } from "./updater.ts";
import { windowChromeOptions } from "./window-chrome.ts";

const applicationRoot = fileURLToPath(new URL("..", import.meta.url));
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;
let backend: ReturnType<typeof createLocalHost> | null = null;
let browserManager: SharedBrowserManager | null = null;
let remoteEnvironments: RemoteEnvironmentManager | null = null;
let localApplicationUrl: string | null = null;
let activeRemoteEnvironmentId: string | null = null;
let activeRemoteApplicationOrigin: string | null = null;
let approvedOrigins: Set<string> | null = null;
let releaseWriterLease: (() => Promise<void>) | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let shuttingDown = false;

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function handleDeepLink(value: string): void {
  if (isSupportedDeepLink(value)) showWindow();
}

async function closeLocalServices(): Promise<void> {
  const runningBackend = backend;
  backend = null;
  try {
    if (runningBackend?.listening) await closeServer(runningBackend);
    await remoteEnvironments?.close();
  } finally {
    const release = releaseWriterLease;
    releaseWriterLease = null;
    try {
      await release?.();
    } finally {
      browserManager?.closeAll();
    }
  }
}

async function prepareForUpdate(): Promise<void> {
  shuttingDown = true;
  desktopUpdater?.dispose();
  await closeLocalServices();
  if (window && !window.isDestroyed()) window.destroy();
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL);
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find(isSupportedDeepLink);
    if (deepLink) handleDeepLink(deepLink);
    showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    process.env.ALDUNIS_CODE_STATE_DIR = join(app.getPath("userData"), "state");
    app.setAppLogsPath();
    const state = new LocalStateStore();
    releaseWriterLease = await state.acquireWriterLease();
    const browser = new SharedBrowserManager(join(applicationRoot, "dist-electron", "preload.cjs"));
    browserManager = browser;
    remoteEnvironments = new RemoteEnvironmentManager(
      new RemoteEnvironmentStore(join(app.getPath("userData"), "remote-environments.v1.json")),
      (id) => {
        if (activeRemoteEnvironmentId !== id || !window || !localApplicationUrl || shuttingDown) return;
        if (activeRemoteApplicationOrigin) approvedOrigins?.delete(activeRemoteApplicationOrigin);
        activeRemoteEnvironmentId = null;
        activeRemoteApplicationOrigin = null;
        void window.loadURL(localApplicationUrl).catch((error: unknown) => {
          console.error("The local workbench could not be restored after the SSH connection closed.", error);
        });
      },
    );
    backend = createLocalHost(
      join(applicationRoot, "dist"),
      state,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      browser,
      join(applicationRoot, "dist-electron", "browser-mcp.mjs"),
    );
    localApplicationUrl = await listenOnLoopback(backend);
    approvedOrigins = new Set([new URL(localApplicationUrl).origin]);
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 920,
      minHeight: 640,
      show: false,
      ...windowChromeOptions(process.platform),
      webPreferences: {
        preload: join(applicationRoot, "dist-electron", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    browser.bindOwnerWindow(window);
    const isOwnerWindow = (event: Electron.IpcMainInvokeEvent): boolean => (
      Boolean(window && event.sender === window.webContents)
    );
    const isLocalApplicationWindow = (event: Electron.IpcMainInvokeEvent): boolean => (
      isOwnerWindow(event)
      && Boolean(window && event.senderFrame === window.webContents.mainFrame)
      && isLocalApplicationOrigin(event.senderFrame.url, localApplicationUrl)
    );
    const isActiveRemoteApplicationWindow = (event: Electron.IpcMainInvokeEvent): boolean => (
      isOwnerWindow(event)
      && Boolean(window && event.senderFrame === window.webContents.mainFrame)
      && isLocalApplicationOrigin(event.senderFrame.url, activeRemoteApplicationOrigin)
    );
    ipcMain.removeHandler(DESKTOP_CAPABILITIES_CHANNEL);
    ipcMain.handle(DESKTOP_CAPABILITIES_CHANNEL, (event): DesktopCapabilities => {
      if (isLocalApplicationWindow(event)) {
        return {
          localApplication: true,
          directoryPicker: true,
          sharedBrowser: true,
          remoteConnectionControls: true,
        };
      }
      if (isActiveRemoteApplicationWindow(event)) {
        return {
          localApplication: false,
          directoryPicker: false,
          sharedBrowser: false,
          remoteConnectionControls: true,
        };
      }
      return {
        localApplication: false,
        directoryPicker: false,
        sharedBrowser: false,
        remoteConnectionControls: false,
      };
    });
    desktopUpdater = new DesktopUpdater({
      engine: autoUpdater as unknown as DesktopUpdaterEngine,
      currentVersion: app.getVersion(),
      channel: resolveDesktopUpdateChannel(app.getVersion()),
      platform: process.platform,
      isPackaged: app.isPackaged,
      hasUpdateManifest: existsSync(join(process.resourcesPath, "app-update.yml")),
      isAppImage: process.platform !== "linux" || Boolean(process.env.APPIMAGE),
      disabledByEnvironment: process.env.ALDUNIS_CODE_DISABLE_UPDATES === "1",
      onState: (snapshot) => {
        if (
          window
          && localApplicationUrl
          && !window.isDestroyed()
          && !window.webContents.isDestroyed()
          && isLocalApplicationOrigin(window.webContents.getURL(), localApplicationUrl)
        ) {
          window.webContents.send(DESKTOP_UPDATE_STATE_CHANNEL, snapshot);
        }
      },
      prepareForInstall,
    });
    ipcMain.removeHandler(CHOOSE_DIRECTORY_CHANNEL);
    ipcMain.handle(CHOOSE_DIRECTORY_CHANNEL, async (event) => {
      if (!isLocalApplicationWindow(event) || !window) return null;
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      return selectedDirectoryPath(result);
    });
    ipcMain.removeHandler(REGISTER_BROWSER_VIEW_CHANNEL);
    ipcMain.handle(REGISTER_BROWSER_VIEW_CHANNEL, (event, value: unknown) => {
      if (!isLocalApplicationWindow(event) || !window || typeof value !== "object" || value === null) return false;
      const input = value as Record<string, unknown>;
      if (
        typeof input.sessionId !== "string"
        || typeof input.webContentsId !== "number"
        || typeof input.origin !== "string"
      ) return false;
      try {
        return browser.registerView(input.sessionId, input.webContentsId, input.origin);
      } catch {
        return false;
      }
    });
    ipcMain.removeHandler(UNREGISTER_BROWSER_VIEW_CHANNEL);
    ipcMain.handle(UNREGISTER_BROWSER_VIEW_CHANNEL, (event, value: unknown) => {
      if (!isLocalApplicationWindow(event) || !window || typeof value !== "object" || value === null) return null;
      const input = value as Record<string, unknown>;
      if (typeof input.sessionId === "string" && typeof input.webContentsId === "number") {
        browser.unregisterView(input.sessionId, input.webContentsId);
      }
      return null;
    });
    ipcMain.removeHandler(BROWSER_PICTURE_IN_PICTURE_CHANNEL);
    ipcMain.handle(BROWSER_PICTURE_IN_PICTURE_CHANNEL, async (event, value: unknown) => {
      if (!isLocalApplicationWindow(event) || !window || typeof value !== "object" || value === null) return false;
      const input = value as Record<string, unknown>;
      if (typeof input.sessionId !== "string" || typeof input.open !== "boolean") return false;
      try {
        await browser.setPictureInPicture(input.sessionId, input.open);
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENTS_LIST_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENTS_LIST_CHANNEL, async (event) => {
      if (!isLocalApplicationWindow(event) || !remoteEnvironments) return [];
      return remoteEnvironments.list();
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_SAVE_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_SAVE_CHANNEL, async (event, input: unknown) => {
      if (!isLocalApplicationWindow(event) || !remoteEnvironments) throw new Error("The desktop window is unavailable.");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A remote environment is required.");
      return remoteEnvironments.save(input as RemoteEnvironmentInput);
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_REMOVE_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_REMOVE_CHANNEL, async (event, id: unknown) => {
      if (!isLocalApplicationWindow(event) || !remoteEnvironments || typeof id !== "string") return;
      await remoteEnvironments.remove(id);
      if (activeRemoteEnvironmentId === id && localApplicationUrl) {
        const previousRemoteOrigin = activeRemoteApplicationOrigin;
        activeRemoteEnvironmentId = null;
        activeRemoteApplicationOrigin = null;
        if (previousRemoteOrigin) approvedOrigins?.delete(previousRemoteOrigin);
        await window?.loadURL(localApplicationUrl);
      }
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_CONNECT_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_CONNECT_CHANNEL, async (event, value: unknown) => {
      if (!isLocalApplicationWindow(event) || !remoteEnvironments || !window) throw new Error("The desktop window is unavailable.");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A remote environment id is required.");
      const input = value as { id?: unknown; pairingUrl?: unknown; forcePair?: unknown };
      if (typeof input.id !== "string") throw new Error("A remote environment id is required.");
      const previousEnvironmentId = activeRemoteEnvironmentId;
      const previousRemoteOrigin = activeRemoteApplicationOrigin;
      const previousUrl = window.webContents.getURL() || localApplicationUrl;
      const target = await remoteEnvironments.connect(
        input.id,
        typeof input.pairingUrl === "string" ? input.pairingUrl : null,
        input.forcePair === true,
      );
      const targetOrigin = new URL(target.url).origin;
      approvedOrigins?.add(targetOrigin);
      activeRemoteEnvironmentId = target.id;
      activeRemoteApplicationOrigin = targetOrigin;
      try {
        await window.loadURL(target.url);
      } catch (error) {
        activeRemoteEnvironmentId = previousEnvironmentId;
        activeRemoteApplicationOrigin = previousRemoteOrigin;
        if (target.id !== previousEnvironmentId) await remoteEnvironments.disconnect(target.id);
        if (targetOrigin !== previousRemoteOrigin && targetOrigin !== new URL(localApplicationUrl).origin) {
          approvedOrigins?.delete(targetOrigin);
        }
        try {
          await window.loadURL(previousUrl || localApplicationUrl);
        } catch {
          // Preserve the original navigation diagnostic for the caller.
        }
        throw error instanceof Error ? error : new Error("The remote workbench could not be loaded.");
      }
      if (previousEnvironmentId && previousEnvironmentId !== target.id) {
        await remoteEnvironments.disconnect(previousEnvironmentId);
        if (previousRemoteOrigin && previousRemoteOrigin !== targetOrigin) approvedOrigins?.delete(previousRemoteOrigin);
      }
      return target;
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL, async (event, id: unknown) => {
      if (!remoteEnvironments || typeof id !== "string") return;
      const canDisconnect = isLocalApplicationWindow(event)
        || (isActiveRemoteApplicationWindow(event) && id === activeRemoteEnvironmentId);
      if (!canDisconnect) return;
      await remoteEnvironments.disconnect(id);
      if (activeRemoteEnvironmentId === id && localApplicationUrl) {
        const previousRemoteOrigin = activeRemoteApplicationOrigin;
        activeRemoteEnvironmentId = null;
        activeRemoteApplicationOrigin = null;
        if (previousRemoteOrigin) approvedOrigins?.delete(previousRemoteOrigin);
        await window?.loadURL(localApplicationUrl);
      }
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_LOCAL_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_LOCAL_CHANNEL, async (event) => {
      if (
        (!isLocalApplicationWindow(event) && !isActiveRemoteApplicationWindow(event))
        || !remoteEnvironments
        || !localApplicationUrl
      ) return;
      await remoteEnvironments.close();
      if (activeRemoteApplicationOrigin) approvedOrigins?.delete(activeRemoteApplicationOrigin);
      activeRemoteEnvironmentId = null;
      activeRemoteApplicationOrigin = null;
      await window?.loadURL(localApplicationUrl);
    });
    ipcMain.removeHandler(REMOTE_ENVIRONMENT_CONFIRM_CHANNEL);
    ipcMain.handle(REMOTE_ENVIRONMENT_CONFIRM_CHANNEL, async (event) => {
      if (!isActiveRemoteApplicationWindow(event) || !remoteEnvironments || !activeRemoteEnvironmentId) return false;
      await remoteEnvironments.confirmPairing(activeRemoteEnvironmentId);
      return true;
    });
    ipcMain.removeHandler(GET_DESKTOP_UPDATE_STATE_CHANNEL);
    ipcMain.handle(GET_DESKTOP_UPDATE_STATE_CHANNEL, (event) => (
      isLocalApplicationWindow(event) ? desktopUpdater?.getState() ?? null : null
    ));
    ipcMain.removeHandler(CHECK_DESKTOP_UPDATE_CHANNEL);
    ipcMain.handle(CHECK_DESKTOP_UPDATE_CHANNEL, async (event) => (
      isLocalApplicationWindow(event) ? await desktopUpdater?.checkForUpdate() ?? null : null
    ));
    ipcMain.removeHandler(DOWNLOAD_DESKTOP_UPDATE_CHANNEL);
    ipcMain.handle(DOWNLOAD_DESKTOP_UPDATE_CHANNEL, async (event) => (
      isLocalApplicationWindow(event) ? await desktopUpdater?.downloadUpdate() ?? null : null
    ));
    ipcMain.removeHandler(INSTALL_DESKTOP_UPDATE_CHANNEL);
    ipcMain.handle(INSTALL_DESKTOP_UPDATE_CHANNEL, async (event) => (
      isLocalApplicationWindow(event) ? await desktopUpdater?.installUpdate() ?? null : null
    ));
    desktopUpdater.start();
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      try {
        if (!approvedOrigins?.has(new URL(url).origin)) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    window.once("ready-to-show", showWindow);
    await window.loadURL(localApplicationUrl);
    const initialDeepLink = process.argv.find(isSupportedDeepLink);
    if (initialDeepLink) handleDeepLink(initialDeepLink);
  }).catch((error: unknown) => {
    console.error("Aldunis Code could not start.", error);
    browserManager?.closeAll();
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (!shuttingDown) app.quit();
  });
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    desktopUpdater?.dispose();
    void closeLocalServices().finally(() => app.quit());
  });
}
