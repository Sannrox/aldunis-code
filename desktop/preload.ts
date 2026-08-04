import { contextBridge, ipcRenderer } from "electron";
import {
  BROWSER_PICTURE_IN_PICTURE_CHANNEL,
  BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  CHOOSE_DIRECTORY_CHANNEL,
  REGISTER_BROWSER_VIEW_CHANNEL,
  UNREGISTER_BROWSER_VIEW_CHANNEL,
} from "./channels.ts";

contextBridge.exposeInMainWorld("aldunisDesktop", {
  platform: process.platform,
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(CHOOSE_DIRECTORY_CHANNEL),
  registerBrowserView: (sessionId: string, webContentsId: number, origin: string): Promise<boolean> => (
    ipcRenderer.invoke(REGISTER_BROWSER_VIEW_CHANNEL, { sessionId, webContentsId, origin })
  ),
  unregisterBrowserView: (sessionId: string, webContentsId: number): Promise<void> => (
    ipcRenderer.invoke(UNREGISTER_BROWSER_VIEW_CHANNEL, { sessionId, webContentsId })
  ),
  setBrowserPictureInPicture: (sessionId: string, open: boolean): Promise<boolean> => (
    ipcRenderer.invoke(BROWSER_PICTURE_IN_PICTURE_CHANNEL, { sessionId, open })
  ),
  onBrowserPictureInPictureFrame: (listener: (frame: {
    dataUrl: string;
    width: number;
    height: number;
  }) => void): (() => void) => {
    const callback = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (typeof value !== "object" || value === null) return;
      const frame = value as Record<string, unknown>;
      if (
        typeof frame.dataUrl !== "string"
        || typeof frame.width !== "number"
        || typeof frame.height !== "number"
      ) return;
      listener({ dataUrl: frame.dataUrl, width: frame.width, height: frame.height });
    };
    ipcRenderer.on(BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL, callback);
    return () => ipcRenderer.removeListener(BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL, callback);
  },
});
