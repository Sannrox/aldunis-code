/// <reference types="vite/client" />

interface Window {
  aldunisDesktopCapabilities?: {
    localApplication: boolean;
    directoryPicker: boolean;
    sharedBrowser: boolean;
    remoteConnectionControls: boolean;
  };
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
    listRemoteEnvironments: () => Promise<{
      id: string;
      label: string;
      transport: "endpoint" | "ssh";
      endpoint: string | null;
      sshTarget: string | null;
      remotePort: number;
      remoteCommand: string;
      preferredLocalPort: number | null;
      paired: boolean;
      createdAt: string;
      updatedAt: string;
      connected: boolean;
      localUrl: string | null;
    }[]>;
    saveRemoteEnvironment: (input: {
      id?: string;
      label: string;
      transport: "endpoint" | "ssh";
      endpoint?: string;
      pairingUrl?: string;
      sshTarget?: string;
      remotePort?: number;
      remoteCommand?: string;
    }) => Promise<{
      summary: {
        id: string;
        label: string;
        transport: "endpoint" | "ssh";
        endpoint: string | null;
        sshTarget: string | null;
        remotePort: number;
        remoteCommand: string;
        preferredLocalPort: number | null;
        paired: boolean;
        createdAt: string;
        updatedAt: string;
        connected: boolean;
        localUrl: string | null;
      };
      pairingUrl: string | null;
    }>;
    removeRemoteEnvironment: (id: string) => Promise<void>;
    connectRemoteEnvironment: (
      id: string,
      pairingUrl?: string | null,
      forcePair?: boolean,
    ) => Promise<{ id: string; url: string; localUrl: string | null }>;
    disconnectRemoteEnvironment: (id: string) => Promise<void>;
    useLocalEnvironment: () => Promise<void>;
    confirmRemoteEnvironmentPairing: () => Promise<boolean>;
    getCapabilities: () => Promise<NonNullable<Window["aldunisDesktopCapabilities"]>>;
  };
}
