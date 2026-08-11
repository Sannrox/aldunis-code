import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

export const DESKTOP_PROTOCOL = "aldunis-code";

export function selectedDirectoryPath(result: {
  canceled: boolean;
  filePaths: string[];
}): string | null {
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function localApplicationUrl(address: AddressInfo | string | null): string {
  if (!address || typeof address === "string") {
    throw new Error("The local backend did not provide a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

export function isLocalApplicationOrigin(frameUrl: string, applicationUrl: string | null): boolean {
  if (!applicationUrl) return false;
  try {
    return new URL(frameUrl).origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
}

export function isSupportedDeepLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${DESKTOP_PROTOCOL}:`;
  } catch {
    return false;
  }
}

export function shouldHideWindowOnClose(platform: string, shuttingDown: boolean): boolean {
  return platform === "darwin" && !shuttingDown;
}

export function isLiveDesktopWindow<T extends { isDestroyed(): boolean }>(
  candidate: T | null,
): candidate is T {
  return candidate !== null && !candidate.isDestroyed();
}

export async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  return localApplicationUrl(server.address());
}

export async function closeServer(server: Server, forceAfterMs = 1_000): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const forceClose = setTimeout(() => server.closeAllConnections(), forceAfterMs);
    forceClose.unref();
    server.close((error) => {
      clearTimeout(forceClose);
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function finishDesktopShutdown(options: {
  disposeUpdater: () => void;
  destroyWindow: () => void;
  closeServices: () => Promise<void>;
}): Promise<void> {
  options.disposeUpdater();
  // app.quit() emits before-quit before closing renderer windows. Disconnect
  // the renderer first so its loopback keep-alive cannot block server.close().
  options.destroyWindow();
  await options.closeServices();
}
