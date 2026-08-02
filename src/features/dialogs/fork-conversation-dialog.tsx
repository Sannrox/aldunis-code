import React, { useEffect, useMemo, useState } from "react";
import type {
  ClaudeProfile,
  ForkPreview,
  ProviderDiscovery,
  ProviderId,
  RepositoryMetadata,
  WorkspaceMode,
} from "../../types";
import { Button } from "../../components/ui";
import { MarkdownBody } from "../../components/markdown-body";
import {
  providerDiscoveryForProfile,
  providerModelOptions,
  providerNotReadyMessage,
  resolveDefaultProviderModel,
} from "../../lib/provider-readiness";
import { OverlayDialog } from "./overlay-dialog";
import { ConversationWorkspaceDialog } from "./conversation-workspace-dialog";
import { WorktreeDialog } from "./worktree-dialog";
import { ContextPackageSummary } from "../code/context-package";

function isReady(provider: ProviderDiscovery | undefined): boolean {
  return Boolean(provider?.installed && provider.authenticated !== false && provider.enabled !== false);
}

export function ForkConversationDialog({
  sourceThreadId,
  sourceProvider,
  sourceWorkspaceMode,
  repository,
  profiles,
  providers,
  onClose,
  onRepositoryChanged,
  onCreated,
}: {
  sourceThreadId: string;
  sourceProvider: ProviderId;
  sourceWorkspaceMode: WorkspaceMode;
  repository: RepositoryMetadata;
  profiles: ClaudeProfile[];
  providers: ProviderDiscovery[];
  onClose: () => void;
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
  onCreated: (threadId: string) => void;
}) {
  const codex = providers.find((provider) => provider.id === "codex-cli");
  const shikigamiProvider = providers.find((provider) => provider.id === "shikigami");
  const claudeProfiles = profiles.filter((profile) => (
    profile.provider === "claude-code" || !profile.provider
  ));
  const shikigamiProfiles = profiles.filter((profile) => profile.provider === "shikigami");
  const claudeReady = claudeProfiles.length > 0;
  const shikigamiReady = shikigamiProvider?.profileDiscoveries?.length
    ? shikigamiProvider.profileDiscoveries.some((profile) => (
      profile.installed && profile.authenticated !== false
    ))
    : isReady(shikigamiProvider);
  const defaultDestination = useMemo((): ProviderId => {
    const candidates: ProviderId[] = sourceProvider === "claude-code"
      ? ["codex-cli", "shikigami"]
      : sourceProvider === "codex-cli"
      ? ["claude-code", "shikigami"]
      : ["claude-code", "codex-cli"];
    for (const id of candidates) {
      if (id === "claude-code" && claudeReady) return id;
      if (id === "codex-cli" && isReady(codex)) return id;
      if (id === "shikigami" && shikigamiReady) return id;
    }
    return candidates[0]!;
  }, [claudeReady, codex, shikigamiReady, sourceProvider]);
  const defaultClaudeProfileId = claudeProfiles.find((profile) => profile.id === "default:claude-code")?.id
    ?? claudeProfiles[0]?.id
    ?? "";
  const defaultShikigamiProfileId = shikigamiProfiles.find((profile) => profile.id === "default:shikigami")?.id
    ?? shikigamiProfiles[0]?.id
    ?? "";
  const defaultShikigamiDiscovery = providerDiscoveryForProfile(
    "shikigami",
    shikigamiProvider,
    defaultShikigamiProfileId,
  );
  const [destination, setDestination] = useState<ProviderId>(defaultDestination);
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [profileId, setProfileId] = useState(
    defaultDestination === "shikigami" ? defaultShikigamiProfileId : defaultClaudeProfileId,
  );
  const [model, setModel] = useState(() => resolveDefaultProviderModel(
    defaultDestination,
    defaultDestination === "shikigami"
      ? defaultShikigamiDiscovery
      : providers.find((p) => p.id === defaultDestination),
  ));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [preparedWorkspaceRepository, setPreparedWorkspaceRepository] = useState<RepositoryMetadata | null>(null);
  const [forkDestinationId] = useState(() => crypto.randomUUID());
  const requiresManagedWorkspace = (preview?.workspaceMode ?? sourceWorkspaceMode) === "aldunis-managed";
  useEffect(() => {
    const eligible = destination === "shikigami" ? shikigamiProfiles : claudeProfiles;
    const fallback = destination === "shikigami" ? defaultShikigamiProfileId : defaultClaudeProfileId;
    if (!eligible.some((profile) => profile.id === profileId)) {
      setProfileId(fallback);
      if (destination === "shikigami") {
        setModel(resolveDefaultProviderModel(
          "shikigami",
          providerDiscoveryForProfile("shikigami", shikigamiProvider, fallback),
        ));
      }
    }
  }, [
    claudeProfiles,
    defaultClaudeProfileId,
    defaultShikigamiProfileId,
    destination,
    profileId,
    shikigamiProfiles,
    shikigamiProvider,
  ]);
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
    if (!preview || (requiresManagedWorkspace && !preparedWorkspaceRepository)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/forks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId,
          provider: destination,
          profileId: destination === "claude-code" || destination === "shikigami" ? profileId : null,
          model,
          expectedDigest: preview.digest,
          worktree: preparedWorkspaceRepository?.selectedWorktree,
          workspaceMode: requiresManagedWorkspace ? "aldunis-managed" : "shared",
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
    ? providerDiscoveryForProfile("shikigami", shikigamiProvider, profileId)
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
  if (cleanupDialogOpen && preparedWorkspaceRepository) {
    return (
      <WorktreeDialog
        repository={preparedWorkspaceRepository}
        selectedPath={preparedWorkspaceRepository.selectedWorktree}
        onClose={() => setCleanupDialogOpen(false)}
        onChanged={(next) => {
          setPreparedWorkspaceRepository(null);
          setCleanupDialogOpen(false);
          onRepositoryChanged?.(next);
        }}
      />
    );
  }
  if (workspaceDialogOpen) {
    return (
      <ConversationWorkspaceDialog
        repository={repository}
        conversationId={forkDestinationId}
        onClose={() => setWorkspaceDialogOpen(false)}
        onCreated={(next) => {
          setPreparedWorkspaceRepository(next);
          onRepositoryChanged?.(next);
          setWorkspaceDialogOpen(false);
        }}
      />
    );
  }
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
            <div><dt>Destination workspace</dt><dd>{requiresManagedWorkspace ? "New Aldunis-managed worktree" : "Shared source worktree"}</dd></div>
          </dl>
          {requiresManagedWorkspace && (
            <section className="fork-workspace-notice" aria-label="Prepare fork workspace">
              <strong>Prepare a dedicated destination worktree</strong>
              <p>
                The source conversation owns its Aldunis-managed worktree. This
                fork must use a different approved worktree before it can start.
              </p>
              {preparedWorkspaceRepository ? (
                <>
                  <p role="status">Destination: <code>{preparedWorkspaceRepository.selectedWorktree}</code></p>
                  {error && (
                    <Button type="button" onClick={() => setCleanupDialogOpen(true)} disabled={busy}>
                      Preview removal of unused worktree
                    </Button>
                  )}
                </>
              ) : (
                <Button type="button" onClick={() => setWorkspaceDialogOpen(true)} disabled={busy}>
                  Create destination worktree
                </Button>
              )}
            </section>
          )}
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
                if (next === "shikigami") {
                  const nextProfileId = shikigamiProfiles.some((profile) => profile.id === profileId)
                    ? profileId
                    : defaultShikigamiProfileId;
                  setProfileId(nextProfileId);
                  setModel(resolveDefaultProviderModel(
                    next,
                    providerDiscoveryForProfile("shikigami", shikigamiProvider, nextProfileId),
                  ));
                } else {
                  setModel(resolveDefaultProviderModel(next, providers.find((p) => p.id === next)));
                }
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
                disabled={sourceProvider === "shikigami" || !shikigamiReady}
              >
                Shikigami{!shikigamiReady ? " (not ready)" : ""}
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
            <>
              <label htmlFor="fork-profile-shikigami">Profile
                <select
                  id="fork-profile-shikigami"
                  name="fork-profile"
                  value={profileId}
                  onChange={(event) => {
                    const nextProfileId = event.target.value;
                    setProfileId(nextProfileId);
                    setModel(resolveDefaultProviderModel(
                      "shikigami",
                      providerDiscoveryForProfile("shikigami", shikigamiProvider, nextProfileId),
                    ));
                  }}
                >
                  {shikigamiProfiles.map((profile) => (
                    <option value={profile.id} key={profile.id}>{profile.name}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="fork-model-shikigami">Model
                <select
                  id="fork-model-shikigami"
                  name="fork-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {providerModelOptions("shikigami", destinationDiscovery).map((item) => (
                    <option value={item.id} key={item.id}>{item.displayName}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <footer>
            <Button onClick={onClose} disabled={busy} aria-label="Cancel fork">Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void create()}
              disabled={busy || unavailable || (requiresManagedWorkspace && !preparedWorkspaceRepository)}
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
