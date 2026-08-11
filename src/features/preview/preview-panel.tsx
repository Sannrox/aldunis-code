import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  PreviewSnapshot,
  PreviewState,
  ElementReference,
  RepositoryMetadata,
  ProviderBrowserObservation,
  BrowserSessionSnapshot,
} from "../../types";
import { Button, CloseButton } from "../../components/ui";
import { Icon } from "../../components/icon";
import { createPreviewHost, previewHostErrorMessage } from "../../lib/preview-host";
import { startPreviewStatusPolling } from "../../lib/preview-status-polling";

export interface PreviewPanelStatus {
  state: PreviewState | "inactive";
  error: string | null;
}

export function PreviewPanel({
  repository,
  pane = "primary",
  active = true,
  floating = false,
  conversationId = null,
  onClose,
  onToggleFloating,
  agentObservation = null,
  onReference,
  onStatusChange,
}: {
  repository: RepositoryMetadata;
  /** Dual-pane scope for preview chrome labels. */
  pane?: "primary" | "secondary";
  active?: boolean;
  /** Keep the constrained preview visible while the conversation remains usable. */
  floating?: boolean;
  conversationId?: string | null;
  onClose: () => void;
  onToggleFloating: () => void;
  /** Latest provider-owned image frame. It is stream-only and never persisted. */
  agentObservation?: ProviderBrowserObservation | null;
  onReference: (reference: ElementReference) => void;
  onStatusChange?: (status: PreviewPanelStatus) => void;
}) {
  const [origin, setOrigin] = useState("http://localhost:4173");
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<"idle" | "loading" | "visible" | "stale">("idle");
  const [reference, setReference] = useState<ElementReference | null>(null);
  const [referencePending, setReferencePending] = useState(false);
  const [browserSession, setBrowserSession] = useState<BrowserSessionSnapshot | null>(null);
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const browserSessionRef = useRef<BrowserSessionSnapshot | null>(null);
  const browserSessionScopeRef = useRef<{
    conversationId: string;
    root: string;
    worktree: string;
  } | null>(null);
  const sharedBrowserViewRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const previewHost = useMemo(
    () =>
      createPreviewHost({
        root: repository.root,
        worktree: repository.selectedWorktree,
      }),
    [repository.root, repository.selectedWorktree],
  );
  const previewHostRef = useRef(previewHost);
  const conversationIdRef = useRef(conversationId);
  const disposalTimersRef = useRef(new Map<typeof previewHost, number>());
  previewHostRef.current = previewHost;
  conversationIdRef.current = conversationId;
  browserSessionRef.current = browserSession;
  const sharedBrowser = browserSession;
  const hasSharedBrowser = Boolean(sharedBrowser);
  const hasAgentObservation = !hasSharedBrowser && Boolean(agentObservation);
  const desktopBrowserAvailable = Boolean(
    window.aldunisDesktopCapabilities?.sharedBrowser && conversationId,
  );
  const request = async () => {
    setError(null);
    setReference(null);
    try {
      const state = await previewHost.perform({ kind: "preview.prepare", origin });
      if (previewHostRef.current !== previewHost) return;
      setPreview(state.preview);
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return;
      setError(previewHostErrorMessage(cause, "Preview could not be prepared."));
    }
  };
  const decide = async (decision: "allow_once" | "deny") => {
    if (!preview) return;
    setError(null);
    try {
      const state = await previewHost.perform({ kind: "preview.decide", decision });
      if (previewHostRef.current !== previewHost) return;
      setPreview(state.preview);
      if (state.preview?.state === "running") setFrameState("loading");
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return;
      setError(previewHostErrorMessage(cause, "Preview decision failed."));
    }
  };
  const stop = async () => {
    if (!preview) return;
    setError(null);
    try {
      const state = await previewHost.perform({ kind: "preview.stop" });
      if (previewHostRef.current !== previewHost) return;
      setPreview(state.preview);
      setFrameState("idle");
      setReference(null);
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return;
      setError(previewHostErrorMessage(cause, "Preview could not be stopped."));
    }
  };
  const openSharedBrowser = async () => {
    if (!conversationId) {
      setError("The shared browser needs a conversation context.");
      return;
    }
    if (!preview || preview.state !== "running") {
      setError("Start the local preview before opening its shared browser.");
      return;
    }
    setError(null);
    try {
      const state = await previewHost.perform({ kind: "browser.open", conversationId });
      if (previewHostRef.current !== previewHost) return;
      if (conversationIdRef.current !== conversationId) {
        await previewHost.perform({ kind: "browser.release" });
        return;
      }
      browserSessionScopeRef.current = {
        conversationId,
        root: repository.root,
        worktree: repository.selectedWorktree,
      };
      const nextSession = state.browser;
      if (!nextSession) throw new Error("Shared browser could not be opened.");
      browserSessionRef.current = nextSession;
      setBrowserSession(nextSession);
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return;
      setError(previewHostErrorMessage(cause, "Shared browser could not be opened."));
    }
  };
  const updateBrowserControl = async (enabled: boolean) => {
    if (!browserSession || !conversationId) return;
    setError(null);
    try {
      const state = await previewHost.perform({ kind: "browser.control", enabled });
      if (previewHostRef.current !== previewHost) return;
      setBrowserSession(state.browser);
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return;
      setError(previewHostErrorMessage(cause, "Browser control could not be updated."));
    }
  };
  const closeSharedBrowser = async (): Promise<boolean> => {
    if (!browserSession || !conversationId) return true;
    setError(null);
    try {
      await previewHost.perform({ kind: "browser.close" });
      if (previewHostRef.current !== previewHost) return false;
      browserSessionRef.current = null;
      setBrowserSession(null);
      browserSessionScopeRef.current = null;
      setPictureInPicture(false);
      return true;
    } catch (cause) {
      if (previewHostRef.current !== previewHost) return false;
      setError(previewHostErrorMessage(cause, "Shared browser could not be closed."));
      return false;
    }
  };
  const closePanel = () => {
    if (!browserSession) {
      onClose();
      return;
    }
    void closeSharedBrowser().then((closed) => {
      if (closed) onClose();
    });
  };
  const togglePictureInPicture = async () => {
    if (
      !browserSession ||
      !window.aldunisDesktopCapabilities?.sharedBrowser ||
      !window.aldunisDesktop
    )
      return;
    setError(null);
    const next = !pictureInPicture;
    const opened = await window.aldunisDesktop.setBrowserPictureInPicture(browserSession.id, next);
    if (!opened && next) {
      setError(
        "Picture-in-picture could not be opened. Keep the shared browser docked in the workspace.",
      );
      return;
    }
    setPictureInPicture(next);
  };
  useEffect(() => {
    for (const [host, timer] of disposalTimersRef.current) {
      window.clearTimeout(timer);
      disposalTimersRef.current.delete(host);
      if (host !== previewHost) void host.dispose({ stopPreview: true });
    }
    browserSessionScopeRef.current = null;
    browserSessionRef.current = null;
    setPreview(null);
    setBrowserSession(null);
    setPictureInPicture(false);
    return () => {
      browserSessionScopeRef.current = null;
      browserSessionRef.current = null;
      const timer = window.setTimeout(() => {
        disposalTimersRef.current.delete(previewHost);
        void previewHost.dispose();
      }, 0);
      disposalTimersRef.current.set(previewHost, timer);
    };
  }, [previewHost]);
  useEffect(() => {
    const scope = browserSessionScopeRef.current;
    if (!scope || scope.conversationId === conversationId || !browserSessionRef.current) return;
    browserSessionScopeRef.current = null;
    browserSessionRef.current = null;
    setBrowserSession(null);
    setPictureInPicture(false);
    void previewHost.perform({ kind: "browser.release" });
  }, [browserSession, conversationId, previewHost]);
  useEffect(() => {
    if (!active || !preview || !["starting", "running", "stopping"].includes(preview.state)) return;
    return startPreviewStatusPolling(async () => {
      try {
        const state = await previewHost.perform({ kind: "preview.status" });
        if (previewHostRef.current !== previewHost) return;
        setPreview(state.preview);
      } catch {
        if (previewHostRef.current !== previewHost) return;
        setError("Preview status is unavailable.");
      }
    }, document);
  }, [active, preview?.id, preview?.state, previewHost]);
  useEffect(() => {
    if (!active || !browserSession || !conversationId) return;
    return startPreviewStatusPolling(async () => {
      try {
        const state = await previewHost.perform({ kind: "browser.status" });
        if (previewHostRef.current !== previewHost) return;
        setBrowserSession(state.browser);
      } catch (cause) {
        if (previewHostRef.current !== previewHost) return;
        setError(previewHostErrorMessage(cause, "Shared browser status is unavailable."));
      }
    }, document);
  }, [
    active,
    browserSession?.id,
    browserSession?.origin,
    conversationId,
    previewHost,
    repository.root,
    repository.selectedWorktree,
  ]);
  useEffect(() => {
    if (!browserSession || !desktopBrowserAvailable) return;
    const view = sharedBrowserViewRef.current as
      | (HTMLElement & {
          getWebContentsId?: () => number;
        })
      | null;
    if (!view) return;
    let guestId: number | null = null;
    const register = () => {
      try {
        const candidate = view.getWebContentsId?.();
        if (typeof candidate !== "number" || !Number.isInteger(candidate)) return;
        guestId = candidate;
        void window.aldunisDesktop
          ?.registerBrowserView(browserSession.id, candidate, browserSession.origin)
          .then((registered) => {
            if (!registered)
              setError("The shared browser view could not be registered with the desktop host.");
          });
      } catch {
        setError("The shared browser view could not be registered with the desktop host.");
      }
    };
    const unregister = () => {
      if (guestId === null) return;
      void window.aldunisDesktop?.unregisterBrowserView(browserSession.id, guestId);
      guestId = null;
    };
    view.addEventListener("did-attach", register);
    view.addEventListener("destroyed", unregister);
    register();
    return () => {
      view.removeEventListener("did-attach", register);
      view.removeEventListener("destroyed", unregister);
      unregister();
    };
  }, [browserSession?.id, browserSession?.origin, desktopBrowserAvailable]);
  useEffect(() => {
    if (frameState !== "loading") return;
    const timer = window.setTimeout(() => {
      setFrameState((current) => (current === "loading" ? "stale" : current));
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [frameState]);
  useEffect(() => {
    if (preview?.state === "running" && frameState === "idle") setFrameState("loading");
  }, [frameState, preview?.state]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!preview || event.origin !== preview.origin || !referencePending) return;
      const value = event.data as Record<string, unknown>;
      if (value?.type === "aldunis-preview:element-error") {
        setReferencePending(false);
        setError(
          typeof value.message === "string"
            ? value.message.slice(0, 240)
            : "Element is unavailable or stale.",
        );
        return;
      }
      if (value?.type !== "aldunis-preview:element-reference") return;
      const screenshot =
        typeof value.screenshot === "string" &&
        value.screenshot.startsWith("data:image/") &&
        value.screenshot.length <= 512_000
          ? value.screenshot
          : null;
      const short = (candidate: unknown, limit: number) =>
        typeof candidate === "string" ? candidate.slice(0, limit) : null;
      const selector = short(value.selector, 240);
      const tag = short(value.tag, 32);
      if (!selector || !tag) {
        setError("The page returned an invalid element reference.");
      } else {
        const nextReference = {
          selector,
          tag,
          role: short(value.role, 80),
          name: short(value.name, 240),
          text: short(value.text, 500),
          screenshot,
        };
        setReference(nextReference);
        onReference(nextReference);
      }
      setReferencePending(false);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onReference, preview, referencePending]);
  const selectElement = () => {
    if (!preview || !frameRef.current?.contentWindow) return;
    setError(null);
    setReferencePending(true);
    frameRef.current.contentWindow.postMessage(
      { type: "aldunis-preview:select-element", requestId: crypto.randomUUID() },
      preview.origin,
    );
    window.setTimeout(() => {
      setReferencePending((pending) => {
        if (pending)
          setError(
            "The page did not provide an element reference. Its preview bridge may be unavailable.",
          );
        return false;
      });
    }, 10_000);
  };
  const running = preview?.state === "running";
  useEffect(() => {
    onStatusChange?.({
      state: browserSession
        ? browserSession.state === "ready"
          ? "running"
          : "starting"
        : (preview?.state ?? "inactive"),
      error: browserSession?.error ?? error,
    });
  }, [browserSession?.error, browserSession?.state, error, onStatusChange, preview?.state]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, closePanel]);
  return (
    <section
      className={`preview-panel${floating ? " preview-panel--floating" : ""}`}
      aria-label={
        hasSharedBrowser
          ? `Shared browser, ${pane} pane`
          : hasAgentObservation
            ? `Agent browser view, ${pane} pane`
            : `Web preview, ${pane} pane`
      }
      hidden={!active}
    >
      <header>
        <div>
          <p className="eyebrow">
            {hasSharedBrowser
              ? "SHARED BROWSER"
              : hasAgentObservation
                ? "PROVIDER OBSERVATION"
                : "CONSTRAINED PREVIEW"}
          </p>
          <h2>
            {hasSharedBrowser
              ? "Shared local browser"
              : hasAgentObservation
                ? "Agent browser view"
                : "Local web application"}
          </h2>
        </div>
        <div>
          {(running || hasAgentObservation || hasSharedBrowser) && (
            <Button
              type="button"
              size="sm"
              variant={floating ? "primary" : "default"}
              onClick={onToggleFloating}
              aria-pressed={floating}
              aria-label={
                floating
                  ? `Dock ${hasSharedBrowser ? "shared browser" : hasAgentObservation ? "agent browser view" : "preview"}, ${pane} pane`
                  : `Float ${hasSharedBrowser ? "shared browser" : hasAgentObservation ? "agent browser view" : "preview"}, ${pane} pane`
              }
              title={
                floating
                  ? "Return the view to the workspace"
                  : "Keep the view visible while you chat"
              }
            >
              {floating ? "Dock" : "Float"}
            </Button>
          )}
          {running && (
            <Button
              type="button"
              size="sm"
              onClick={() => void stop()}
              aria-label={`Stop local web preview, ${pane} pane`}
            >
              Stop
            </Button>
          )}
          {hasSharedBrowser && desktopBrowserAvailable && (
            <Button
              type="button"
              size="sm"
              onClick={() => void togglePictureInPicture()}
              aria-pressed={pictureInPicture}
              aria-label={
                pictureInPicture
                  ? "Close shared browser picture-in-picture"
                  : "Open shared browser picture-in-picture"
              }
            >
              {pictureInPicture ? "Close PiP" : "PiP"}
            </Button>
          )}
          <CloseButton
            onClick={closePanel}
            label={`Close ${hasSharedBrowser ? "shared browser" : hasAgentObservation ? "agent browser view" : "preview"}, ${pane} pane`}
          />
        </div>
      </header>
      {sharedBrowser ? (
        <>
          <div className="preview-policy">
            <strong>Shared loopback browser</strong>
            <span>
              The workspace and picture-in-picture show the same Electron page. Navigation stays on
              localhost, and agent control is a separate session rule.
            </span>
          </div>
          <div className="shared-browser-workspace">
            <div className="preview-toolbar shared-browser-toolbar">
              <span title={sharedBrowser.url ?? sharedBrowser.origin}>
                {sharedBrowser.title ?? sharedBrowser.url ?? sharedBrowser.origin}
              </span>
              <span className={`browser-control-badge ${sharedBrowser.controller}`}>
                {sharedBrowser.controller === "agent"
                  ? "agent controls"
                  : sharedBrowser.controller === "human"
                    ? "human controls"
                    : "view only"}
              </span>
              {sharedBrowser.agentControl ? (
                <Button
                  type="button"
                  size="sm"
                  variant={sharedBrowser.controller === "human" ? "primary" : "default"}
                  onClick={() => void updateBrowserControl(sharedBrowser.controller === "human")}
                >
                  {sharedBrowser.controller === "human"
                    ? "Return control to agent"
                    : "Pause agent control"}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  onClick={() => void updateBrowserControl(true)}
                >
                  Allow agent control
                </Button>
              )}
              <Button type="button" size="sm" onClick={() => void closeSharedBrowser()}>
                End session
              </Button>
            </div>
            {desktopBrowserAvailable ? (
              React.createElement("webview", {
                ref: (value: HTMLElement | null) => {
                  sharedBrowserViewRef.current = value;
                },
                title: "Shared local application browser",
                src: "about:blank",
                partition: sharedBrowser.partition,
                allowpopups: false,
                webpreferences: "contextIsolation=yes,sandbox=yes,nodeIntegration=no",
                referrerpolicy: "no-referrer",
              })
            ) : (
              <div className="shared-browser-unavailable" role="status">
                <strong>Desktop browser host required</strong>
                <p>
                  Run Aldunis Code as the desktop application to open the shared browser. Provider
                  observation remains available below when a provider supplies a frame.
                </p>
              </div>
            )}
            <p>
              The session uses a conversation-scoped persistent partition. Cookies and page state
              stay in the desktop profile; screenshots and page text are not added to conversation
              history.
            </p>
          </div>
        </>
      ) : hasAgentObservation ? (
        <>
          <div className="preview-policy">
            <strong>Ephemeral snapshot</strong>
            <span>
              Provider-supplied, read-only image bytes. No page controls, browser credentials, or
              history are attached.
            </span>
          </div>
          <div className="browser-observation-workspace">
            <div className="preview-toolbar">
              <span title={agentObservation?.url ?? undefined}>
                {agentObservation?.title ?? agentObservation?.url ?? "Provider browser frame"}
              </span>
              <em>stream-only</em>
            </div>
            <figure>
              <img
                src={agentObservation?.imageData}
                alt={
                  agentObservation?.title
                    ? `Provider browser: ${agentObservation.title}`
                    : "Provider browser snapshot"
                }
              />
            </figure>
            <p>
              Source: {agentObservation?.provider}. The frame disappears when this turn is replaced
              or the view is closed.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="preview-policy">
            <strong>Loopback only</strong>
            <span>
              Popups, downloads, clipboard, browser permissions, and top navigation are denied.
            </span>
          </div>
          {!preview && (
            <form
              className="preview-setup"
              onSubmit={(event) => {
                event.preventDefault();
                void request();
              }}
            >
              <label htmlFor="preview-origin">Configured preview origin</label>
              <input
                id="preview-origin"
                name="preview-origin"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" size="sm" aria-label={`Review preview start, ${pane} pane`}>
                Review start
              </Button>
            </form>
          )}
          {preview?.state === "approval_pending" && (
            <section className="preview-approval">
              <span>
                <Icon name="shield" />
              </span>
              <div>
                <strong>Start development server once?</strong>
                <code title={preview.command}>{preview.command}</code>
                <small title={preview.worktree}>{preview.worktree}</small>
              </div>
              <footer>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Deny starting preview: ${preview.command}`}
                  onClick={() => void decide("deny")}
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={`Allow once starting preview: ${preview.command}`}
                  onClick={() => void decide("allow_once")}
                >
                  Allow once
                </Button>
              </footer>
            </section>
          )}
          {running && (
            <div className="preview-workspace">
              <div className="preview-toolbar">
                <span>{preview.origin}</span>
                <em className={frameState}>{frameState}</em>
                {desktopBrowserAvailable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void openSharedBrowser()}
                    aria-label="Open shared browser"
                  >
                    Open shared browser
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  onClick={selectElement}
                  disabled={referencePending || frameState !== "visible"}
                  aria-label={
                    referencePending
                      ? "Choose an element in the preview"
                      : "Reference element in the preview"
                  }
                >
                  {referencePending ? "Choose an element…" : "Reference element"}
                </Button>
              </div>
              <iframe
                ref={frameRef}
                title="Local application preview"
                src={preview.origin}
                sandbox="allow-scripts allow-same-origin allow-forms"
                referrerPolicy="no-referrer"
                allow="clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
                onLoad={() => setFrameState("visible")}
              />
              {reference && (
                <aside className="element-reference">
                  <header>
                    <strong>Element context</strong>
                    <span>
                      {reference.tag}
                      {reference.role ? ` · ${reference.role}` : ""}
                    </span>
                  </header>
                  <code title={reference.selector}>{reference.selector}</code>
                  {reference.name && <p>Accessible name: {reference.name}</p>}
                  {reference.text && <p>{reference.text}</p>}
                  {reference.screenshot && (
                    <img src={reference.screenshot} alt="Selected element snapshot" />
                  )}
                  <small>
                    Only this bounded reference is attached; unrelated page data is not collected.
                  </small>
                </aside>
              )}
            </div>
          )}
          {preview && !["approval_pending", "running"].includes(preview.state) && (
            <div className={`preview-status ${preview.state}`}>
              <strong>{preview.state.replace("_", " ")}</strong>
              <p>
                {preview.message ??
                  (preview.state === "starting"
                    ? "Starting the approved command…"
                    : "Preview is inactive.")}
              </p>
            </div>
          )}
        </>
      )}
      {error && (
        <div className="provider-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
