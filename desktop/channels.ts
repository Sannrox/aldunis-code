export const CHOOSE_DIRECTORY_CHANNEL = "aldunis:choose-directory";
export const REGISTER_BROWSER_VIEW_CHANNEL = "aldunis:browser-register-view";
export const UNREGISTER_BROWSER_VIEW_CHANNEL = "aldunis:browser-unregister-view";
export const BROWSER_PICTURE_IN_PICTURE_CHANNEL = "aldunis:browser-picture-in-picture";
export const BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL = "aldunis:browser-picture-in-picture-frame";
export const REMOTE_ENVIRONMENTS_LIST_CHANNEL = "aldunis:remote-environments-list";
export const REMOTE_ENVIRONMENT_SAVE_CHANNEL = "aldunis:remote-environment-save";
export const REMOTE_ENVIRONMENT_REMOVE_CHANNEL = "aldunis:remote-environment-remove";
export const REMOTE_ENVIRONMENT_CONNECT_CHANNEL = "aldunis:remote-environment-connect";
export const REMOTE_ENVIRONMENT_DISCONNECT_CHANNEL = "aldunis:remote-environment-disconnect";
export const REMOTE_ENVIRONMENT_LOCAL_CHANNEL = "aldunis:remote-environment-local";
export const REMOTE_ENVIRONMENT_CONFIRM_CHANNEL = "aldunis:remote-environment-confirm";
export const DESKTOP_CAPABILITIES_CHANNEL = "aldunis:desktop-capabilities";

export interface DesktopCapabilities {
  localApplication: boolean;
  directoryPicker: boolean;
  sharedBrowser: boolean;
  remoteConnectionControls: boolean;
}
