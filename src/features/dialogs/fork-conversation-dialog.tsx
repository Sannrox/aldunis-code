import React, { useEffect, useMemo, useState } from "react";
import type { ForkPreview, ProviderDiscovery, ProviderId, ClaudeProfile } from "../../types";
import { Button } from "../../components/ui";
import { MarkdownBody } from "../../components/markdown-body";
import {
  providerModelOptions,
  providerNotReadyMessage,
  resolveDefaultProviderModel,
} from "../../lib/provider-readiness";
import { OverlayDialog } from "./overlay-dialog";
import { ContextPackageSummary } from "../code/context-package";

function isReady(provider: ProviderDiscovery | undefined): boolean {
  return Boolean(provider?.installed && provider.authenticated !== false && provider.enabled !== false);
}

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
  const claudeProfiles = profiles.filter((profile) => (
    profile.provider === "claude-code" || !profile.provider
  ));
  const claudeReady = claudeProfiles.length > 0;
  const defaultDestination = useMemo((): ProviderId => {
    const candidates: ProviderId[] = sourceProvider === "claude-code"
      ? ["codex-cli", "shikigami"]
      : sourceProvider === "codex-cli"
      ? ["claude-code", "shikigami"]
      : ["claude-code", "codex-cli"];
    for (const id of candidates) {
      if (id === "claude-code" && claudeReady) return id;
      if (id === "codex-cli" && isReady(codex)) return id;
      if (id === "shikigami" && isReady(shikigamiProvider)) return id;
    }
    return candidates[0]!;
  }, [claudeReady, codex, shikigamiProvider, sourceProvider]);
  const [destination, setDestination] = useState<ProviderId>(defaultDestination);
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [profileId, setProfileId] = useState(
    claudeProfiles.find((profile) => profile.id === "default:claude-code")?.id
      ?? claudeProfiles[0]?.id
      ?? "",
  );
  const [model, setModel] = useState(() => resolveDefaultProviderModel(defaultDestination, providers.find((p) => p.id === defaultDestination)));
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
  const destinationDiscovery = destination === "codex-cli"
    ? codex
    : destination === "shikigami"
    ? shikigamiProvider
    : { id: "claude-code" as const, installed: true };
  const destinationLabel = destination === "codex-cli"
    ? "Codex CLI"
    : destination === "shikigami"
    ? "Shikigami"
    : "Claude Code";
  const unavailable = destination === "claude-code"
    ? !claudeReady
    : !isReady(destinationDiscovery);
  const unavailableMessage = unavailable
    ? providerNotReadyMessage(destination, destinationDiscovery, {
      hasClaudeProfile: claudeReady,
      providerName: destinationLabel,
    })
    : "";
  return (
    <OverlayDialog title={`Fork to ${destinationLabel}`} onClose={onClose}>
      <div className="fork-dialog">
        <p>This creates a new provider-native conversation. The source and its provider session remain unchanged.</p>
        {busy && !preview && <p role="status">Preparing bounded context…</p>}
        {preview && <>
          <ContextPackageSummary receipt={preview.contextPackage} label="Reviewed transfer package" />
          <dl>
            <div><dt>Messages</dt><dd>{preview.messages.length}</dd></div>
            <div><dt>Annotations</dt><dd>{preview.annotations.length}</dd></div>
            <div><dt>File context</dt><dd>None</dd></div>
            <div><dt>Summaries</dt><dd>None</dd></div>
            <div><dt>Transfer size</dt><dd>{preview.byteCount.toLocaleString()} bytes</dd></div>
            <div><dt>Worktree</dt><dd title={preview.worktree}>{preview.worktree}</dd></div>
          </dl>
          <details open>
            <summary>Exact messages crossing the boundary</summary>
            {preview.messages.length
              ? preview.messages.map((message) => (
                <article key={message.id}>
                  <strong>{message.role}</strong>
                  {message.role === "assistant"
                    ? <div className="fork-message-body"><MarkdownBody text={message.text} /></div>
                    : <p className="fork-message-body">{message.text}</p>}
                </article>
              ))
              : <p>No messages will be transferred.</p>}
          </details>
          {preview.annotations.length > 0 && <details>
            <summary>User-authored annotations</summary>
            {preview.annotations.map((annotation) => (
              <article key={annotation.id}>
                <strong title={annotation.path}>{annotation.path}</strong>
                <p>{annotation.text}</p>
              </article>
            ))}
          </details>}
          <details>
            <summary>Always excluded</summary>
            <ul>{preview.excluded.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
          <label htmlFor="fork-destination-provider">Destination provider
            <select
              id="fork-destination-provider"
              name="fork-destination-provider"
              value={destination}
              onChange={(event) => {
                const next = event.target.value as ProviderId;
                setDestination(next);
                setModel(resolveDefaultProviderModel(next, providers.find((p) => p.id === next)));
              }}
            >
              <option value="claude-code" disabled={sourceProvider === "claude-code" || !claudeReady}>
                Claude Code{!claudeReady ? " (configure profile)" : ""}
              </option>
              <option
                value="codex-cli"
                disabled={sourceProvider === "codex-cli" || !isReady(codex)}
              >
                Codex CLI{codex && !isReady(codex) ? " (not ready)" : !codex ? " (not ready)" : ""}
              </option>
              <option
                value="shikigami"
                disabled={sourceProvider === "shikigami" || !isReady(shikigamiProvider)}
              >
                Shikigami{shikigamiProvider && !isReady(shikigamiProvider) ? " (not ready)" : !shikigamiProvider ? " (not ready)" : ""}
              </option>
            </select>
          </label>
          {destination === "claude-code" ? <>
            <label htmlFor="fork-profile">Profile
              <select
                id="fork-profile"
                name="fork-profile"
                value={profileId}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {claudeProfiles.map((profile) => (
                  <option value={profile.id} key={profile.id}>{profile.name}</option>
                ))}
              </select>
            </label>
            <label htmlFor="fork-model-claude">Model
              <select
                id="fork-model-claude"
                name="fork-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {providerModelOptions("claude-code", undefined).map((item) => (
                  <option value={item.id} key={item.id}>{item.displayName}</option>
                ))}
              </select>
            </label>
          </> : destination === "codex-cli" ? (
            <label htmlFor="fork-model-codex">Model
              <select
                id="fork-model-codex"
                name="fork-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {providerModelOptions("codex-cli", codex).map((item) => (
                  <option value={item.id} key={item.id}>{item.displayName}</option>
                ))}
              </select>
            </label>
          ) : (
            <label htmlFor="fork-model-shikigami">Model
              <select
                id="fork-model-shikigami"
                name="fork-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {providerModelOptions("shikigami", shikigamiProvider).map((item) => (
                  <option value={item.id} key={item.id}>{item.displayName}</option>
                ))}
              </select>
            </label>
          )}
          <footer>
            <Button onClick={onClose} disabled={busy} aria-label="Cancel fork">Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={busy || unavailable}
              aria-label={busy ? "Creating reviewed fork" : "Create reviewed fork"}
            >
              Create reviewed fork
            </Button>
          </footer>
        </>}
        {unavailable && <p className="context-error" role="alert">{unavailableMessage}</p>}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}
