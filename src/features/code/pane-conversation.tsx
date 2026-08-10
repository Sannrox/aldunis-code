import React, { useEffect, useRef, useState } from "react";
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
import { loadChangedFiles, loadFreshChangedFiles } from "../../lib/changed-files-load";
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
  conversationOpenScroll = "latest",
  initialPrompt,
  initialProvider,
  projectConversations = [],
  promptStashOperatorKey = null,
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
  conversationOpenScroll?: "latest" | "remember";
  initialPrompt?: string;
  initialProvider?: ProviderId;
  projectConversations?: ConversationSummary[];
  promptStashOperatorKey?: string | null;
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const changesRequestSequenceReference = useRef(0);
  const [activePanel, setActivePanel] = useState<WorkspacePanel>("none");
  const refreshChanges = async (options: { fresh?: boolean } = {}) => {
    if (!repository) {
      changesRequestSequenceReference.current += 1;
      setChanges([]);
      setChangesError(null);
      setChangesLoading(false);
      return;
    }
    const sequence = ++changesRequestSequenceReference.current;
    setChangesLoading(true);
    setChangesError(null);
    try {
      // Boot shares inflight with the workbench sidebar badge; signal/manual
      // refreshes force-fresh so post-mutation panels are not stale.
      const load = options.fresh ? loadFreshChangedFiles : loadChangedFiles;
      const files = await load({
        root: repository.root,
        worktree: repository.selectedWorktree,
      });
      if (sequence !== changesRequestSequenceReference.current) return;
      setChanges(files);
    } catch (cause) {
      if (sequence !== changesRequestSequenceReference.current) return;
      setChangesError(
        cause instanceof Error ? cause.message : "Changed files could not be inspected.",
      );
    } finally {
      if (sequence === changesRequestSequenceReference.current) {
        setChangesLoading(false);
      }
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
      void refreshChanges({ fresh: true });
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
      conversationOpenScroll={conversationOpenScroll}
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
      onRefreshChanges={() => {
        void refreshChanges({ fresh: true });
      }}
      openChangesSignal={showChangesSignal}
      openChangesMode={showChangesMode}
      profiles={profiles}
      onOpenProfiles={onOpenProfiles}
      managedMode={managedMode}
      managedModel={managedModel}
      initialPrompt={initialPrompt}
      initialProvider={initialProvider}
      projectConversations={projectConversations}
      promptStashOperatorKey={promptStashOperatorKey}
    />
  );
}
