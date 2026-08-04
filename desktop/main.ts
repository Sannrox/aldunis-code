import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalHost } from "../server/host.ts";
import { LocalStateStore } from "../server/state.ts";
import {
  closeServer,
  DESKTOP_PROTOCOL,
  isSupportedDeepLink,
  listenOnLoopback,
  selectedDirectoryPath,
} from "./lifecycle.ts";
import {
  BROWSER_PICTURE_IN_PICTURE_CHANNEL,
  CHOOSE_DIRECTORY_CHANNEL,
  REGISTER_BROWSER_VIEW_CHANNEL,
  UNREGISTER_BROWSER_VIEW_CHANNEL,
} from "./channels.ts";
import { SharedBrowserManager } from "./shared-browser.ts";
import { windowChromeOptions } from "./window-chrome.ts";

const applicationRoot = fileURLToPath(new URL("..", import.meta.url));
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;
let backend: ReturnType<typeof createLocalHost> | null = null;
let browserManager: SharedBrowserManager | null = null;
let releaseWriterLease: (() => Promise<void>) | null = null;
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
    const applicationUrl = await listenOnLoopback(backend);
    const applicationOrigin = new URL(applicationUrl).origin;
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
    ipcMain.removeHandler(CHOOSE_DIRECTORY_CHANNEL);
    ipcMain.handle(CHOOSE_DIRECTORY_CHANNEL, async (event) => {
      if (!window || event.sender !== window.webContents) return null;
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      return selectedDirectoryPath(result);
    });
    ipcMain.removeHandler(REGISTER_BROWSER_VIEW_CHANNEL);
    ipcMain.handle(REGISTER_BROWSER_VIEW_CHANNEL, (event, value: unknown) => {
      if (!window || event.sender !== window.webContents || typeof value !== "object" || value === null) return false;
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
      if (!window || event.sender !== window.webContents || typeof value !== "object" || value === null) return null;
      const input = value as Record<string, unknown>;
      if (typeof input.sessionId === "string" && typeof input.webContentsId === "number") {
        browser.unregisterView(input.sessionId, input.webContentsId);
      }
      return null;
    });
    ipcMain.removeHandler(BROWSER_PICTURE_IN_PICTURE_CHANNEL);
    ipcMain.handle(BROWSER_PICTURE_IN_PICTURE_CHANNEL, async (event, value: unknown) => {
      if (!window || event.sender !== window.webContents || typeof value !== "object" || value === null) return false;
      const input = value as Record<string, unknown>;
      if (typeof input.sessionId !== "string" || typeof input.open !== "boolean") return false;
      try {
        await browser.setPictureInPicture(input.sessionId, input.open);
        return true;
      } catch {
        return false;
      }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      try {
        if (new URL(url).origin !== applicationOrigin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    window.once("ready-to-show", showWindow);
    await window.loadURL(applicationUrl);
    const initialDeepLink = process.argv.find(isSupportedDeepLink);
    if (initialDeepLink) handleDeepLink(initialDeepLink);
  }).catch((error: unknown) => {
    console.error("Aldunis Code could not start.", error);
    browserManager?.closeAll();
    app.quit();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (shuttingDown || !backend?.listening) return;
    event.preventDefault();
    shuttingDown = true;
    void closeServer(backend)
      .then(() => releaseWriterLease?.())
      .finally(() => {
        browserManager?.closeAll();
        app.quit();
      });
  });
}
