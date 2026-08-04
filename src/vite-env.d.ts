/// <reference types="vite/client" />

interface Window {
  aldunisDesktop?: {
    platform: string;
    chooseDirectory: () => Promise<string | null>;
    registerBrowserView: (sessionId: string, webContentsId: number, origin: string) => Promise<boolean>;
    unregisterBrowserView: (sessionId: string, webContentsId: number) => Promise<void>;
    setBrowserPictureInPicture: (sessionId: string, open: boolean) => Promise<boolean>;
    onBrowserPictureInPictureFrame: (listener: (frame: {
      dataUrl: string;
      width: number;
      height: number;
    }) => void) => () => void;
  };
}
