export type DesktopWindowChromeOptions = {
  titleBarStyle: "default" | "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
};

/**
 * Keep the native window controls in a hidden-inset frame. The renderer adds a
 * dedicated macOS titlebar row beneath them so the app header remains a
 * separate, ordinary interactive surface. Other platforms retain their
 * default frame until they have a matching cross-platform control layout.
 */
export function windowChromeOptions(platform: string): DesktopWindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
    };
  }

  return { titleBarStyle: "default" };
}
