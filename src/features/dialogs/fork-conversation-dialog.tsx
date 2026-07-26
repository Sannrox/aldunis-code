import React, { useEffect, useState } from "react";
import type { ForkPreview, ProviderDiscovery, ProviderId, ClaudeProfile } from "../../types";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

export function ForkConversationDialog({
  sourceThreadId,
  sourceProvider,
  profiles,
  providers,
  onClose,
  onCreated,
}: {
  sourceThreadId: string;
  sourceProvider: ProviderId;
  profiles: ClaudeProfile[];
  providers: ProviderDiscovery[];
  onClose: () => void;
  onCreated: (threadId: string) => void;
}) {
  const codex = providers.find((provider) => provider.id === "codex-cli");
  const shikigamiProvider = providers.find((provider) => provider.id === "shikigami");
  const defaultDestination: ProviderId = sourceProvider === "claude-code"
    ? (codex?.installed && codex.authenticated ? "codex-cli" : "shikigami")
    : "claude-code";
  const [destination, setDestination] = useState<ProviderId>(defaultDestination);
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [model, setModel] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void fetch("/api/forks/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceThreadId }),
    }).then(async (response) => {
      const body = await response.json() as ForkPreview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The fork preview could not be prepared.");
      setPreview(body);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "The fork preview failed."))
      .finally(() => setBusy(false));
  }, [sourceThreadId]);
  const create = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/forks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId,
          provider: destination,
          profileId: destination === "claude-code" ? profileId : null,
          model,
          expectedDigest: preview.digest,
        }),
      });
      const body = await response.json() as { thread?: { id: string }; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error ?? "The fork could not be created.");
      onCreated(body.thread.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fork failed.");
      setBusy(false);
    }
  };
  const unavailable = destination === "codex-cli"
    ? !codex?.installed || !codex.authenticated
    : destination === "shikigami"
    ? !shikigamiProvider?.installed || !shikigamiProvider.authenticated
    : profiles.length === 0;
  const destinationLabel = destination === "codex-cli"
    ? "Codex CLI"
    : destination === "shikigami"
    ? "Shikigami"
    : "Claude Code";
  return (
    <OverlayDialog title={`Fork to ${destinationLabel}`} onClose={onClose}>
      <div className="fork-dialog">
        <p>This creates a new provider-native conversation. The source and its provider session remain unchanged.</p>
        {busy && !preview && <p role="status">Preparing bounded context…</p>}
        {preview && <>
          <dl>
            <div><dt>Messages</dt><dd>{preview.messages.length}</dd></div>
            <div><dt>Annotations</dt><dd>{preview.annotations.length}</dd></div>
            <div><dt>File context</dt><dd>None</dd></div>
            <div><dt>Summaries</dt><dd>None</dd></div>
            <div><dt>Transfer size</dt><dd>{preview.byteCount.toLocaleString()} bytes</dd></div>
            <div><dt>Worktree</dt><dd>{preview.worktree}</dd></div>
          </dl>
          <details open>
            <summary>Exact messages crossing the boundary</summary>
            {preview.messages.length
              ? preview.messages.map((message) => <article key={message.id}><strong>{message.role}</strong><p>{message.text}</p></article>)
              : <p>No messages will be transferred.</p>}
          </details>
          {preview.annotations.length > 0 && <details>
            <summary>User-authored annotations</summary>
            {preview.annotations.map((annotation) => <article key={annotation.id}><strong>{annotation.path}</strong><p>{annotation.text}</p></article>)}
          </details>}
          <details>
            <summary>Always excluded</summary>
            <ul>{preview.excluded.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
          <label>Destination provider
            <select
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value as ProviderId);
                setModel("default");
              }}
            >
              <option value="claude-code" disabled={sourceProvider === "claude-code"}>Claude Code</option>
              <option
                value="codex-cli"
                disabled={sourceProvider === "codex-cli" || !codex?.installed || !codex?.authenticated}
              >
                Codex CLI
              </option>
              <option
                value="shikigami"
                disabled={sourceProvider === "shikigami" || !shikigamiProvider?.installed || !shikigamiProvider?.authenticated}
              >
                Shikigami
              </option>
            </select>
          </label>
          {destination === "claude-code" ? <>
            <label>Profile<select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>
            <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{["default", "sonnet", "opus", "haiku"].map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
          </> : destination === "codex-cli" ? (
            <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="default">Default model</option>{codex?.models?.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
          ) : (
            <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="default">Default model</option>{shikigamiProvider?.models?.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>
          )}
          <footer><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void create()} disabled={busy || unavailable}>Create reviewed fork</Button></footer>
        </>}
        {unavailable && <p className="context-error" role="alert">The destination provider is unavailable or not authenticated.</p>}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}
