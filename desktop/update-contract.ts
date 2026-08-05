export type DesktopUpdateChannel = "stable" | "nightly";

export type DesktopUpdateDisabledReason =
  | "development"
  | "no-feed"
  | "linux-package"
  | "environment";

export type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface DesktopUpdateSnapshot {
  channel: DesktopUpdateChannel;
  currentVersion: string;
  phase: DesktopUpdatePhase;
  availableVersion?: string;
  releaseName?: string;
  releaseDate?: string;
  progress?: number;
  lastCheckedAt?: string;
  error?: string;
  disabledReason?: DesktopUpdateDisabledReason;
}

export interface DesktopUpdateApi {
  getUpdateState: () => Promise<DesktopUpdateSnapshot | null>;
  checkForUpdate: () => Promise<DesktopUpdateSnapshot | null>;
  downloadUpdate: () => Promise<DesktopUpdateSnapshot | null>;
  installUpdate: () => Promise<DesktopUpdateSnapshot | null>;
  onUpdateState: (listener: (snapshot: DesktopUpdateSnapshot) => void) => () => void;
}
