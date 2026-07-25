import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { RepositoryMetadata, ConversationSummary, ClaudeProfile, ChangedFile, ProviderId } from "../../types";
import { Conversation } from "./conversation";
import { MissingConversation } from "./missing-conversation";

export function PaneConversation({
  repository,
  conversation,
  pane,
  active,
  profiles,
  onOpenRepository,
  onOpenProfiles,
  onOpenBeside,
  onClosePane,
  onConversationAvailable,
  showChangesSignal,
  showFilesSignal,
  onManageWorktrees,
}: {
  repository: RepositoryMetadata | null;
  conversation: ConversationSummary | null;
  pane: "primary" | "secondary";
  active: boolean;
  profiles: ClaudeProfile[];
  onOpenRepository: () => void;
  onOpenProfiles: () => void;
  onOpenBeside: () => void;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  showChangesSignal: number;
  showFilesSignal: number;
  onManageWorktrees: (path?: string) => void;
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const refreshChanges = async () => {
    if (!repository) {
      setChanges([]);
      return;
    }
    setChangesLoading(true);
    setChangesError(null);
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch (cause) {
      setChangesError(cause instanceof Error ? cause.message : "Changed files could not be inspected.");
    } finally {
      setChangesLoading(false);
    }
  };
  useEffect(() => { void refreshChanges(); }, [repository?.root, repository?.selectedWorktree]);
  useEffect(() => { if (showChangesSignal > 0) { setChangesOpen(true); void refreshChanges(); } }, [showChangesSignal]);
  useEffect(() => { if (showFilesSignal > 0) setFilesOpen(true); }, [showFilesSignal]);
  return (
    <Conversation
      repository={repository}
      conversation={conversation}
      pane={pane}
      active={active}
      onOpenBeside={onOpenBeside}
      onClosePane={onClosePane}
      onConversationAvailable={onConversationAvailable}
      onOpenRepository={onOpenRepository}
      onManageWorktrees={() => onManageWorktrees()}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      changesOpen={changesOpen}
      onShowChanges={() => { setChangesOpen(true); void refreshChanges(); }}
      onHideChanges={() => setChangesOpen(false)}
      onRefreshChanges={refreshChanges}
      filesOpen={filesOpen}
      onBrowseFiles={() => setFilesOpen(true)}
      onHideFiles={() => setFilesOpen(false)}
      profiles={profiles}
      onOpenProfiles={onOpenProfiles}
    />
  );
}


