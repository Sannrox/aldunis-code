import { contextBridge, ipcRenderer } from "electron";
import {
  BROWSER_PICTURE_IN_PICTURE_CHANNEL,
  BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  CHOOSE_DIRECTORY_CHANNEL,
  DESKTOP_CAPABILITIES_CHANNEL,
  REGISTER_BROWSER_VIEW_CHANNEL,
  REMOTE_ENVIRONMENT_CONFIRM_CHANNEL,
  REMOTE_ENVIRONMENT_CONNECT_CHANNEL,
  REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL,
  REMOTE_ENVIRONMENT_LOCAL_CHANNEL,
  REMOTE_ENVIRONMENT_REMOVE_CHANNEL,
  REMOTE_ENVIRONMENT_SAVE_CHANNEL,
  REMOTE_ENVIRONMENTS_LIST_CHANNEL,
  UNREGISTER_BROWSER_VIEW_CHANNEL,
} from "./channels.ts";
import type {
  RemoteConnectionTarget,
  RemoteEnvironmentInput,
  RemoteEnvironmentSummary,
} from "./remote-environments.ts";

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
  listRemoteEnvironments: (): Promise<RemoteEnvironmentSummary[]> => (
    ipcRenderer.invoke(REMOTE_ENVIRONMENTS_LIST_CHANNEL)
  ),
  saveRemoteEnvironment: (input: RemoteEnvironmentInput): Promise<{
    summary: RemoteEnvironmentSummary;
    pairingUrl: string | null;
  }> => ipcRenderer.invoke(REMOTE_ENVIRONMENT_SAVE_CHANNEL, input),
  removeRemoteEnvironment: (id: string): Promise<void> => (
    ipcRenderer.invoke(REMOTE_ENVIRONMENT_REMOVE_CHANNEL, id)
  ),
  connectRemoteEnvironment: (
    id: string,
    pairingUrl?: string | null,
    forcePair?: boolean,
  ): Promise<RemoteConnectionTarget> => (
    ipcRenderer.invoke(REMOTE_ENVIRONMENT_CONNECT_CHANNEL, { id, pairingUrl, forcePair })
  ),
  disconnectRemoteEnvironment: (id: string): Promise<void> => (
    ipcRenderer.invoke(REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL, id)
  ),
  useLocalEnvironment: (): Promise<void> => ipcRenderer.invoke(REMOTE_ENVIRONMENT_LOCAL_CHANNEL),
  confirmRemoteEnvironmentPairing: (): Promise<boolean> => ipcRenderer.invoke(REMOTE_ENVIRONMENT_CONFIRM_CHANNEL),
  getCapabilities: (): Promise<import("./channels.ts").DesktopCapabilities> => (
    ipcRenderer.invoke(DESKTOP_CAPABILITIES_CHANNEL)
  ),
});
