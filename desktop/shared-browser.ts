import { BrowserWindow, webContents, type WebContents } from "electron";
import {
  assertBrowserUrl,
  MAX_ACTIVE_SHARED_BROWSER_SESSIONS,
  type BrowserHost,
  type BrowserHostResult,
  type BrowserHostState,
  type BrowserOperation,
} from "../server/browser.ts";
import { BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL } from "./channels.ts";
import { startPictureInPictureCapture } from "./picture-in-picture-capture.ts";

const MAX_SNAPSHOT_TEXT = 20_000;
const MAX_SNAPSHOT_ELEMENTS = 100;
const MAX_SCREENSHOT_BYTES = 512_000;

type AgentInput =
  | { kind: "key"; type: "keyDown"; key: string }
  | { kind: "mouse"; type: "mouseDown"; x: number; y: number; button: "left" };

class BrowserControlChangedError extends Error {
  constructor() {
    super("The operator took control of the shared browser.");
    this.name = "BrowserControlChangedError";
  }
}

interface BrowserEntry {
  sessionId: string;
  origin: string;
  contents: WebContents | null;
  debuggerReady: boolean;
  controlEpoch: number;
  controller: "none" | "human" | "agent";
  error: string | null;
  pendingAgentInputs: AgentInput[];
  actions: Array<{ kind: string; at: string }>;
  pictureInPicture: BrowserWindow | null;
  stopCapture: (() => void) | null;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "")) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isApprovedPageUrl(value: string, approvedOrigin: string): boolean {
  if (!isLoopbackUrl(value)) return false;
  try {
    return new URL(value).origin === new URL(approvedOrigin).origin;
  } catch {
    return false;
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function pictureInPictureDocument(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; background: #101216; }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #101216; }
  body { display: grid; place-items: center; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; background: #101216; }
  #empty { color: #9aa3b2; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
</style>
<div id="empty">Waiting for the shared browser…</div>
<img id="preview-frame" alt="Shared browser picture-in-picture" hidden>
<script>
  const empty = document.getElementById("empty");
  const frame = document.getElementById("preview-frame");
  const deliver = (value) => window.dispatchEvent(new CustomEvent("aldunis-browser-frame", { detail: value }));
  window.aldunisDesktop?.onBrowserPictureInPictureFrame?.(deliver);
  window.addEventListener("aldunis-browser-frame", (event) => {
    const value = event.detail;
    if (!value || typeof value.dataUrl !== "string") return;
    frame.src = value.dataUrl;
    frame.hidden = false;
    empty.hidden = true;
    if (typeof value.width === "number" && typeof value.height === "number" && value.width > 0 && value.height > 0) {
      document.documentElement.style.aspectRatio = value.width + " / " + value.height;
    }
  });
</script>`;
}

export class SharedBrowserManager implements BrowserHost {
  readonly #entries = new Map<string, BrowserEntry>();
  #ownerWindow: BrowserWindow | null = null;

  constructor(private readonly preloadPath: string | null = null) {}

  bindOwnerWindow(ownerWindow: BrowserWindow): void {
    this.#ownerWindow = ownerWindow;
    ownerWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const partition = typeof params.partition === "string" ? params.partition : "";
      if (
        params.src !== "about:blank" ||
        !/^persist:aldunis-browser-[0-9a-f]{32}$/.test(partition)
      ) {
        event.preventDefault();
        return;
      }
      Reflect.deleteProperty(webPreferences, "preload");
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
    ownerWindow.webContents.on("did-attach-webview", (_event, guest) => {
      guest.setWindowOpenHandler(() => ({ action: "deny" }));
      guest.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      guest.session.setPermissionCheckHandler(() => false);
      guest.on("will-navigate", (event, url) => {
        if (!isLoopbackUrl(url)) event.preventDefault();
      });
      guest.on("will-redirect", (event, url) => {
        if (!isLoopbackUrl(url)) event.preventDefault();
      });
    });
  }

  registerView(sessionId: string, guestId: number, originInput: string): boolean {
    const origin = assertBrowserUrl(originInput);
    const guest = webContents.fromId(guestId);
    if (!guest || guest.isDestroyed() || guest.hostWebContents !== this.#ownerWindow?.webContents)
      return false;
    const existing = this.#entries.get(sessionId);
    if (existing && new URL(existing.origin).origin !== new URL(origin).origin) return false;
    if (!existing && this.#entries.size >= MAX_ACTIVE_SHARED_BROWSER_SESSIONS) return false;
    const shouldConfigure = !existing || existing.contents !== guest;
    const entry =
      existing ??
      ({
        sessionId,
        origin,
        contents: null,
        debuggerReady: false,
        controlEpoch: 0,
        controller: "none",
        error: null,
        pendingAgentInputs: [],
        actions: [],
        pictureInPicture: null,
        stopCapture: null,
      } satisfies BrowserEntry);
    entry.origin = origin;
    entry.contents = guest;
    entry.error = null;
    entry.controller = "human";
    this.#entries.set(sessionId, entry);
    if (shouldConfigure) {
      this.#configureGuest(entry, guest);
      void guest.loadURL(origin).catch((error: unknown) => {
        entry.error =
          error instanceof Error
            ? error.message.slice(0, 240)
            : "The shared browser could not load the preview.";
      });
    }
    void this.#enableDebugger(entry);
    return true;
  }

  unregisterView(sessionId: string, guestId?: number): void {
    const entry = this.#entries.get(sessionId);
    if (!entry || (guestId !== undefined && entry.contents?.id !== guestId)) return;
    entry.contents = null;
    entry.debuggerReady = false;
    entry.controller = "none";
    this.#stopCapture(entry);
  }

  async getState(sessionId: string): Promise<BrowserHostState> {
    const entry = this.#entries.get(sessionId);
    if (!entry) {
      return {
        connected: false,
        url: null,
        title: null,
        controller: "none",
        controlEpoch: 0,
        error: null,
      };
    }
    const contents = entry.contents;
    const url = contents && !contents.isDestroyed() ? contents.getURL() : null;
    const title = contents && !contents.isDestroyed() ? contents.getTitle() : null;
    return {
      connected: Boolean(contents && !contents.isDestroyed() && entry.debuggerReady),
      url: url && isApprovedPageUrl(url, entry.origin) ? url : entry.origin,
      title: title || null,
      controller: entry.controller,
      controlEpoch: entry.controlEpoch,
      error: entry.error,
    };
  }

  async execute(
    sessionId: string,
    operation: BrowserOperation,
    expectedControlEpoch: number,
  ): Promise<BrowserHostResult> {
    const entry = this.#entries.get(sessionId);
    const contents = entry?.contents;
    if (!entry || !contents || contents.isDestroyed() || !entry.debuggerReady) {
      return {
        ok: false,
        code: "browser_view_unavailable",
        message: "The shared browser view is not connected.",
      };
    }
    if (entry.controlEpoch !== expectedControlEpoch) {
      entry.controller = "human";
      return {
        ok: false,
        code: "browser_human_control",
        message: "The operator took control of the shared browser.",
      };
    }
    try {
      if (operation.kind === "status") {
        return { ok: true, kind: "status", state: await this.getState(sessionId) };
      }
      if (operation.kind === "snapshot")
        return { ok: true, kind: "snapshot", snapshot: await this.#snapshot(entry) };
      if (operation.kind === "navigate") {
        const url = assertBrowserUrl(operation.url);
        if (!isApprovedPageUrl(url, entry.origin)) {
          return {
            ok: false,
            code: "browser_origin_denied",
            message: "Shared browser navigation is limited to the approved preview origin.",
          };
        }
        await this.#command(entry, "Page.navigate", { url }, expectedControlEpoch);
        if (!this.#completeAgentAction(entry, expectedControlEpoch)) return this.#controlChanged();
        this.#recordAction(entry, operation.kind);
        return {
          ok: true,
          kind: "action",
          message: `Navigated to ${new URL(url).origin}${new URL(url).pathname}`,
          state: await this.getState(sessionId),
        };
      }
      if (operation.kind === "click") {
        if (operation.selector) {
          const result = await this.#evaluate(
            entry,
            `(() => {
            const element = document.querySelector(${safeJson(operation.selector)});
            if (!element) return { error: "The requested element is not present." };
            element.scrollIntoView({ block: "center", inline: "center" });
            element.click();
            return { ok: true };
          })()`,
            expectedControlEpoch,
          );
          if (result?.error)
            return {
              ok: false,
              code: "browser_element_missing",
              message: String(result.error).slice(0, 240),
            };
        } else {
          await this.#sendMouse(
            entry,
            "mousePressed",
            operation.x!,
            operation.y!,
            expectedControlEpoch,
          );
          await this.#sendMouse(
            entry,
            "mouseReleased",
            operation.x!,
            operation.y!,
            expectedControlEpoch,
          );
        }
        if (!this.#completeAgentAction(entry, expectedControlEpoch)) return this.#controlChanged();
        this.#recordAction(entry, operation.kind);
        return {
          ok: true,
          kind: "action",
          message: "Clicked the requested page element.",
          state: await this.getState(sessionId),
        };
      }
      if (operation.kind === "type") {
        await this.#command(
          entry,
          "Input.insertText",
          { text: operation.text },
          expectedControlEpoch,
        );
        if (!this.#completeAgentAction(entry, expectedControlEpoch)) return this.#controlChanged();
        this.#recordAction(entry, operation.kind);
        return {
          ok: true,
          kind: "action",
          message: "Inserted text into the focused page control.",
          state: await this.getState(sessionId),
        };
      }
      if (operation.kind === "press") {
        await this.#dispatchAgentInput(
          entry,
          { kind: "key", type: "keyDown", key: operation.key },
          "Input.dispatchKeyEvent",
          { type: "keyDown", key: operation.key },
          expectedControlEpoch,
        );
        await this.#command(
          entry,
          "Input.dispatchKeyEvent",
          { type: "keyUp", key: operation.key },
          expectedControlEpoch,
        );
        if (!this.#completeAgentAction(entry, expectedControlEpoch)) return this.#controlChanged();
        this.#recordAction(entry, operation.kind);
        return {
          ok: true,
          kind: "action",
          message: `Pressed ${operation.key}.`,
          state: await this.getState(sessionId),
        };
      }
      if (operation.kind === "scroll") {
        await this.#evaluate(
          entry,
          `window.scrollBy(${operation.x}, ${operation.y})`,
          expectedControlEpoch,
        );
        if (!this.#completeAgentAction(entry, expectedControlEpoch)) return this.#controlChanged();
        this.#recordAction(entry, operation.kind);
        return {
          ok: true,
          kind: "action",
          message: "Scrolled the shared browser.",
          state: await this.getState(sessionId),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, operation.milliseconds));
      return {
        ok: true,
        kind: "action",
        message: "Wait completed.",
        state: await this.getState(sessionId),
      };
    } catch (error) {
      if (error instanceof BrowserControlChangedError) return this.#controlChanged();
      entry.error =
        error instanceof Error ? error.message.slice(0, 240) : "The browser operation failed.";
      return { ok: false, code: "browser_operation_failed", message: entry.error };
    }
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    this.#stopCapture(entry);
    entry.pictureInPicture?.close();
    entry.pictureInPicture = null;
    if (entry.contents && !entry.contents.isDestroyed() && entry.debuggerReady) {
      try {
        entry.contents.debugger.detach();
      } catch {
        // The renderer may already have gone away.
      }
    }
    this.#entries.delete(sessionId);
  }

  setAgentControl(sessionId: string, enabled: boolean): void {
    const entry = this.#entries.get(sessionId);
    if (!entry) return;
    entry.controller = enabled ? "agent" : "human";
  }

  async setPictureInPicture(sessionId: string, open: boolean): Promise<void> {
    const entry = this.#entries.get(sessionId);
    if (!entry?.contents || entry.contents.isDestroyed()) {
      throw new Error("The shared browser view is not connected.");
    }
    if (!open) {
      this.#stopCapture(entry);
      entry.pictureInPicture?.close();
      entry.pictureInPicture = null;
      return;
    }
    if (entry.pictureInPicture && !entry.pictureInPicture.isDestroyed()) {
      entry.pictureInPicture.show();
      return;
    }
    const picture = new BrowserWindow({
      width: 480,
      height: 320,
      minWidth: 240,
      minHeight: 160,
      title: "Aldunis shared browser",
      alwaysOnTop: true,
      autoHideMenuBar: true,
      webPreferences: {
        ...(this.preloadPath ? { preload: this.preloadPath } : {}),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    entry.pictureInPicture = picture;
    picture.on("closed", () => {
      if (entry.pictureInPicture === picture) {
        entry.pictureInPicture = null;
        this.#stopCapture(entry);
      }
    });
    if (process.platform === "darwin")
      picture.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    picture.setSkipTaskbar(true);
    await picture.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(pictureInPictureDocument())}`,
    );
    picture.show();
    this.#startCapture(entry);
  }

  closeAll(): void {
    for (const entry of this.#entries.values()) {
      this.#stopCapture(entry);
      entry.pictureInPicture?.close();
    }
    this.#entries.clear();
  }

  #configureGuest(entry: BrowserEntry, contents: WebContents): void {
    const allow = (value: string) => isApprovedPageUrl(value, entry.origin);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    contents.session.setPermissionCheckHandler(() => false);
    contents.on("will-navigate", (event, url) => {
      if (!allow(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!allow(url)) event.preventDefault();
    });
    contents.on("before-input-event", (_event, input) => {
      if (
        input.type === "keyDown" &&
        this.#consumeAgentInput(entry, {
          kind: "key",
          type: "keyDown",
          key: input.key,
        })
      )
        return;
      if (input.type === "keyDown" || input.type === "mouseDown") {
        entry.controlEpoch += 1;
        entry.controller = "human";
      }
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (
        mouse.type === "mouseDown" &&
        mouse.button === "left" &&
        this.#consumeAgentInput(entry, {
          kind: "mouse",
          type: "mouseDown",
          x: mouse.x,
          y: mouse.y,
          button: "left",
        })
      )
        return;
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel") {
        entry.controlEpoch += 1;
        entry.controller = "human";
      }
    });
    contents.on("destroyed", () => this.unregisterView(entry.sessionId, contents.id));
  }

  async #enableDebugger(entry: BrowserEntry): Promise<void> {
    const contents = entry.contents;
    if (!contents || contents.isDestroyed()) return;
    try {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Page.enable");
      await contents.debugger.sendCommand("Runtime.enable");
      await contents.debugger.sendCommand("Accessibility.enable");
      entry.debuggerReady = true;
      entry.error = null;
    } catch (error) {
      entry.debuggerReady = false;
      entry.error =
        error instanceof Error
          ? error.message.slice(0, 240)
          : "The browser debugger could not attach.";
    }
  }

  async #command(
    entry: BrowserEntry,
    method: string,
    params: Record<string, unknown> = {},
    expectedControlEpoch?: number,
  ): Promise<any> {
    if (!entry.contents || entry.contents.isDestroyed() || !entry.debuggerReady) {
      throw new Error("The shared browser debugger is unavailable.");
    }
    if (
      expectedControlEpoch !== undefined &&
      (entry.controlEpoch !== expectedControlEpoch || entry.controller !== "agent")
    ) {
      throw new BrowserControlChangedError();
    }
    return entry.contents.debugger.sendCommand(method, params);
  }

  async #evaluate(
    entry: BrowserEntry,
    expression: string,
    expectedControlEpoch?: number,
  ): Promise<any> {
    const result = await this.#command(
      entry,
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      expectedControlEpoch,
    );
    return result?.result?.value;
  }

  async #sendMouse(
    entry: BrowserEntry,
    type: "mousePressed" | "mouseReleased",
    x: number,
    y: number,
    expectedControlEpoch?: number,
  ): Promise<void> {
    const expected =
      type === "mousePressed"
        ? ({ kind: "mouse", type: "mouseDown", x, y, button: "left" } satisfies AgentInput)
        : null;
    if (expected) {
      await this.#dispatchAgentInput(
        entry,
        expected,
        "Input.dispatchMouseEvent",
        {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        },
        expectedControlEpoch,
      );
      return;
    }
    await this.#command(
      entry,
      "Input.dispatchMouseEvent",
      { type, x, y, button: "left", clickCount: 1 },
      expectedControlEpoch,
    );
  }

  async #dispatchAgentInput(
    entry: BrowserEntry,
    expected: AgentInput,
    method: string,
    params: Record<string, unknown>,
    expectedControlEpoch?: number,
  ): Promise<any> {
    // Electron does not expose the origin of a before-input event. Register one
    // exact, one-shot CDP signature instead of suppressing every nearby human
    // event with a time window; unmatched input always advances the epoch.
    entry.pendingAgentInputs.push(expected);
    try {
      const result = await this.#command(entry, method, params, expectedControlEpoch);
      this.#removePendingAgentInput(entry, expected);
      return result;
    } catch (error) {
      this.#removePendingAgentInput(entry, expected);
      throw error;
    }
  }

  #consumeAgentInput(entry: BrowserEntry, actual: AgentInput): boolean {
    const index = entry.pendingAgentInputs.findIndex((expected) => {
      if (expected.kind !== actual.kind || expected.type !== actual.type) return false;
      if (expected.kind === "key" && actual.kind === "key") return expected.key === actual.key;
      return (
        expected.kind === "mouse" &&
        actual.kind === "mouse" &&
        expected.x === actual.x &&
        expected.y === actual.y &&
        expected.button === actual.button
      );
    });
    if (index < 0) return false;
    entry.pendingAgentInputs.splice(index, 1);
    return true;
  }

  #removePendingAgentInput(entry: BrowserEntry, expected: AgentInput): void {
    const index = entry.pendingAgentInputs.indexOf(expected);
    if (index >= 0) entry.pendingAgentInputs.splice(index, 1);
  }

  #completeAgentAction(entry: BrowserEntry, expectedControlEpoch: number): boolean {
    if (entry.controlEpoch !== expectedControlEpoch || entry.controller !== "agent") {
      entry.controller = "human";
      return false;
    }
    entry.controller = "agent";
    return true;
  }

  #controlChanged(): BrowserHostResult {
    return {
      ok: false,
      code: "browser_human_control",
      message: "The operator took control of the shared browser.",
    };
  }

  async #snapshot(
    entry: BrowserEntry,
  ): Promise<import("../server/browser.ts").BrowserPageSnapshot> {
    const value = await this.#evaluate(
      entry,
      `(() => {
      const clip = (input, max) => String(input ?? "").replace(/\\s+/g, " ").trim().slice(0, max);
      const cssPath = (element) => {
        if (element.id && /^[A-Za-z][A-Za-z0-9_:-]{0,120}$/.test(element.id)) return "#" + element.id;
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 6) {
          let part = current.tagName.toLowerCase();
          if (current.parentElement) {
            const same = Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName);
            if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(" > ");
      };
      const nodes = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],summary"))
        .slice(0, ${MAX_SNAPSHOT_ELEMENTS})
        .map((element) => ({
          selector: cssPath(element),
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name: clip(element.getAttribute("aria-label") || element.getAttribute("name") || element.textContent, 240) || null,
          text: clip(element.textContent || element.getAttribute("value"), 500) || null,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        }));
      return {
        url: location.href,
        title: document.title,
        loading: document.readyState !== "complete",
        visibleText: clip(document.body?.innerText, ${MAX_SNAPSHOT_TEXT}),
        interactiveElements: nodes,
      };
    })()`,
    );
    const base = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    let screenshot: string | null = null;
    if (entry.contents && !entry.contents.isDestroyed()) {
      const image = await entry.contents.capturePage();
      const size = image.getSize();
      const resized = size.width > 1280 ? image.resize({ width: 1280 }) : image;
      let jpeg = resized.toJPEG(78);
      if (jpeg.byteLength > MAX_SCREENSHOT_BYTES) jpeg = resized.resize({ width: 960 }).toJPEG(70);
      if (jpeg.byteLength <= MAX_SCREENSHOT_BYTES)
        screenshot = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }
    return {
      url:
        typeof base.url === "string" && isApprovedPageUrl(base.url, entry.origin) ? base.url : null,
      title: typeof base.title === "string" ? base.title.slice(0, 240) : null,
      loading: base.loading === true,
      visibleText:
        typeof base.visibleText === "string" ? base.visibleText.slice(0, MAX_SNAPSHOT_TEXT) : "",
      interactiveElements: Array.isArray(base.interactiveElements)
        ? (base.interactiveElements.slice(
            0,
            MAX_SNAPSHOT_ELEMENTS,
          ) as import("../server/browser.ts").BrowserPageElement[])
        : [],
      screenshot,
      actionTimeline: [...entry.actions],
    };
  }

  #recordAction(entry: BrowserEntry, kind: string): void {
    entry.actions.push({ kind, at: new Date().toISOString() });
    if (entry.actions.length > 20) entry.actions.splice(0, entry.actions.length - 20);
  }

  #startCapture(entry: BrowserEntry): void {
    if (entry.stopCapture || !entry.pictureInPicture) return;
    const picture = entry.pictureInPicture;
    entry.stopCapture = startPictureInPictureCapture(picture, async () => {
      if (!entry.contents || entry.contents.isDestroyed()) return;
      try {
        const image = await entry.contents.capturePage();
        const size = image.getSize();
        const resized = size.width > 1280 ? image.resize({ width: 1280 }) : image;
        let jpeg = resized.toJPEG(78);
        if (jpeg.byteLength > MAX_SCREENSHOT_BYTES)
          jpeg = resized.resize({ width: 960 }).toJPEG(70);
        if (
          jpeg.byteLength <= MAX_SCREENSHOT_BYTES &&
          entry.pictureInPicture === picture &&
          !picture.isDestroyed() &&
          picture.isVisible() &&
          !picture.isMinimized()
        ) {
          picture.webContents.send(BROWSER_PICTURE_IN_PICTURE_FRAME_CHANNEL, {
            dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
            width: size.width,
            height: size.height,
          });
        }
      } catch {
        // A closing guest or PiP window can race a capture. The next tick retries.
      }
    });
  }

  #stopCapture(entry: BrowserEntry): void {
    entry.stopCapture?.();
    entry.stopCapture = null;
  }
}
