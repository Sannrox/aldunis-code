import React, { useEffect, useState } from "react";
import type {
  RepositoryMetadata,
  ConversationSummary,
  ClaudeProfile,
  ChangedFile,
  ProviderId,
} from "../../types";
import type { WorkspacePanel } from "../../lib/workspace-panel";
import type { SavedProject } from "../dialogs/repository-dialog";
import type { ChangesPanelMode } from "../changes/changes-panel";
import { Conversation } from "./conversation";

export function PaneConversation({
  repository,
  conversation,
  pane,
  active,
  profiles,
  onOpenRepository,
  projects,
  onAddProject,
  onSelectProject,
  onOpenProfiles,
  onOpenBeside,
  showOpenBeside = true,
  onClosePane,
  onConversationAvailable,
  onRepositoryChanged,
  onSelectWorktree,
  showChangesSignal,
  showChangesThreadId,
  onChangesRequestConsumed,
  showChangesMode = "review",
  showFilesSignal,
  onManageWorktrees,
  managedMode = false,
  managedModel,
  quietDelegatedChild = false,
  showThinking = false,
  initialPrompt,
  initialProvider,
  projectConversations = [],
}: {
  repository: RepositoryMetadata | null;
  conversation: ConversationSummary | null;
  pane: "primary" | "secondary";
  active: boolean;
  profiles: ClaudeProfile[];
  onOpenRepository: () => void;
  projects?: SavedProject[];
  onAddProject: () => void;
  onSelectProject: (projectId: string) => void;
  onOpenProfiles: (provider?: ProviderId) => void;
  onOpenBeside: () => void;
  showOpenBeside?: boolean;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
  onSelectWorktree: (path: string) => void;
  showChangesSignal: number;
  showChangesThreadId?: string | null;
  onChangesRequestConsumed?: (signal: number) => void;
  showChangesMode?: ChangesPanelMode;
  showFilesSignal: number;
  onManageWorktrees: (path?: string) => void;
  managedMode?: boolean;
  managedModel?: string;
  quietDelegatedChild?: boolean;
  showThinking?: boolean;
  initialPrompt?: string;
  initialProvider?: ProviderId;
  projectConversations?: ConversationSummary[];
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<WorkspacePanel>("none");
  const refreshChanges = async () => {
    if (!repository) {
      setChanges([]);
      setChangesError(null);
      setChangesLoading(false);
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
      const body = (await response.json()) as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch (cause) {
      setChangesError(
        cause instanceof Error ? cause.message : "Changed files could not be inspected.",
      );
    } finally {
      setChangesLoading(false);
    }
  };
  useEffect(() => {
    void refreshChanges();
  }, [repository?.root, repository?.selectedWorktree, conversation?.id]);
  useEffect(() => {
    if (
      showChangesSignal > 0 &&
      (!showChangesThreadId || conversation?.id === showChangesThreadId)
    ) {
      setActivePanel("changes");
      void refreshChanges();
      onChangesRequestConsumed?.(showChangesSignal);
    }
  }, [conversation?.id, onChangesRequestConsumed, showChangesSignal, showChangesThreadId]);
  useEffect(() => {
    if (showFilesSignal > 0) setActivePanel("files");
  }, [showFilesSignal]);
  useEffect(() => {
    if (!repository) setActivePanel("none");
  }, [repository]);
  return (
    <Conversation
      repository={repository}
      conversation={conversation}
      pane={pane}
      active={active}
      quietDelegatedChild={quietDelegatedChild}
      showThinking={showThinking}
      onOpenBeside={onOpenBeside}
      showOpenBeside={showOpenBeside}
      onClosePane={onClosePane}
      onConversationAvailable={onConversationAvailable}
      onRepositoryChanged={onRepositoryChanged}
      onSelectWorktree={onSelectWorktree}
      onOpenRepository={onOpenRepository}
      projects={projects}
      onAddProject={onAddProject}
      onSelectProject={onSelectProject}
      onManageWorktrees={() => onManageWorktrees()}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      activePanel={activePanel}
      onPanelChange={setActivePanel}
      onRefreshChanges={refreshChanges}
      openChangesSignal={showChangesSignal}
      openChangesMode={showChangesMode}
      profiles={profiles}
      onOpenProfiles={onOpenProfiles}
      managedMode={managedMode}
      managedModel={managedModel}
      initialPrompt={initialPrompt}
      initialProvider={initialProvider}
      projectConversations={projectConversations}
    />
  );
}
