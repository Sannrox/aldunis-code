import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { PreviewSnapshot, ElementReference, RepositoryMetadata } from "../../types";
import { Button, CloseButton } from "../../components/ui";
import { Icon } from "../../components/icon";

export function PreviewPanel({
  repository,
  onClose,
  onReference,
}: {
  repository: RepositoryMetadata;
  onClose: () => void;
  onReference: (reference: ElementReference) => void;
}) {
  const [origin, setOrigin] = useState("http://localhost:4173");
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<"idle" | "loading" | "visible" | "stale">("idle");
  const [reference, setReference] = useState<ElementReference | null>(null);
  const [referencePending, setReferencePending] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const request = async () => {
    setError(null);
    setReference(null);
    try {
      const response = await fetch("/api/previews/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          origin,
        }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview could not be prepared.");
      setPreview(body as PreviewSnapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview could not be prepared.");
    }
  };
  const decide = async (decision: "allow_once" | "deny") => {
    if (!preview) return;
    setError(null);
    try {
      const response = await fetch(`/api/previews/${preview.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          decision,
        }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview decision failed.");
      setPreview(body as PreviewSnapshot);
      if ((body as PreviewSnapshot).state === "running") setFrameState("loading");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview decision failed.");
    }
  };
  const stop = async () => {
    if (!preview) return;
    setError(null);
    try {
      const response = await fetch(`/api/previews/${preview.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview could not be stopped.");
      setPreview(body as PreviewSnapshot);
      setFrameState("idle");
      setReference(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview could not be stopped.");
    }
  };
  useEffect(() => {
    if (!preview || !["starting", "running", "stopping"].includes(preview.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/previews/${preview.id}/status`, { method: "POST" });
        const body = await response.json() as PreviewSnapshot;
        if (response.ok) setPreview(body);
      } catch {
        setError("Preview status is unavailable.");
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [preview?.id, preview?.state]);
  useEffect(() => {
    if (frameState !== "loading") return;
    const timer = window.setTimeout(() => {
      setFrameState((current) => current === "loading" ? "stale" : current);
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
        setError(typeof value.message === "string" ? value.message.slice(0, 240) : "Element is unavailable or stale.");
        return;
      }
      if (value?.type !== "aldunis-preview:element-reference") return;
      const screenshot = typeof value.screenshot === "string"
        && value.screenshot.startsWith("data:image/")
        && value.screenshot.length <= 512_000
        ? value.screenshot
        : null;
      const short = (candidate: unknown, limit: number) => (
        typeof candidate === "string" ? candidate.slice(0, limit) : null
      );
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
        if (pending) setError("The page did not provide an element reference. Its preview bridge may be unavailable.");
        return false;
      });
    }, 10_000);
  };
  const running = preview?.state === "running";
  return (
    <section className="preview-panel" aria-label="Web preview">
      <header>
        <div><p className="eyebrow">CONSTRAINED PREVIEW</p><h2>Local web application</h2></div>
        <div>
          {running && <button type="button" onClick={() => void stop()}>Stop</button>}
          <CloseButton onClick={onClose} label="Close preview" />
        </div>
      </header>
      <div className="preview-policy">
        <strong>Loopback only</strong>
        <span>Popups, downloads, clipboard, browser permissions, and top navigation are denied.</span>
      </div>
      {!preview && (
        <form className="preview-setup" onSubmit={(event) => { event.preventDefault(); void request(); }}>
          <label htmlFor="preview-origin">Configured preview origin</label>
          <input
            id="preview-origin"
            name="preview-origin"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Review start</button>
        </form>
      )}
      {preview?.state === "approval_pending" && (
        <section className="preview-approval">
          <span><Icon name="shield" /></span>
          <div><strong>Start development server once?</strong><code>{preview.command}</code><small>{preview.worktree}</small></div>
          <footer>
            <button type="button" onClick={() => void decide("deny")}>Deny</button>
            <Button variant="primary" size="sm" onClick={() => void decide("allow_once")}>Allow once</Button>
          </footer>
        </section>
      )}
      {running && (
        <div className="preview-workspace">
          <div className="preview-toolbar">
            <span>{preview.origin}</span>
            <em className={frameState}>{frameState}</em>
            <button
              type="button"
              onClick={selectElement}
              disabled={referencePending || frameState !== "visible"}
            >
              {referencePending ? "Choose an element…" : "Reference element"}
            </button>
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
              <header><strong>Element context</strong><span>{reference.tag}{reference.role ? ` · ${reference.role}` : ""}</span></header>
              <code>{reference.selector}</code>
              {reference.name && <p>Accessible name: {reference.name}</p>}
              {reference.text && <p>{reference.text}</p>}
              {reference.screenshot && <img src={reference.screenshot} alt="Selected element snapshot" />}
              <small>Only this bounded reference is attached; unrelated page data is not collected.</small>
            </aside>
          )}
        </div>
      )}
      {preview && !["approval_pending", "running"].includes(preview.state) && (
        <div className={`preview-status ${preview.state}`}>
          <strong>{preview.state.replace("_", " ")}</strong>
          <p>{preview.message ?? (preview.state === "starting" ? "Starting the approved command…" : "Preview is inactive.")}</p>
        </div>
      )}
      {error && <div className="provider-error" role="alert">{error}</div>}
    </section>
  );
}


