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
import { CHOOSE_DIRECTORY_CHANNEL } from "./channels.ts";

const applicationRoot = fileURLToPath(new URL("..", import.meta.url));
const gotSingleInstanceLock = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;
let backend: ReturnType<typeof createLocalHost> | null = null;
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
    backend = createLocalHost(join(applicationRoot, "dist"), state);
    const applicationUrl = await listenOnLoopback(backend);
    const applicationOrigin = new URL(applicationUrl).origin;
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 920,
      minHeight: 640,
      show: false,
      webPreferences: {
        preload: join(applicationRoot, "dist-electron", "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    ipcMain.removeHandler(CHOOSE_DIRECTORY_CHANNEL);
    ipcMain.handle(CHOOSE_DIRECTORY_CHANNEL, async (event) => {
      if (!window || event.sender !== window.webContents) return null;
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
      });
      return selectedDirectoryPath(result);
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
    app.quit();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (shuttingDown || !backend?.listening) return;
    event.preventDefault();
    shuttingDown = true;
    void closeServer(backend)
      .then(() => releaseWriterLease?.())
      .finally(() => app.quit());
  });
}
