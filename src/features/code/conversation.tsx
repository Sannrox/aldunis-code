import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  RepositoryMetadata,
  ConversationSummary,
  ClaudeProfile,
  ProviderId,
  ProviderDiscovery,
  ProviderCapabilities,
  ProviderState,
  ProviderEvent,
  ProviderSkill,
  InteractionMode,
  ReasoningEffort,
  ProviderBrowserObservation,
  ChangedFile,
  TurnCheckpoint,
  ElementReference,
  ContextPin,
  ContextReceipt,
  WorkspaceMode,
} from "../../types";
import { Button } from "../../components/ui";
import { Icon } from "../../components/icon";
import { OptionalControlBoundary } from "../../components/optional-control-boundary";
import type { ChangesPanelMode } from "../changes/changes-panel";
import { EnvironmentControl } from "./environment-control";
import type { PreviewPanelStatus } from "../preview/preview-panel";
import {
  BUILTIN_NEW_CONVERSATION_PROVIDER_ORDER,
  assessProviderRunReadiness,
  canSwitchNewConversationProvider,
  parseProviderFailure,
  providerAvatarInitials,
  providerChipName as formatProviderChipName,
  providerDiscoveryForProfile,
  providerDisplayName,
  providerListLabel,
  providerModelLabel,
  resolveDefaultProviderModel,
  normalizeClaudeModelSlug,
  providerModelOptions,
  providerReasoningEfforts,
  providerConfigurationVerifiedAfterFailure,
  providerFailureRecovery,
  providerFailureNeedsConfiguration,
  providerTextReportsAuthenticationFailure,
} from "../../lib/provider-readiness";
import { joinAssistantTextChunks } from "../../lib/assistant-text";
import { initialConversationRunState, reduceConversationRun } from "../../lib/conversation-run";
import { ConversationTurnSessionModule } from "../../lib/conversation-turn-session";
import { ConversationLifecycleControl } from "../../lib/conversation-lifecycle-control";
import { useWorkspaceRewindSession } from "./workspace-rewind-session";
import { ContextWindowMeter } from "./context-window-meter";
import {
  clearComposerDraft,
  composerDraftKey,
  loadComposerDraft,
  saveComposerDraft,
} from "../../lib/composer-draft-stash";
import {
  getComposerRunSettingsStorage,
  readComposerRunSettings,
  resolveNewConversationRunSettings,
  writeComposerRunSettings,
} from "../../lib/composer-run-settings";
import { resolvePreviousWorktreeSeed } from "../../lib/previous-worktree";
import {
  clearManagedPromptStashes,
  createPromptStash,
  getPromptStashStorage,
  matchesPromptStashShortcut,
  PROMPT_STASH_SHORTCUT_LABEL,
  resolveActivePromptStashScope,
  stashEntrySnippet,
  type PromptStashEntry,
} from "../../lib/composer-prompt-stash";
import {
  draftForPromptHistoryIndex,
  isBrowsingPromptHistory,
  isComposerHistoryBoundary,
  promptHistoryFromMessages,
  resetPromptHistoryBrowse,
  stepPromptHistoryDown,
  stepPromptHistoryUp,
  type PromptHistoryBrowse,
} from "../../lib/composer-prompt-history";
import { supportsComposerFieldSizing, syncComposerHeight } from "../../lib/composer-height";
import {
  createVoiceInputModule,
  initialVoiceInputSnapshot,
  matchesVoiceInputShortcut,
  VOICE_INPUT_SHORTCUT_LABEL,
} from "../../lib/voice-input";
import {
  buildComposerCommandItems,
  buildComposerPathItems,
  buildComposerSkillItems,
  getComposerTrigger,
  groupComposerCommandItems,
  replaceComposerTrigger,
  type ComposerCommandItem,
  type ComposerSuggestionMode,
} from "../../lib/composer-commands";
import {
  collectComposerImagesFromClipboard,
  collectComposerImagesFromDataTransfer,
  dataTransferHasFiles,
} from "../../lib/composer-images";
import { stageComposerImages, stageComposerImageWithHost } from "../../lib/composer-image-staging";
import type { ConversationOpenScroll } from "../../lib/thread-open-scroll";
import { useTranscriptViewport } from "../../lib/transcript-viewport";
import { loadConversationHistory, loadFreshConversationHistory } from "../../lib/local-state-load";
import { useComposerPopoverInteraction } from "../../lib/composer-popover-interaction";
import {
  loadProviderCapabilities,
  peekProviderCapabilitiesCache,
} from "../../lib/provider-capabilities-cache";
import {
  invalidateProviderDiscoveryCacheForEvent,
  loadProviderDiscovery,
  peekProviderDiscoveryCache,
  providerDiscoveryTimedOut,
  PROVIDER_DISCOVERY_TIMEOUT_DETAIL,
} from "../../lib/provider-discovery-cache";
import {
  WORKSPACE_PANEL_DESTINATIONS,
  initialWorkspacePanelLifecycle,
  transitionWorkspacePanelLifecycle,
  workspacePanelTabStop,
  workspacePanelToggleHeld,
  type WorkspacePanel,
  type WorkspacePanelDestination,
  type WorkspacePanelLifecycleEvent,
} from "../../lib/workspace-panel";
import { WorkspacePanelPendingFallback } from "./workspace-panel-pending";
import { isRepositoryRelativeContextPinPath } from "../../lib/context-pins";
import {
  presentAssistantTimeline,
  type AssistantTimelineBlock,
} from "../../lib/conversation-timeline";
import { latestPlanFromEvents } from "../../lib/provider-plan";
import { buildWorkGraph, hasWorkGraphEvidence } from "../../lib/work-graph";
import {
  shouldRefreshAfterRestoredTurn,
  type RestoredTurnStatus,
} from "../../lib/thread-status-transition";
import {
  persistedConversationRestorationFingerprint,
  reconcilePersistedRestorationApplication,
  restorePersistedConversation,
  type PersistedRestorationApplication,
  type PersistedConversationProjection,
} from "../../lib/persisted-conversation-restoration";
import { startPersistedConversationPolling } from "../../lib/persisted-conversation-polling";
import { conversationResourceTarget } from "../../lib/conversation-resource-target";
import { MarkdownBody } from "../../components/markdown-body";
import { formatElapsed } from "./conversation-list";
import { shouldNotifyForRestoredTurn } from "./delegated-outcomes";
import { ProviderPlanActions, ProviderPlanCard, ProviderPlanContent } from "./provider-plan";
import { WorkGraphContent } from "./work-graph";
import { ContextPackagePanel, ContextPackageSummary } from "./context-package";
import { MessageCopyButton } from "./message-copy-button";
import { ToolActivity } from "./tool-activity";
import {
  defaultWorkspaceMode,
  NEW_CONVERSATION_WORKSPACE_MODES,
  WORKSPACE_MODE_COPY,
} from "../../lib/workspace-mode";
import type { SavedProject } from "../dialogs/repository-dialog";

const ForkConversationDialog = React.lazy(async () => ({
  default: (await import("../dialogs/fork-conversation-dialog")).ForkConversationDialog,
}));
const ChangesPanel = React.lazy(async () => ({
  default: (await import("../changes/changes-panel")).ChangesPanel,
}));
const FileBrowserPanel = React.lazy(async () => ({
  default: (await import("../files/file-browser-panel")).FileBrowserPanel,
}));
const PreviewPanel = React.lazy(async () => ({
  default: (await import("../preview/preview-panel")).PreviewPanel,
}));
const ConversationWorkspaceDialog = React.lazy(async () => ({
  default: (await import("../dialogs/conversation-workspace-dialog")).ConversationWorkspaceDialog,
}));
const ReleaseWorktreeDialog = React.lazy(async () => ({
  default: (await import("../dialogs/release-worktree-dialog")).ReleaseWorktreeDialog,
}));

export function readyComposerPlaceholder(providerName: string, threadId: string | null): string {
  return threadId ? `Reply to ${providerName}…` : "What should we build, fix, or review?";
}

type PlanPanelMode = "plan" | "graph";

/** Join assistant text blocks while preserving timeline boundaries around tools/plans. */
export function assistantTextFromEvents(events: readonly ProviderEvent[]): string {
  return presentAssistantTimeline([...events])
    .filter(
      (block): block is Extract<AssistantTimelineBlock, { kind: "text" }> => block.kind === "text",
    )
    .map((block) => block.text)
    .join("\n\n");
}

function TurnCopyAction({ text, label }: { text: string; label: string }) {
  if (!text.trim()) return null;
  return (
    <div className="turn-actions">
      <MessageCopyButton text={text} label={label} />
    </div>
  );
}

export function providerProfileDisplayName(
  profiles: ClaudeProfile[],
  provider: ProviderId,
  profileId: string,
): string | null {
  if (provider !== "claude-code" && provider !== "shikigami") return null;
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) return null;
  if (provider === "claude-code" && profile.provider && profile.provider !== "claude-code")
    return null;
  if (provider === "shikigami" && profile.provider !== "shikigami") return null;
  return profile.name;
}

/**
 * Keep the native worktree select usable when a repository exposes many
 * branches. The selected worktree remains visible while filtering so typing
 * cannot make the controlled select appear to lose its value.
 */
export function filterSelectableWorktrees(
  worktrees: RepositoryMetadata["worktrees"],
  query: string,
  selectedPath: string | null,
): RepositoryMetadata["worktrees"] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return worktrees;
  const matches = worktrees.filter((item) =>
    `${formatWorktreeOptionLabel(item)} ${item.path} ${item.ownership}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  const selected = selectedPath ? worktrees.find((item) => item.path === selectedPath) : undefined;
  if (selected && !matches.some((item) => item.path === selected.path)) {
    return [selected, ...matches];
  }
  return matches;
}

/**
 * Native <option> text is the only visual cue in the worktree picker. When
 * several checkouts are detached, a bare "Detached HEAD" label is ambiguous —
 * keep the branch name when present and append a short path tail otherwise.
 */
export function formatWorktreeOptionLabel(item: { branch: string | null; path: string }): string {
  if (item.branch) return item.branch;
  const segments = item.path.replaceAll("\\", "/").split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/") || item.path;
  return `Detached HEAD · ${tail}`;
}

const STARTER_PROMPTS = [
  { label: "Fix a bug", value: "Fix a bug in this repository" },
  { label: "Review changes", value: "Review the current changes in this repository" },
  { label: "Explain the codebase", value: "Explain the structure of this codebase" },
] as const;

const NEW_CONVERSATION_WORKSPACE_COPY: Record<
  WorkspaceMode,
  {
    label: string;
    summary: string;
    detail: string;
  }
> = {
  shared: {
    label: "Shared checkout",
    summary: "Use the selected worktree",
    detail: "Use the selected worktree for this conversation. Other conversations can share it.",
  },
  "aldunis-managed": {
    label: "Dedicated worktree",
    summary: "One isolated worktree for this chat",
    detail: "Aldunis creates and binds a dedicated Git worktree after one approval.",
  },
  "provider-native": {
    label: "Provider-owned workspace",
    summary: "The provider owns the isolated workspace",
    detail: "The selected provider creates and owns the workspace when this adapter supports it.",
  },
};

const conversationTurnSession = new ConversationTurnSessionModule();

export function formatHostLabel(hostname: string | undefined): string {
  return !hostname ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
    ? "Local Aldunis host"
    : hostname;
}

export { appendProviderEvent, preserveInputResolution } from "../../lib/conversation-run";

export { restoredTurnTerminalEvent } from "../../lib/persisted-conversation-restoration";

export function GovernanceCorrelationSummary({
  correlation,
}: {
  correlation: Extract<ProviderEvent, { kind: "governance_correlation" }>;
}) {
  return (
    <aside className="governance-correlation" aria-label="Direct governed run correlation">
      <div>
        <strong>Direct governed</strong>
        <span>Shikigami run</span>
      </div>
      <code>{correlation.operationId}</code>
      <Button
        type="button"
        disabled={!correlation.correlationId}
        onClick={() => {
          if (!correlation.correlationId) return;
          window.dispatchEvent(
            new CustomEvent("aldunis:inspect-chisei-operation", {
              detail: { correlationId: correlation.correlationId },
            }),
          );
        }}
      >
        Inspect in Chisei
      </Button>
    </aside>
  );
}

function TurnChangesCard({
  checkpoint,
  pane,
  onOpen,
}: {
  checkpoint?: TurnCheckpoint | null;
  pane: "primary" | "secondary";
  onOpen: (checkpoint: TurnCheckpoint) => void;
}) {
  if (
    (checkpoint?.state !== "completed" && checkpoint?.state !== "superseded") ||
    !checkpoint.files?.length
  )
    return null;
  const files = checkpoint.files;
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const visibleFiles = files.slice(0, 8);
  const hasLineStats = files.some(
    (file) => typeof file.additions === "number" || typeof file.deletions === "number",
  );
  return (
    <section
      className="turn-changes-card"
      aria-label={`Changed files from this turn, ${pane} pane`}
    >
      <header>
        <div>
          <strong>Changed files</strong>
          <small>
            {files.length} {files.length === 1 ? "file" : "files"}
            {hasLineStats && (
              <>
                {" "}
                · <b className="ok">+{additions}</b> <b className="bad">−{deletions}</b>
              </>
            )}
          </small>
        </div>
        <button
          type="button"
          className="turn-changes-open"
          onClick={() => onOpen(checkpoint)}
          aria-label={`Review ${files.length} changed files from this turn, ${pane} pane`}
        >
          Review turn
        </button>
      </header>
      <ul>
        {visibleFiles.map((file) => (
          <li key={`${file.path}-${file.previousPath ?? ""}`}>
            <span className={`change-state ${file.state}`}>{file.state}</span>
            <span title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
              {file.previousPath ? `${file.previousPath} → ` : ""}
              {file.path}
            </span>
            {hasLineStats && (
              <small>
                {file.additions == null ? "—" : `+${file.additions}`}{" "}
                {file.deletions == null ? "—" : `−${file.deletions}`}
              </small>
            )}
          </li>
        ))}
        {files.length > visibleFiles.length && (
          <li className="turn-changes-more">+{files.length - visibleFiles.length} more files</li>
        )}
      </ul>
    </section>
  );
}

export function Conversation({
  repository,
  conversation,
  pane,
  active,
  onOpenBeside,
  showOpenBeside = true,
  onClosePane,
  onConversationAvailable,
  onRepositoryChanged,
  onSelectWorktree,
  onOpenRepository,
  projects = [],
  onAddProject,
  onSelectProject,
  onManageWorktrees,
  changes,
  changesLoading,
  changesError,
  activePanel,
  onPanelChange,
  onRefreshChanges,
  openChangesSignal = 0,
  openChangesMode = "review",
  profiles,
  onOpenProfiles,
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
  onOpenBeside: () => void;
  /** Hide primary topbar Open beside when a secondary pane is already open. */
  showOpenBeside?: boolean;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
  onSelectWorktree: (path: string) => void;
  onOpenRepository: () => void;
  projects?: SavedProject[];
  onAddProject: () => void;
  onSelectProject: (projectId: string) => void;
  onManageWorktrees: () => void;
  changes: ChangedFile[];
  changesLoading: boolean;
  changesError: string | null;
  activePanel: WorkspacePanel;
  onPanelChange: (panel: WorkspacePanel) => void;
  onRefreshChanges: () => void;
  openChangesSignal?: number;
  openChangesMode?: ChangesPanelMode;
  profiles: ClaudeProfile[];
  onOpenProfiles: (provider?: ProviderId) => void;
  managedMode?: boolean;
  managedModel?: string;
  showThinking?: boolean;
  /** Jump to latest message, or restore the last scroll place for this thread. */
  conversationOpenScroll?: ConversationOpenScroll;
  /** Suppress ordinary child completion notifications while its linked parent is focused. */
  quietDelegatedChild?: boolean;
  /** One-shot bounded brief for a new conversation opened by a domain handoff. */
  initialPrompt?: string;
  initialProvider?: ProviderId;
  /** Project peers used for previous-worktree seed on new conversations. */
  projectConversations?: ConversationSummary[];
  /**
   * Managed-operator identity for the explicit prompt-stash queue. Includes
   * assertion/session expiry so re-auth starts a fresh memory bucket.
   */
  promptStashOperatorKey?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const promptStashScope = useMemo(
    () => resolveActivePromptStashScope(getPromptStashStorage(), promptStashOperatorKey),
    [promptStashOperatorKey],
  );
  const promptStashModule = useMemo(() => createPromptStash(promptStashScope), [promptStashScope]);
  const previousManagedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!promptStashScope.startsWith("managed:")) {
      if (previousManagedScopeRef.current) {
        clearManagedPromptStashes();
        previousManagedScopeRef.current = null;
      }
      return;
    }
    if (previousManagedScopeRef.current && previousManagedScopeRef.current !== promptStashScope) {
      clearManagedPromptStashes();
    }
    previousManagedScopeRef.current = promptStashScope;
  }, [promptStashScope]);
  const [promptStash, setPromptStash] = useState<PromptStashEntry[]>(() =>
    createPromptStash(
      resolveActivePromptStashScope(getPromptStashStorage(), promptStashOperatorKey),
    ).load(),
  );
  const [stashMenuOpen, setStashMenuOpen] = useState(false);
  const [stashStatus, setStashStatus] = useState<string | null>(null);
  const [stashPulse, setStashPulse] = useState(false);
  const stashPulseTimerRef = useRef<number | null>(null);
  const stashMenuRef = useRef<HTMLDivElement | null>(null);
  const [voiceInputSnapshot, setVoiceInputSnapshot] = useState(initialVoiceInputSnapshot);
  const [voiceInputModule] = useState(() =>
    createVoiceInputModule({ onDraftChange: setDraft, onSnapshotChange: setVoiceInputSnapshot }),
  );
  const {
    state: voiceInputState,
    interimTranscript: voiceInputInterim,
    error: voiceInputError,
  } = voiceInputSnapshot;

  useEffect(() => {
    voiceInputModule.activate();
    return () => voiceInputModule.dispose();
  }, [voiceInputModule]);
  useEffect(() => {
    if (active) return;
    voiceInputModule.reset();
  }, [active, voiceInputModule]);
  const [messages, setMessages] = useState<
    Array<{ text: string; mode: InteractionMode; createdAt?: string }>
  >([]);
  const [archivedTurns, setArchivedTurns] = useState<
    Array<{
      message: { text: string; mode: InteractionMode; createdAt?: string };
      events: ProviderEvent[];
      assistantAt?: string;
      state: RestoredTurnStatus;
      contextReceipt?: ContextReceipt;
      checkpoint?: TurnCheckpoint;
    }>
  >([]);
  /** Shell-style ↑/↓ recall over sent user prompts (conversation-local). */
  const promptHistory = useMemo(() => promptHistoryFromMessages(messages), [messages]);
  const [promptHistoryBrowse, setPromptHistoryBrowse] = useState<PromptHistoryBrowse>(() =>
    resetPromptHistoryBrowse([]),
  );
  useEffect(() => {
    setPromptHistoryBrowse(resetPromptHistoryBrowse(promptHistory));
  }, [promptHistory]);
  const [mode, setMode] = useState<InteractionMode>(() => {
    if (managedMode) return "build";
    if (conversation) return "ask";
    return resolveNewConversationRunSettings({
      stored: readComposerRunSettings(getComposerRunSettingsStorage()),
      initialProvider,
    }).mode;
  });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    if (managedMode) return "shared";
    if (conversation?.workspaceMode) {
      return defaultWorkspaceMode("ask", conversation.workspaceMode);
    }
    if (conversation) return defaultWorkspaceMode("ask", null);
    return resolveNewConversationRunSettings({
      stored: readComposerRunSettings(getComposerRunSettingsStorage()),
      initialProvider,
    }).workspaceMode;
  });
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [preparedWorkspaceRepository, setPreparedWorkspaceRepository] =
    useState<RepositoryMetadata | null>(null);
  const [workspaceApprovalPending, setWorkspaceApprovalPending] = useState(false);
  const [conversationRun, dispatchConversationRun] = useReducer(
    reduceConversationRun,
    undefined,
    initialConversationRunState,
  );
  const runEpochReference = useRef(0);
  const {
    events: providerEvents,
    contextUsage,
    providerState,
    sessionId,
    assistantTurnAt,
  } = conversationRun;
  /** Live context pressure from the provider stream — not durable history. */
  const [runId, setRunId] = useState<string | null>(null);
  const [historyRestored, setHistoryRestored] = useState(() => conversation === null);
  const [historyRestoreError, setHistoryRestoreError] = useState<string | null>(null);
  const [conversationId] = useState(() => conversation?.id ?? crypto.randomUUID());
  const [threadId, setThreadId] = useState<string | null>(conversation?.id ?? null);
  const lifecycleControl = new ConversationLifecycleControl(async () => {
    if (threadId) onConversationAvailable?.(threadId);
  });
  const [attachments, setAttachments] = useState<string[]>([]);
  const [folderPins, setFolderPins] = useState<string[]>([]);
  const [composerDragDepth, setComposerDragDepth] = useState(0);
  const [composerImageBusy, setComposerImageBusy] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [draftContextReceipt, setDraftContextReceipt] = useState<ContextReceipt | null>(null);
  useLayoutEffect(() => {
    // Native field-sizing grows the textarea without reading layout geometry.
    if (supportsComposerFieldSizing()) return;
    if (composerRef.current) syncComposerHeight(composerRef.current);
  }, [draft]);
  useLayoutEffect(() => {
    if (supportsComposerFieldSizing()) return;
    const composer = composerRef.current;
    if (!composer) return;
    let width = composer.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      syncComposerHeight(composer);
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const [currentContextReceipt, setCurrentContextReceipt] = useState<ContextReceipt | null>(null);
  const [contextPackageBusy, setContextPackageBusy] = useState(false);
  const contextPins = useMemo<ContextPin[]>(
    () => [
      ...attachments.map((path) => ({ path, kind: "file" as const })),
      ...folderPins.map((path) => ({ path, kind: "folder" as const })),
    ],
    [attachments, folderPins],
  );
  const [suggestions, setSuggestions] = useState<ComposerCommandItem[]>([]);
  const [suggestionMode, setSuggestionMode] = useState<ComposerSuggestionMode | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [contextError, setContextError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(() =>
    peekProviderCapabilitiesCache(),
  );
  const [providerSkills, setProviderSkills] = useState<ProviderSkill[]>([]);
  const [profileId, setProfileId] = useState(() => {
    if (managedMode || conversation) return "";
    return (
      resolveNewConversationRunSettings({
        stored: readComposerRunSettings(getComposerRunSettingsStorage()),
        initialProvider,
      }).profileId ?? ""
    );
  });
  const claudeProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider === "claude-code" || !profile.provider),
    [profiles],
  );
  const defaultClaudeProfileId =
    claudeProfiles.find((profile) => profile.id === "default:claude-code")?.id ??
    claudeProfiles[0]?.id ??
    "";
  const shikigamiProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider === "shikigami"),
    [profiles],
  );
  const defaultShikigamiProfileId =
    shikigamiProfiles.find((profile) => profile.id === "default:shikigami")?.id ??
    shikigamiProfiles[0]?.id ??
    "";
  const [model, setModel] = useState(() => {
    if (managedMode) return managedModel ?? "default";
    if (conversation) return "default";
    return resolveNewConversationRunSettings({
      stored: readComposerRunSettings(getComposerRunSettingsStorage()),
      managedModel,
      initialProvider,
    }).model;
  });
  const [notificationsEnabled] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const lastAttentionState = useRef<string | null>(null);
  const appliedRestoration = useRef<PersistedRestorationApplication>(null);
  const restoredTurnStatus = useRef<{
    turnId: string;
    status: RestoredTurnStatus;
  } | null>(null);
  const conversationAvailableCallback = useRef(onConversationAvailable);
  conversationAvailableCallback.current = onConversationAvailable;
  // Seed from the bound thread so reopen never flashes Claude readiness for Codex/Grok.
  // New chats reuse last-selected run settings from browser storage.
  const [provider, setProvider] = useState<ProviderId>(() => {
    if (managedMode) return "shikigami";
    if (conversation?.provider) return conversation.provider;
    return resolveNewConversationRunSettings({
      stored: readComposerRunSettings(getComposerRunSettingsStorage()),
      initialProvider,
    }).provider;
  });
  const initialPromptAppliedReference = useRef(false);
  useEffect(() => {
    if (conversation !== null || !initialPrompt || initialPromptAppliedReference.current) return;
    initialPromptAppliedReference.current = true;
    setDraft(initialPrompt);
    if (initialProvider) setProvider(initialProvider);
    setMode("build");
  }, [conversation, initialPrompt, initialProvider]);
  const providerDiscoveryContext = useMemo(
    () =>
      repository?.root && repository.selectedWorktree
        ? { root: repository.root, worktree: repository.selectedWorktree }
        : {},
    [repository?.root, repository?.selectedWorktree],
  );
  const [providers, setProviders] = useState<ProviderDiscovery[]>(
    () => peekProviderDiscoveryCache(providerDiscoveryContext) ?? [],
  );
  /** False until first /api/providers/discover settles — avoids “Install CLI” flash. */
  const [providersLoaded, setProvidersLoaded] = useState(
    () => peekProviderDiscoveryCache(providerDiscoveryContext) !== null,
  );
  const [forkOpen, setForkOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planPanelMode, setPlanPanelMode] = useState<PlanPanelMode>("plan");
  const [selectedPlanKey, setSelectedPlanKey] = useState<string | null>(null);
  const [inputAnswers, setInputAnswers] = useState<Record<string, string>>({});
  const [inputBusyId, setInputBusyId] = useState<string | null>(null);
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0);
  const planTriggerRef = useRef<HTMLButtonElement>(null);
  const workGraphTriggerRef = useRef<HTMLButtonElement>(null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    if (conversation?.reasoningEffort) return conversation.reasoningEffort;
    if (conversation || managedMode) return "medium";
    return resolveNewConversationRunSettings({
      stored: readComposerRunSettings(getComposerRunSettingsStorage()),
      initialProvider,
    }).reasoningEffort;
  });
  const legacyReasoningDefaultRef = useRef<string | null>(null);
  const providerDiscoveryLoadRef = useRef(0);
  const loadProviders = useCallback(
    (showPending = false) => {
      const loadId = ++providerDiscoveryLoadRef.current;
      if (showPending) {
        setProvidersLoaded(false);
      }
      void loadProviderDiscovery(providerDiscoveryContext)
        .then((list) => {
          if (providerDiscoveryLoadRef.current === loadId) setProviders(list);
        })
        .finally(() => {
          if (providerDiscoveryLoadRef.current === loadId) setProvidersLoaded(true);
        });
    },
    [providerDiscoveryContext],
  );
  // When a URL project is restoring, wait for repository/worktree context so we
  // do not pay for a global discover and then immediately a worktree-scoped one.
  const waitingForRepositoryRestore =
    !repository?.root &&
    typeof window !== "undefined" &&
    Boolean(new URLSearchParams(window.location.search).get("project"));
  useEffect(() => {
    // Soft re-check keeps an existing cache visible while probing again. Force
    // (invalidate) is reserved for explicit retries and adapter package changes.
    let delayed: ReturnType<typeof setTimeout> | undefined;
    if (waitingForRepositoryRestore) {
      delayed = setTimeout(() => loadProviders(true), 2_000);
    } else {
      loadProviders(true);
    }
    const onAdaptersChanged = (event: Event) => {
      invalidateProviderDiscoveryCacheForEvent(event);
      loadProviders();
    };
    const onProviderRetry = (event: Event) => {
      invalidateProviderDiscoveryCacheForEvent(event);
      loadProviders(true);
    };
    window.addEventListener("aldunis:adapters-changed", onAdaptersChanged);
    window.addEventListener("aldunis:providers-retry", onProviderRetry);
    return () => {
      providerDiscoveryLoadRef.current += 1;
      if (delayed) clearTimeout(delayed);
      window.removeEventListener("aldunis:adapters-changed", onAdaptersChanged);
      window.removeEventListener("aldunis:providers-retry", onProviderRetry);
    };
  }, [loadProviders, waitingForRepositoryRestore]);
  const codex = providers.find((item) => item.id === "codex-cli");
  const shikigamiProvider = providers.find((item) => item.id === "shikigami");
  const selectedProvider = providerDiscoveryForProfile(
    provider,
    providers.find((item) => item.id === provider),
    profileId,
  );
  const discoveryTimedOut = providerDiscoveryTimedOut(providerDiscoveryContext);
  const providerName = providerDisplayName(provider, selectedProvider);
  /** Short role label in the transcript (Claude / Codex / Grok Build / …). */
  const providerLabel = providerListLabel(provider);
  /** Compact composer chip text — adapters use presentation names, not raw ids. */
  const providerChipName = formatProviderChipName(provider, selectedProvider);
  const selectedProfileName = providerProfileDisplayName(profiles, provider, profileId);
  const [worktreeFilter, setWorktreeFilter] = useState("");
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const composerPopovers = useComposerPopoverInteraction({
    provider: { container: providerMenuRef, optionSelector: "[data-provider-option]" },
    model: { container: modelMenuRef, optionSelector: "[data-model-option]" },
    mode: { container: modeMenuRef, optionSelector: "[data-mode-option]" },
    project: { container: projectMenuRef, optionSelector: "[data-project-option]" },
    workspace: { container: workspaceMenuRef, optionSelector: "[data-workspace-option]" },
  });
  const providerMenuOpen = composerPopovers.isOpen("provider");
  const modelMenuOpen = composerPopovers.isOpen("model");
  const modeMenuOpen = composerPopovers.isOpen("mode");
  const projectMenuOpen = composerPopovers.isOpen("project");
  const workspaceMenuOpen = composerPopovers.isOpen("workspace");
  const INTERACTION_MODES: InteractionMode[] = ["ask", "plan", "build"];
  /**
   * Providers a *new* conversation can start with. Existing threads keep their
   * stored provider (cross-provider moves go through the reviewed fork flow).
   */
  /**
   * Providers offered in the new-conversation menu. Installed-but-not-ready
   * entries stay selectable so the composer can show readiness detail (sign-in,
   * upgrade) instead of hiding the choice entirely.
   */
  const availableProviders = useMemo(() => {
    if (managedMode)
      return shikigamiProvider?.installed === false ? [] : ["shikigami" as ProviderId];
    const shikigamiInstalled = Boolean(
      shikigamiProvider?.installed ||
      shikigamiProvider?.profileDiscoveries?.some((profile) => profile.installed),
    );
    const list: ProviderId[] = [];
    const claude = providers.find((item) => item.id === "claude-code");
    for (const id of BUILTIN_NEW_CONVERSATION_PROVIDER_ORDER) {
      if (id === "codex-cli" && codex?.installed) list.push(id);
      // Keep Claude selectable when installed; empty profiles disable send, not the choice.
      if (id === "claude-code" && (!claude || claude.installed !== false)) list.push(id);
      if (id === "shikigami" && shikigamiInstalled) list.push(id);
    }
    for (const item of providers) {
      if (
        typeof item.id === "string" &&
        item.id.startsWith("adapter:") &&
        item.installed !== false &&
        item.enabled !== false
      ) {
        list.push(item.id);
      }
    }
    return list;
  }, [codex?.installed, managedMode, shikigamiProvider, providers]);
  /**
   * New conversations only, before a thread/run is created. Once threadId or
   * runId exists the provider is fixed (cross-provider moves use fork).
   * No automatic fallback effect — that races profile loading and can steal
   * the Claude default mid-flight.
   */
  const canSwitchProvider =
    conversation === null &&
    !threadId &&
    !runId &&
    !managedMode &&
    canSwitchNewConversationProvider(provider, availableProviders);
  const canPickWorkspace = conversation === null && !threadId && !runId && !managedMode;
  useEffect(() => {
    setWorktreeFilter("");
  }, [repository?.projectId]);
  useEffect(() => {
    return () => {
      if (stashPulseTimerRef.current !== null) window.clearTimeout(stashPulseTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!stashMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && stashMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[data-prompt-stash-badge="${pane}"]`)) {
        return;
      }
      setStashMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setStashMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pane, stashMenuOpen]);
  const pulseStashBadge = useCallback(() => {
    setStashPulse(true);
    if (stashPulseTimerRef.current !== null) window.clearTimeout(stashPulseTimerRef.current);
    stashPulseTimerRef.current = window.setTimeout(() => {
      setStashPulse(false);
      stashPulseTimerRef.current = null;
    }, 450);
  }, []);
  const loadLatestPromptStash = useCallback(() => {
    const latest = promptStashModule.load();
    setPromptStash(latest);
    return latest;
  }, [promptStashModule]);
  useEffect(() => {
    if (!active) return;
    loadLatestPromptStash();
  }, [active, loadLatestPromptStash, promptStashScope]);
  const stashCurrentDraft = useCallback(() => {
    const result = promptStashModule.stash(draft);
    setPromptStash(result.entries);
    setStashStatus(result.message);
    if (!result.ok) return false;
    setDraft("");
    setPromptHistoryBrowse(resetPromptHistoryBrowse(promptHistory));
    setStashMenuOpen(false);
    pulseStashBadge();
    return true;
  }, [draft, promptHistory, promptStashModule, pulseStashBadge]);
  const restoreStashEntry = useCallback(
    (entryId: string) => {
      const result = promptStashModule.restore(entryId, draft);
      setPromptStash(result.entries);
      setStashStatus(result.message);
      if (!result.ok || result.prompt === undefined) return;
      setDraft(result.prompt);
      setPromptHistoryBrowse(resetPromptHistoryBrowse(promptHistory));
      setStashMenuOpen(false);
      pulseStashBadge();
      requestAnimationFrame(() => {
        const composer = composerRef.current;
        if (!composer) return;
        composer.focus();
        const end = result.prompt?.length ?? 0;
        composer.setSelectionRange(end, end);
      });
    },
    [draft, promptHistory, promptStashModule, pulseStashBadge],
  );
  const deleteStashEntry = useCallback(
    (entryId: string) => {
      const result = promptStashModule.remove(entryId);
      setPromptStash(result.entries);
      setStashStatus(result.message);
      if (result.entries.length === 0) setStashMenuOpen(false);
    },
    [promptStashModule],
  );
  const providerNativeWorkspaceAvailable = capabilities?.workspace?.providerNative ?? false;
  const applyProviderDefaults = (next: ProviderId) => {
    if (next === "claude-code") {
      setProfileId((current) =>
        claudeProfiles.some((profile) => profile.id === current) ? current : defaultClaudeProfileId,
      );
      // T3-style: pin a concrete alias (Sonnet), not a synthetic "default" token.
      setModel(resolveDefaultProviderModel("claude-code", undefined));
      setReasoningEffort("medium");
      return;
    }
    if (next === "codex-cli") {
      const defaultModel = resolveDefaultProviderModel("codex-cli", codex);
      setModel(defaultModel);
      const match = codex?.models?.find((entry) => entry.id === defaultModel);
      setReasoningEffort(match?.defaultReasoningEffort ?? "medium");
      return;
    }
    if (next === "shikigami") {
      const nextProfileId = shikigamiProfiles.some((profile) => profile.id === profileId)
        ? profileId
        : defaultShikigamiProfileId;
      setProfileId(nextProfileId);
      const defaultModel = resolveDefaultProviderModel(
        "shikigami",
        providerDiscoveryForProfile("shikigami", shikigamiProvider, nextProfileId),
      );
      setModel(defaultModel);
      setReasoningEffort("medium");
      return;
    }
    // Declarative ACP adapters (Kiro, Grok, OpenCode, …) — use discovered models.
    const discovery = providers.find((item) => item.id === next);
    const defaultModel = resolveDefaultProviderModel(next, discovery);
    setModel(defaultModel);
    const match = discovery?.models?.find((entry) => entry.id === defaultModel);
    const efforts = match?.reasoningEfforts ?? [];
    const preferred = match?.defaultReasoningEffort;
    if (preferred && efforts.includes(preferred)) setReasoningEffort(preferred);
    else if (efforts.length > 0) setReasoningEffort(efforts[0]!);
    else setReasoningEffort("medium");
  };
  const selectProvider = (next: ProviderId, source: "menu" | "keyboard" = "menu") => {
    // Opening click must never select a provider — only an explicit menu choice.
    if (source === "menu" && !composerPopovers.pointerSelectionAllowed("provider")) {
      return;
    }
    if (!canSwitchProvider) {
      composerPopovers.closeMenus();
      return;
    }
    if (next !== provider) {
      setProvider(next);
      applyProviderDefaults(next);
      dispatchConversationRun({ type: "clear_context" });
    }
    composerPopovers.closeMenus();
  };
  const selectModel = (nextModel: string, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && !composerPopovers.pointerSelectionAllowed("model")) {
      return;
    }
    if (nextModel !== model) {
      setModel(nextModel);
      dispatchConversationRun({ type: "clear_context" });
      if (
        (provider === "codex-cli" ||
          (typeof provider === "string" && provider.startsWith("adapter:"))) &&
        nextModel !== "default"
      ) {
        const efforts = providerReasoningEfforts(provider, nextModel, selectedProvider);
        const match = selectedProvider?.models?.find((entry) => entry.id === nextModel);
        const preferred = match?.defaultReasoningEffort;
        if (preferred && efforts.includes(preferred)) {
          setReasoningEffort(preferred);
        } else if (efforts.length > 0 && !efforts.includes(reasoningEffort)) {
          setReasoningEffort(efforts[0]!);
        }
      }
    }
    composerPopovers.closeMenus();
  };

  // Promote unpinned / legacy short Claude aliases to concrete T3-style slugs.
  useEffect(() => {
    let resolved = model;
    if (provider === "claude-code") {
      resolved = normalizeClaudeModelSlug(
        model === "default" ? resolveDefaultProviderModel(provider, selectedProvider) : model,
      );
    } else if (model === "default") {
      resolved = resolveDefaultProviderModel(provider, selectedProvider);
    }
    if (resolved === "default" || resolved === model) return;
    setModel(resolved);
    const match = selectedProvider?.models?.find((entry) => entry.id === resolved);
    const efforts = providerReasoningEfforts(provider, resolved, selectedProvider);
    const preferred = match?.defaultReasoningEffort;
    if (preferred && efforts.includes(preferred)) setReasoningEffort(preferred);
    else if (efforts.length > 0) setReasoningEffort(efforts[0]!);
  }, [model, provider, selectedProvider]);
  const selectMode = (nextMode: InteractionMode, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && !composerPopovers.pointerSelectionAllowed("mode")) {
      return;
    }
    if (nextMode !== mode) setMode(nextMode);
    composerPopovers.closeMenus();
  };
  const closeComposerMenus = composerPopovers.closeMenus;
  const openModeMenu = () => composerPopovers.toggleMenu("mode");
  const selectWorkspaceMode = (nextMode: WorkspaceMode, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && !composerPopovers.pointerSelectionAllowed("workspace")) return;
    if (!canPickWorkspace) {
      composerPopovers.closeMenus();
      return;
    }
    if (nextMode === "provider-native" && !providerNativeWorkspaceAvailable) return;
    setWorkspaceMode(nextMode);
    composerPopovers.closeMenus();
  };
  const selectProject = (projectId: string, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && !composerPopovers.pointerSelectionAllowed("project")) return;
    composerPopovers.closeMenus();
    onSelectProject(projectId);
  };
  const openProjectMenu = () => composerPopovers.toggleMenu("project");
  const openWorkspaceMenu = () => composerPopovers.toggleMenu("workspace");
  const modelOptions = managedMode
    ? [
        {
          id: managedModel ?? model,
          displayName: managedModel ?? model,
          isDefault: true,
        },
      ]
    : providerModelOptions(provider, selectedProvider);
  useEffect(() => {
    if (!canSwitchProvider && providerMenuOpen) composerPopovers.closeMenus();
  }, [canSwitchProvider, composerPopovers.closeMenus, providerMenuOpen]);
  useEffect(() => {
    if (profiles.length === 0) return;
    if (provider === "claude-code") {
      if (!claudeProfiles.some((profile) => profile.id === profileId)) {
        setProfileId(defaultClaudeProfileId);
      }
      return;
    }
    if (provider === "shikigami") {
      if (!shikigamiProfiles.some((profile) => profile.id === profileId)) {
        setProfileId(defaultShikigamiProfileId);
        setModel(
          resolveDefaultProviderModel(
            "shikigami",
            providerDiscoveryForProfile("shikigami", shikigamiProvider, defaultShikigamiProfileId),
          ),
        );
      }
      return;
    }
    if (profileId) setProfileId("");
  }, [
    claudeProfiles,
    defaultClaudeProfileId,
    defaultShikigamiProfileId,
    profileId,
    profiles.length,
    provider,
    shikigamiProfiles,
    shikigamiProvider,
  ]);
  const [workspacePanelLifecycle, setWorkspacePanelLifecycle] = useState(() =>
    initialWorkspacePanelLifecycle(activePanel),
  );
  const workspacePanelLifecycleRef = useRef(workspacePanelLifecycle);
  workspacePanelLifecycleRef.current = workspacePanelLifecycle;
  const [pendingWorkspacePanels, setPendingWorkspacePanels] = useState({
    files: false,
    preview: false,
    changes: false,
  });
  const pendingWorkspacePanelsRef = useRef(pendingWorkspacePanels);
  pendingWorkspacePanelsRef.current = pendingWorkspacePanels;
  const markWorkspacePanelPending = useCallback(
    (destination: WorkspacePanelDestination, pending: boolean) => {
      setPendingWorkspacePanels((current) => {
        if (current[destination] === pending) return current;
        const next = { ...current, [destination]: pending };
        pendingWorkspacePanelsRef.current = next;
        return next;
      });
    },
    [],
  );
  const onFilesPendingChange = useCallback(
    (pending: boolean) => markWorkspacePanelPending("files", pending),
    [markWorkspacePanelPending],
  );
  const onPreviewPendingChange = useCallback(
    (pending: boolean) => markWorkspacePanelPending("preview", pending),
    [markWorkspacePanelPending],
  );
  const onChangesPendingChange = useCallback(
    (pending: boolean) => markWorkspacePanelPending("changes", pending),
    [markWorkspacePanelPending],
  );
  const {
    previewFloating,
    browserObservationOpen: agentBrowserViewOpen,
    changesMode,
    turnReview: turnChangesReview,
  } = workspacePanelLifecycle;
  const [previewStatus, setPreviewStatus] = useState<PreviewPanelStatus>({
    state: "inactive",
    error: null,
  });
  const filesPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const previewPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const changesPanelTriggerRef = useRef<HTMLButtonElement>(null);
  const changesAdded = changes.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const changesRemoved = changes.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const canDeliverChanges = Boolean(
    repository && changes.length > 0 && !changesLoading && !changesError,
  );
  const availableWorkspacePanels = repository ? WORKSPACE_PANEL_DESTINATIONS : [];
  const workspacePanelStop = workspacePanelTabStop(
    workspacePanelLifecycle,
    availableWorkspacePanels,
  );
  const workspacePanelTrigger = (destination: WorkspacePanelDestination) =>
    destination === "files"
      ? filesPanelTriggerRef.current
      : destination === "preview"
        ? previewPanelTriggerRef.current
        : changesPanelTriggerRef.current;
  const dispatchWorkspacePanel = (event: WorkspacePanelLifecycleEvent) => {
    const transition = transitionWorkspacePanelLifecycle(workspacePanelLifecycleRef.current, event);
    workspacePanelLifecycleRef.current = transition.state;
    setWorkspacePanelLifecycle(transition.state);
    for (const effect of transition.effects) {
      if (effect.type === "change_panel") onPanelChange(effect.panel);
      else if (effect.type === "refresh_changes") onRefreshChanges();
      else if (effect.defer) {
        window.requestAnimationFrame(() => workspacePanelTrigger(effect.destination)?.focus());
      } else workspacePanelTrigger(effect.destination)?.focus();
    }
  };
  useEffect(() => {
    if (workspacePanelLifecycleRef.current.activePanel === activePanel) return;
    dispatchWorkspacePanel({ type: "sync_active", panel: activePanel });
  }, [activePanel]);
  useEffect(() => {
    dispatchWorkspacePanel({ type: "workspace_reset" });
  }, [repository?.root, repository?.selectedWorktree]);
  const updatePreviewStatus = useCallback((next: PreviewPanelStatus) => {
    setPreviewStatus((current) =>
      current.state === next.state && current.error === next.error ? current : next,
    );
  }, []);
  const activateWorkspacePanel = (destination: WorkspacePanelDestination) => {
    if (
      workspacePanelToggleHeld(
        workspacePanelLifecycleRef.current.activePanel,
        destination,
        pendingWorkspacePanelsRef.current[destination],
      )
    ) {
      return;
    }
    dispatchWorkspacePanel({ type: "toggle", destination });
  };
  const openChanges = (mode: ChangesPanelMode) => {
    dispatchWorkspacePanel({ type: "open_changes", mode });
  };
  const openTurnChanges = (turnCheckpoint: TurnCheckpoint) => {
    dispatchWorkspacePanel({ type: "open_turn_changes", checkpoint: turnCheckpoint });
  };
  useEffect(() => {
    if (openChangesSignal <= 0) return;
    dispatchWorkspacePanel({ type: "signal_changes", mode: openChangesMode });
  }, [openChangesMode, openChangesSignal]);
  const closeWorkspacePanel = (destination: WorkspacePanelDestination, restoreFocus = true) => {
    dispatchWorkspacePanel({ type: "close", destination, restoreFocus });
  };
  const closePreview = () => {
    dispatchWorkspacePanel({ type: "close_preview" });
  };
  const dismissPreview = () => {
    dispatchWorkspacePanel({ type: "dismiss_preview" });
  };
  const togglePreviewFloating = () => {
    dispatchWorkspacePanel({ type: "toggle_preview_floating" });
  };
  const moveWorkspacePanel = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    destination: WorkspacePanelDestination,
  ) => {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    if (!direction) return;
    event.preventDefault();
    dispatchWorkspacePanel({
      type: "move_focus",
      from: destination,
      direction,
      available: availableWorkspacePanels,
    });
  };
  const previewIndicator = previewStatus.error
    ? "error"
    : ["approval_pending", "starting", "running", "stopping", "failed"].includes(
          previewStatus.state,
        )
      ? previewStatus.state.replace("_", " ")
      : null;
  const [elementReferences, setElementReferences] = useState<ElementReference[]>([]);
  const [checkpoint, setCheckpoint] = useState<TurnCheckpoint | null>(null);
  const { snapshot: rewindState, session: rewindSession } = useWorkspaceRewindSession({
    checkpointId: checkpoint?.id ?? null,
    root: repository?.root ?? "",
    worktree: repository?.selectedWorktree ?? "",
  });
  const { preview: rewindPreview, error: checkpointError, busy: checkpointBusy } = rewindState;
  /** Hides the post-turn settle prompt until the next completed turn. */
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [releaseWorktreeOpen, setReleaseWorktreeOpen] = useState(false);
  /**
   * Timestamp for the assistant turn chrome. Must not use conversation.updatedAt —
   * pin/archive/settle bump that and would flash "now" on an old failed turn.
   */
  // Escape cancels a workspace rewind preview without requiring the Cancel button.
  useEffect(() => {
    if (!rewindPreview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (checkpointBusy) return;
      event.preventDefault();
      event.stopPropagation();
      rewindSession.clearPreview();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [checkpointBusy, rewindPreview, rewindSession]);
  const boundConversationId = conversation?.id ?? null;
  const boundConversationProvider = conversation?.provider;
  const boundConversationWorkspaceMode = conversation?.workspaceMode;
  const conversationScopeKey = boundConversationId ?? `new:${repository?.projectId ?? "none"}`;
  useEffect(() => {
    voiceInputModule.reset();
    setHistoryRestored(boundConversationId === null);
    setHistoryRestoreError(null);
    setThreadId(boundConversationId);
    setPreparedWorkspaceRepository(null);
    setWorkspaceApprovalPending(false);
    setWorkspaceDialogOpen(false);
    // New chat: reseed run settings from last selection so they survive thread switches.
    if (!boundConversationId) {
      const seeded = resolveNewConversationRunSettings({
        stored: readComposerRunSettings(getComposerRunSettingsStorage()),
        managedMode,
        managedModel,
        initialProvider,
      });
      setWorkspaceMode(seeded.workspaceMode);
      // Domain handoffs still force Build; do not let last-used Ask/Plan win here.
      setMode(initialPrompt ? "build" : seeded.mode);
      setProvider(seeded.provider);
      setModel(seeded.model);
      setReasoningEffort(seeded.reasoningEffort);
      setProfileId(seeded.profileId ?? "");
    } else {
      setWorkspaceMode(
        managedMode ? "shared" : defaultWorkspaceMode("ask", boundConversationWorkspaceMode),
      );
      // Prefer the summary provider immediately so crumb/empty state match the thread
      // while /api/state/load is in flight (avoids Claude-not-ready flash on reopen).
      if (!managedMode && boundConversationProvider) {
        setProvider(boundConversationProvider);
      }
    }
    setCheckpoint(null);
    dispatchWorkspacePanel({ type: "conversation_reset" });
    setCompletionDismissed(false);
    setMessages([]);
    setArchivedTurns([]);
    setAttachments([]);
    setFolderPins([]);
    setCurrentContextReceipt(null);
    setDraftContextReceipt(null);
    setContextOpen(false);
    dispatchConversationRun({ type: "reset", epoch: ++runEpochReference.current });
    setRunId(null);
    // Only rebind when the pane's conversation scope changes — not on every
    // composer chip edit (those would fight last-used persistence).
  }, [
    conversationScopeKey,
    boundConversationId,
    boundConversationProvider,
    boundConversationWorkspaceMode,
    managedMode,
    managedModel,
    initialProvider,
    initialPrompt,
    voiceInputModule,
  ]);
  // Remember new-chat run settings so the next empty composer opens with the same chips.
  // Domain handoffs force provider/mode; do not overwrite the operator's last-used defaults.
  useEffect(() => {
    if (managedMode || conversation !== null) return;
    if (initialPrompt || initialProvider) return;
    writeComposerRunSettings(getComposerRunSettingsStorage(), {
      version: 1,
      provider,
      model,
      reasoningEffort,
      mode,
      workspaceMode,
      profileId: profileId || undefined,
    });
  }, [
    conversation,
    initialPrompt,
    initialProvider,
    managedMode,
    model,
    mode,
    profileId,
    provider,
    reasoningEffort,
    workspaceMode,
  ]);
  const activeDraftKey = composerDraftKey({
    conversationId: conversation?.id ?? null,
    projectId: repository?.projectId ?? conversation?.projectId ?? null,
    pane,
  });
  // Restore stashed draft when the conversation / new-chat key changes.
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      storage = null;
    }
    // Domain handoff briefs win over a stashed new-chat draft once.
    if (initialPrompt && !conversation?.id) {
      return;
    }
    const stored = loadComposerDraft(storage, activeDraftKey);
    setDraft(stored?.text ?? "");
    setPromptHistoryBrowse(resetPromptHistoryBrowse([]));
  }, [activeDraftKey, conversation?.id, initialPrompt]);
  // Persist the draft for this key only; key and text are captured per effect generation.
  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      storage = null;
    }
    if (!activeDraftKey || !storage) return;
    const key = activeDraftKey;
    const textForKey = draft;
    const timer = window.setTimeout(() => {
      saveComposerDraft(storage, key, textForKey);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      saveComposerDraft(storage, key, textForKey);
    };
  }, [draft, activeDraftKey]);
  useEffect(() => {
    if (providerState !== "completed" && providerState !== "cancelled") {
      setCompletionDismissed(false);
    }
  }, [providerState]);
  useEffect(() => {
    if (!repository?.projectId) return;
    let active = true;
    let appliedHistorySequence: number | undefined;
    let latestPollingTurn: { status: RestoredTurnStatus; providerRunId: string | null } | undefined;
    const restorePendingApprovals = async () => {
      if (
        !latestPollingTurn?.providerRunId ||
        latestPollingTurn.status !== "waiting_for_approval"
      ) {
        return;
      }
      const approvalsResponse = await fetch("/api/provider/approvals/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: latestPollingTurn.providerRunId }),
      });
      if (approvalsResponse.ok) {
        const body = (await approvalsResponse.json()) as {
          approvals: Array<Extract<ProviderEvent, { kind: "approval_pending" }>>;
        };
        dispatchConversationRun({ type: "approvals_restored", approvals: body.approvals });
      }
    };
    const restore = async () => {
      if (!conversation?.id) {
        appliedRestoration.current = reconcilePersistedRestorationApplication(
          appliedRestoration.current,
          null,
        ).current;
        setHistoryRestored(true);
        return false;
      }
      const projection = (await loadConversationHistory(
        conversation.id,
        appliedHistorySequence,
      )) as PersistedConversationProjection | null;
      if (!active) return false;
      if (!projection) {
        await restorePendingApprovals();
        return true;
      }
      appliedHistorySequence = projection.sequence;
      const restoration = restorePersistedConversation(projection, {
        conversationId: conversation.id,
        projectId: repository.projectId,
        worktree: repository.selectedWorktree,
        activeProvider: provider,
        ...(managedMode ? { forcedProvider: "shikigami" as const } : {}),
        providerName: providerDisplayName(provider, selectedProvider),
      });
      if (restoration.kind === "thread_missing") {
        appliedRestoration.current = null;
        setHistoryRestored(true);
        return false;
      }
      if (restoration.kind === "provider_changed") {
        appliedRestoration.current = null;
        setProvider(restoration.provider);
        return false;
      }
      const restorationTarget = [
        conversation.id,
        repository.projectId,
        repository.selectedWorktree,
        provider,
      ].join("\0");
      const restorationFingerprint = persistedConversationRestorationFingerprint(restoration);
      const application = reconcilePersistedRestorationApplication(appliedRestoration.current, {
        target: restorationTarget,
        fingerprint: restorationFingerprint,
      });
      appliedRestoration.current = application.current;
      const shouldApplyRestoration = application.apply;
      const binding = restoration.thread;
      if (shouldApplyRestoration) {
        if (binding.profileId) setProfileId(binding.profileId);
        if (binding.model) setModel(binding.model);
        if (binding.reasoningEffort) setReasoningEffort(binding.reasoningEffort);
        setAttachments(binding.attachments);
        setFolderPins(binding.folderPins);
      }
      if (restoration.kind === "empty_thread") {
        setHistoryRestored(true);
        return false;
      }
      if (shouldApplyRestoration) {
        setThreadId(binding.threadId);
        setRunId(restoration.pendingRunId);
        setArchivedTurns(restoration.archivedTurns);
        setMessages(restoration.messages);
        setCurrentContextReceipt(restoration.currentTurn.contextReceipt ?? null);
        setCheckpoint(restoration.currentTurn.checkpoint ?? null);
        dispatchConversationRun({
          type: "restore",
          events: restoration.currentTurn.events,
          providerState: restoration.providerState,
          sessionId: binding.sessionId,
          assistantTurnAt: restoration.assistantTurnAt,
        });
      }
      const restoredStatus = restoration.latestStatus;
      const latest = {
        id: restoration.latestStatus.turnId,
        status: restoration.latestStatus.status,
        providerRunId: restoration.pendingRunId,
      };
      latestPollingTurn = latest;
      const thread = { id: restoration.thread.threadId };
      if (shouldRefreshAfterRestoredTurn(restoredTurnStatus.current, restoredStatus)) {
        conversationAvailableCallback.current?.(thread.id);
      }
      restoredTurnStatus.current = restoredStatus;
      await restorePendingApprovals();
      if (
        lastAttentionState.current !== latest.status &&
        shouldNotifyForRestoredTurn(
          latest.status,
          notificationsEnabled,
          document.visibilityState,
          quietDelegatedChild,
        )
      ) {
        new Notification("Aldunis Code needs attention", {
          body:
            latest.status === "waiting_for_approval"
              ? "A local action is waiting for your decision."
              : latest.status === "waiting_for_user"
                ? "A conversation is waiting for your input."
                : "A background turn changed state.",
        });
      }
      lastAttentionState.current = latest.status;
      setHistoryRestored(true);
      setHistoryRestoreError(null);
      return (
        latest.status === "active" ||
        latest.status === "running" ||
        latest.status === "waiting_for_approval" ||
        latest.status === "waiting_for_user"
      );
    };
    const stop = startPersistedConversationPolling(
      async () => {
        try {
          return await restore();
        } catch (error) {
          if (!active) return false;
          setHistoryRestoreError("Conversation history could not be restored. Retrying locally…");
          throw error;
        }
      },
      { background: notificationsEnabled && !quietDelegatedChild },
      document,
    );
    return () => {
      active = false;
      stop();
    };
  }, [
    conversation?.id,
    historyRefreshSignal,
    managedMode,
    notificationsEnabled,
    provider,
    quietDelegatedChild,
    repository?.projectId,
    repository?.selectedWorktree,
  ]);
  useEffect(() => {
    if (!managedMode) return;
    setProvider("shikigami");
    setMode("build");
    setProfileId("");
    if (managedModel) setModel(managedModel);
  }, [managedMode, managedModel]);
  useEffect(() => {
    void loadProviderCapabilities().then((caps) => {
      if (caps) setCapabilities(caps);
    });
  }, []);
  const worktree =
    repository?.worktrees.find(
      (item) =>
        item.path === repository.selectedWorktree &&
        (item.state === "available" || item.state === "detached"),
    ) ?? null;
  // Split panes recreate projection objects during unrelated Workbench renders;
  // keep resource effects keyed to the request target, not object identity.
  const [resourceRoot, resourceWorktree] = conversationResourceTarget(repository, worktree);
  useEffect(() => {
    if (!resourceRoot || !resourceWorktree) {
      setDraftContextReceipt(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setContextPackageBusy(true);
      void fetch("/api/context/package/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: resourceRoot,
          worktree: resourceWorktree,
          pins: contextPins,
        }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const body = (await response.json()) as { package?: ContextReceipt; error?: string };
          if (!response.ok || !body.package) {
            throw new Error(body.error ?? "The context package could not be resolved.");
          }
          if (!controller.signal.aborted) {
            setDraftContextReceipt(body.package);
            setContextError(null);
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setDraftContextReceipt(null);
            setContextError(cause instanceof Error ? cause.message : "Context resolution failed.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setContextPackageBusy(false);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [resourceRoot, resourceWorktree, contextPins]);
  useEffect(() => {
    if (provider !== "codex-cli" || !resourceRoot || !resourceWorktree) {
      setProviderSkills([]);
      return;
    }
    setProviderSkills([]);
    const controller = new AbortController();
    void fetch("/api/provider/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        root: resourceRoot,
        worktree: resourceWorktree,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as { skills?: ProviderSkill[] };
        if (!response.ok) throw new Error("Codex skills could not be loaded.");
        setProviderSkills(body.skills ?? []);
      })
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setProviderSkills([]);
      });
    return () => controller.abort();
  }, [provider, resourceRoot, resourceWorktree]);
  const conversationBranch = worktree?.branch ?? "Detached HEAD";
  const runActive =
    providerState === "starting" ||
    providerState === "streaming" ||
    providerState === "waiting_for_approval" ||
    providerState === "waiting_for_input" ||
    providerState === "cancelling";
  const canPickModel = !managedMode && !runActive && modelOptions.length > 0;
  const canPickMode = !managedMode && !runActive;
  useEffect(() => {
    if (!canPickModel && modelMenuOpen) composerPopovers.closeMenus();
  }, [canPickModel, modelMenuOpen, composerPopovers.closeMenus]);
  useEffect(() => {
    if (!canPickMode && modeMenuOpen) composerPopovers.closeMenus();
  }, [canPickMode, modeMenuOpen, composerPopovers.closeMenus]);
  const providerReadiness = assessProviderRunReadiness({
    provider,
    discoveryLoaded: providersLoaded,
    discovery: providers.find((item) => item.id === provider),
    profileId,
    profiles,
    model,
    managed: managedMode
      ? { requiredProvider: "shikigami", requiredModel: managedModel }
      : undefined,
    providerName,
  });
  /** Whether the selected provider can start a run right now. */
  const providerReady = providerReadiness.canRun;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !matchesVoiceInputShortcut(event) ||
        document.querySelector('[role="dialog"][aria-modal="true"]') ||
        !worktree ||
        !providerReady ||
        runActive ||
        !historyRestored
      )
        return;
      event.preventDefault();
      voiceInputModule.toggle(draft);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, draft, historyRestored, providerReady, runActive, worktree]);
  const providerReadinessMessage = providerReadiness.message;
  const effectiveModel = managedMode
    ? (managedModel ?? model)
    : (() => {
        const base =
          model === "default" ? resolveDefaultProviderModel(provider, selectedProvider) : model;
        return provider === "claude-code" ? normalizeClaudeModelSlug(base) : base;
      })();
  const modelChipLabel = providerModelLabel(provider, effectiveModel, selectedProvider);
  // Avoid a literal "Default" flash while history rehydrate / discovery is still settling.
  const modelChipDisplay =
    modelChipLabel === "Default" && (!historyRestored || !providersLoaded) ? "…" : modelChipLabel;
  const reasoningEfforts = providerReasoningEfforts(provider, effectiveModel, selectedProvider);
  const showReasoningEffort =
    (provider === "codex-cli" ||
      (typeof provider === "string" && provider.startsWith("adapter:"))) &&
    effectiveModel !== "default" &&
    reasoningEfforts.length > 0;
  useEffect(() => {
    if (
      !conversation ||
      conversation.reasoningEffort ||
      !providersLoaded ||
      !historyRestored ||
      legacyReasoningDefaultRef.current === conversation.id
    ) {
      return;
    }
    legacyReasoningDefaultRef.current = conversation.id;
    const preferred = selectedProvider?.models?.find(
      (entry) => entry.id === effectiveModel,
    )?.defaultReasoningEffort;
    if (preferred && reasoningEfforts.includes(preferred)) {
      setReasoningEffort(preferred);
    } else if (reasoningEfforts.length > 0) {
      setReasoningEffort(reasoningEfforts[0]!);
    }
  }, [
    conversation,
    effectiveModel,
    historyRestored,
    providersLoaded,
    reasoningEfforts,
    selectedProvider,
  ]);
  const modeCopy: Record<InteractionMode, { label: string; authority: string }> = {
    ask: { label: "Ask", authority: "Reads only" },
    plan: { label: "Plan", authority: "Plans only; no changes" },
    build: { label: "Build", authority: "Writes after approval" },
  };
  useEffect(() => {
    const trigger = getComposerTrigger(draft);
    if (!trigger || !worktree || !repository) {
      setSuggestionMode(null);
      setSuggestions([]);
      return;
    }
    setSuggestionIndex(0);
    if (trigger.mode === "slash-command") {
      setSuggestionMode(trigger.mode);
      setSuggestions(
        buildComposerCommandItems({
          provider,
          capabilities,
          query: trigger.query,
        }),
      );
      return;
    }
    if (trigger.mode === "skill") {
      setSuggestionMode(trigger.mode);
      setSuggestions(buildComposerSkillItems(provider, providerSkills, trigger.query));
      return;
    }
    setSuggestionMode(trigger.mode);
    setSuggestions([]);
    const controller = new AbortController();
    void fetch("/api/context/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: worktree.path,
        query: trigger.query,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as { files?: string[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Repository files could not be searched.");
        setSuggestions(buildComposerPathItems(body.files ?? []));
      })
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setContextError(error.message);
      });
    return () => controller.abort();
  }, [capabilities, draft, provider, providerSkills, repository, worktree]);
  const selectSuggestion = (suggestion: ComposerCommandItem) => {
    if (suggestion.type === "path") {
      if (!attachments.includes(suggestion.path)) {
        if (contextPins.length >= 100) {
          setContextError("Pin at most 100 file or folder paths.");
          return;
        }
        setAttachments((current) => [...current, suggestion.path]);
      }
      setDraft((current) => replaceComposerTrigger(current, ""));
    } else {
      setDraft((current) => replaceComposerTrigger(current, suggestion.label + " "));
    }
    setContextError(null);
    setSuggestionMode(null);
    setSuggestions([]);
  };
  const attachComposerImageFiles = useCallback(
    async (files: File[], options?: { preserveError?: boolean }) => {
      if (files.length === 0) return;
      if (composerImageBusy || runActive) {
        setContextError(
          runActive
            ? "Wait for the current provider run to finish before attaching images."
            : "Wait for the current image staging to finish before attaching more images.",
        );
        return;
      }
      setComposerImageBusy(true);
      try {
        const result = await stageComposerImages({
          files,
          repositoryRoot: repository?.root,
          worktreePath: worktree?.path,
          conversationId,
          availablePins: 100 - contextPins.length,
          stageImage: stageComposerImageWithHost,
        });
        if (result.paths.length > 0) {
          setAttachments((current) => {
            const next = [...current];
            for (const path of result.paths) {
              if (!next.includes(path) && next.length + folderPins.length < 100) next.push(path);
            }
            return next;
          });
        }
        if (result.failure) setContextError(result.failure);
        else if (result.omitted > 0) {
          const attached = files.length - result.omitted;
          setContextError(
            `Attached the first ${attached} image${attached === 1 ? "" : "s"}; pin budget or batch limit reached.`,
          );
        } else if (!options?.preserveError) setContextError(null);
      } finally {
        setComposerImageBusy(false);
      }
    },
    [
      composerImageBusy,
      contextPins.length,
      conversationId,
      folderPins.length,
      repository?.root,
      runActive,
      worktree?.path,
    ],
  );
  const send = async (promptOverride?: string) => {
    const value = (promptOverride ?? draft).trim();
    if (promptOverride === undefined && value === "/context") {
      setDraft("");
      setPlanOpen(false);
      setContextOpen(true);
      return;
    }
    const runRepository =
      workspaceMode === "aldunis-managed"
        ? (preparedWorkspaceRepository ?? repository)
        : repository;
    const runWorktree =
      runRepository?.worktrees.find(
        (item) =>
          item.path === runRepository.selectedWorktree &&
          (item.state === "available" || item.state === "detached"),
      ) ?? null;
    if (!value || !runRepository || !runWorktree || !providerReady || runActive || !historyRestored)
      return;
    if (promptOverride === undefined && voiceInputState === "listening") {
      voiceInputModule.stop();
    }
    if (workspaceMode === "aldunis-managed" && !threadId && !preparedWorkspaceRepository) {
      setWorkspaceDialogOpen(true);
      return;
    }
    const turnMode: InteractionMode = managedMode ? "build" : mode;
    const turnProvider: ProviderId = managedMode ? "shikigami" : provider;
    const turnModel = managedMode ? (managedModel ?? effectiveModel) : effectiveModel;
    const previousMessage = messages.at(-1);
    if (previousMessage) {
      setArchivedTurns((current) => [
        ...current,
        {
          message: previousMessage,
          // Provider screenshots are stream-only UI state and must not remain
          // attached to an archived in-memory turn either.
          events: providerEvents.filter((event) => event.kind !== "browser_observation"),
          assistantAt: assistantTurnAt ?? undefined,
          state: providerState === "cancelled" ? "cancelled" : providerState,
          contextReceipt: currentContextReceipt ?? undefined,
          checkpoint: checkpoint ?? undefined,
        },
      ]);
    }
    setMessages((current) => [
      ...current,
      { text: value, mode: turnMode, createdAt: new Date().toISOString() },
    ]);
    // Sending always re-engages follow so the operator sees their prompt and the reply.
    transcriptViewport.engageFollow();
    if (promptOverride === undefined) setDraft("");
    const sentElementReferences = promptOverride === undefined ? elementReferences : [];
    if (promptOverride === undefined) setElementReferences([]);
    const runEpoch = ++runEpochReference.current;
    dispatchConversationRun({ type: "start", epoch: runEpoch });
    setCurrentContextReceipt(draftContextReceipt);
    setRunId(null);
    setCheckpoint(null);
    let activeTurnId: string | null = null;
    let createdThreadId: string | null = null;
    const draftKeyAtSend = activeDraftKey;
    const safeLocalStorage = (): Storage | null => {
      try {
        return typeof window !== "undefined" ? window.localStorage : null;
      } catch {
        return null;
      }
    };
    const result = await conversationTurnSession.start({
      body: {
        root: runRepository.root,
        worktree: runWorktree.path,
        prompt: value,
        mode: turnMode,
        conversationId,
        projectId: runRepository.projectId,
        threadId: threadId ?? undefined,
        resumeSessionId: turnProvider === "shikigami" ? undefined : (sessionId ?? undefined),
        contextPins,
        profileId: managedMode
          ? null
          : provider === "claude-code" || provider === "shikigami"
            ? profileId
            : null,
        model: turnModel,
        provider: turnProvider,
        workspaceMode,
        reasoningEffort:
          !managedMode &&
          (provider === "codex-cli" ||
            (typeof provider === "string" && provider.startsWith("adapter:"))) &&
          turnModel !== "default"
            ? reasoningEffort
            : undefined,
        elementReferences: sentElementReferences.map(
          ({ screenshot: _screenshot, ...reference }) => reference,
        ),
      },
      epoch: runEpoch,
      providerName,
      dispatch: dispatchConversationRun,
      onAccepted: async (ids) => {
        // Clear stash only after the host accepted the run.
        if (promptOverride === undefined && draftKeyAtSend) {
          clearComposerDraft(safeLocalStorage(), draftKeyAtSend);
        }
        setRunId(ids.runId);
        setThreadId(ids.threadId);
        createdThreadId = ids.threadId;
        activeTurnId = ids.turnId;
        if (ids.turnId && ids.threadId) {
          void loadFreshConversationHistory(ids.threadId)
            .then((value) => {
              const projection = value as { contextReceipts?: ContextReceipt[] };
              const receipt = projection.contextReceipts?.find(
                (item) => item.turnId === ids.turnId,
              );
              if (receipt) setCurrentContextReceipt(receipt);
            })
            .catch(() => undefined);
        }
      },
    });
    createdThreadId = result.threadId ?? createdThreadId;
    activeTurnId = result.turnId ?? activeTurnId;
    if (result.status === "completed") {
      if (activeTurnId && createdThreadId) {
        try {
          const projection = (await loadFreshConversationHistory(createdThreadId)) as {
            checkpoints?: TurnCheckpoint[];
          };
          setCheckpoint(
            projection.checkpoints?.find((item) => item.turnId === activeTurnId) ?? null,
          );
        } catch {
          // Checkpoint is optional after a completed turn.
        }
      }
    } else {
      if (promptOverride === undefined) {
        setElementReferences(sentElementReferences);
      }
      // Restore unsent text only when the host never accepted the run (avoid
      // re-offering a prompt the provider may already be executing).
      if (promptOverride === undefined && !result.accepted) {
        setDraft(value);
        if (draftKeyAtSend) {
          saveComposerDraft(safeLocalStorage(), draftKeyAtSend, value);
        }
      }
    }
    setRunId(null);
    const availableThreadId = createdThreadId ?? conversation?.id;
    if (availableThreadId) onConversationAvailable?.(availableThreadId);
  };
  useEffect(() => {
    if (!workspaceApprovalPending || !preparedWorkspaceRepository) return;
    setWorkspaceApprovalPending(false);
    void send();
    // The pending flag is cleared before sending, so the prepared path cannot
    // cause a second turn if a parent repository refresh races this effect.
  }, [workspaceApprovalPending, preparedWorkspaceRepository]);
  const previewRewind = async () => {
    if (!checkpoint || !repository || !worktree) return;
    await rewindSession.preview(checkpoint.id, repository.root, worktree.path);
  };
  const confirmRewind = async () => {
    if (!checkpoint || !rewindPreview || !repository || !worktree) return;
    const rewound = await rewindSession.confirm(checkpoint.id, repository.root, worktree.path);
    if (!rewound) return;
    setCheckpoint({
      ...checkpoint,
      state: "superseded",
      message: "Workspace rewound to the turn baseline.",
    });
  };
  const cancel = async () => {
    if (!runId) return;
    await conversationTurnSession.cancel(runId, conversationRun.epoch, dispatchConversationRun);
  };
  const decideApproval = async (
    approval: Extract<ProviderEvent, { kind: "approval_pending" }>,
    decision: "allow_once" | "deny",
  ) => {
    await conversationTurnSession.decideApproval(approval, decision, dispatchConversationRun);
  };
  const answerInput = async (input: Extract<ProviderEvent, { kind: "input_requested" }>) => {
    const answer = (inputAnswers[input.id] ?? "").trim();
    if (!answer || !threadId) return;
    setInputBusyId(input.id);
    try {
      const answered = await conversationTurnSession.answerInput(
        input,
        answer,
        threadId,
        dispatchConversationRun,
      );
      if (!answered) return;
      setHistoryRefreshSignal((current) => current + 1);
      conversationAvailableCallback.current?.(threadId);
    } finally {
      setInputBusyId(null);
    }
  };
  const assistantTimeline = presentAssistantTimeline(providerEvents, "running", { showThinking });
  const latestAgentBrowserObservation = useMemo<ProviderBrowserObservation | null>(
    () =>
      providerEvents
        .filter(
          (event): event is Extract<ProviderEvent, { kind: "browser_observation" }> =>
            event.kind === "browser_observation",
        )
        .at(-1) ?? null,
    [providerEvents],
  );
  const agentBrowserObservationIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!latestAgentBrowserObservation) {
      agentBrowserObservationIdRef.current = null;
      dispatchWorkspacePanel({ type: "browser_observation", present: false });
      return;
    }
    if (agentBrowserObservationIdRef.current === latestAgentBrowserObservation.observationId)
      return;
    agentBrowserObservationIdRef.current = latestAgentBrowserObservation.observationId;
    dispatchWorkspacePanel({ type: "browser_observation", present: true });
  }, [latestAgentBrowserObservation]);
  const latestPlan = useMemo(
    () => latestPlanFromEvents([...archivedTurns.map((turn) => turn.events), providerEvents]),
    [archivedTurns, providerEvents],
  );
  const workGraphEvents = useMemo(() => {
    const groups = [...archivedTurns.map((turn) => turn.events), providerEvents];
    return [...groups].reverse().find((events) => hasWorkGraphEvidence(events)) ?? [];
  }, [archivedTurns, providerEvents]);
  const workGraph = useMemo(() => buildWorkGraph(workGraphEvents), [workGraphEvents]);
  const planEntries = useMemo(
    () => [
      ...archivedTurns.flatMap((turn, index) =>
        presentAssistantTimeline(turn.events, "running", { showThinking })
          .filter(
            (block): block is Extract<typeof block, { kind: "plan" }> => block.kind === "plan",
          )
          .map((block) => ({
            key: `archived-${index}-plan-${block.artifact.provider}-${block.artifact.id}`,
            artifact: block.artifact,
          })),
      ),
      ...presentAssistantTimeline(providerEvents, "running", { showThinking })
        .filter((block): block is Extract<typeof block, { kind: "plan" }> => block.kind === "plan")
        .map((block) => ({
          key: `current-plan-${block.artifact.provider}-${block.artifact.id}`,
          artifact: block.artifact,
        })),
    ],
    [archivedTurns, providerEvents, showThinking],
  );
  const panelPlan = selectedPlanKey
    ? (planEntries.find((entry) => entry.key === selectedPlanKey)?.artifact ?? latestPlan)
    : latestPlan;
  useEffect(() => {
    if (!latestPlan && !workGraph.hasObservedActivity) setPlanOpen(false);
  }, [latestPlan, workGraph.hasObservedActivity]);
  const assistantText = assistantTextFromEvents(providerEvents);
  const thinkingText = joinAssistantTextChunks(
    providerEvents
      .filter(
        (event): event is Extract<ProviderEvent, { kind: "thinking" }> => event.kind === "thinking",
      )
      .map((event) => event.text),
  );
  const toolEvents = providerEvents.filter(
    (event) => event.kind === "tool_started" || event.kind === "tool_finished",
  );
  const approvals = providerEvents.filter(
    (event): event is Extract<ProviderEvent, { kind: "approval_pending" }> =>
      event.kind === "approval_pending",
  );
  const inputs = providerEvents.filter(
    (event): event is Extract<ProviderEvent, { kind: "input_requested" }> =>
      event.kind === "input_requested" &&
      (event.state === undefined ||
        event.state === "pending" ||
        (event.responseMode === "native_resume" && event.resumeState === "unavailable")),
  );
  const failure = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "failed" }> => event.kind === "failed")
    .at(-1);
  const hasAssistantContent =
    Boolean(assistantText.trim()) ||
    (showThinking && Boolean(thinkingText.trim())) ||
    latestPlan != null ||
    toolEvents.length > 0 ||
    approvals.length > 0 ||
    inputs.length > 0 ||
    failure != null;
  // Avoid empty assistant shells after restore (header-only with no body).
  // runActive covers starting/streaming/waiting_for_approval/cancelling.
  const showAssistantTurn =
    hasAssistantContent ||
    runActive ||
    (providerState === "completed" && Boolean(threadId)) ||
    providerState === "failed" ||
    providerState === "cancelled";
  const conversationEmpty =
    messages.length === 0 && !showAssistantTurn && providerState === "idle" && !draft.trim();
  // Content signature: when this changes while following, pin the viewport to the tail.
  const threadFollowContentKey = [
    conversation?.id ?? "new",
    historyRestored ? "ready" : "restoring",
    archivedTurns.length,
    messages.length,
    providerEvents.length,
    assistantText.length,
    showThinking ? thinkingText.length : 0,
    providerState,
    approvals.length,
    inputs.length,
    completionDismissed ? "done-dismissed" : "done-open",
    checkpoint?.state ?? "no-checkpoint",
    failure ? "failed" : "ok",
  ].join(":");
  const transcriptViewport = useTranscriptViewport({
    scopeKey: conversationScopeKey,
    conversationId: conversation?.id ?? threadId,
    openScroll: conversationOpenScroll,
    historyReady: historyRestored,
    empty: conversationEmpty,
    contentKey: threadFollowContentKey,
    layoutKey: activePanel,
  });
  const failureView = failure ? parseProviderFailure(failure.message) : null;
  const failureNeedsConfiguration = failure
    ? providerFailureNeedsConfiguration(failure.message) ||
      providerTextReportsAuthenticationFailure(assistantText)
    : false;
  const selectedClaudeProfile = claudeProfiles.find((profile) => profile.id === profileId);
  const configurationVerifiedAfterFailure =
    provider === "claude-code" &&
    providerConfigurationVerifiedAfterFailure(
      selectedClaudeProfile?.probes.authentication,
      assistantTurnAt,
    );
  const failureRecovery = providerFailureRecovery(
    providerLabel,
    failureNeedsConfiguration,
    configurationVerifiedAfterFailure,
  );
  const conversationWorktreeMissing = Boolean(
    conversation?.worktree &&
    repository &&
    !repository.worktrees.some((item) => item.path === conversation.worktree),
  );
  const accessLabel =
    mode === "ask" ? "Read-only" : mode === "plan" ? "Plan only" : "Worktree write";
  const emptyState = !repository
    ? {
        title: "Start with your workspace",
        detail: "Choose a project, choose a worktree, then describe the outcome below.",
        // The Work on card already owns the project-selection action. Keeping one
        // path here prevents two competing repository CTAs in the first-run state.
        action: null,
      }
    : conversationWorktreeMissing
      ? {
          title: "Worktree is not available",
          detail: `This conversation is bound to ${conversation?.worktree}, which is not among the discovered worktrees for the open repository. Switch project or recreate the worktree before sending.`,
          action: (
            <Button variant="primary" size="lg" onClick={onManageWorktrees}>
              Manage worktrees
            </Button>
          ),
        }
      : conversation && !historyRestored
        ? {
            title: "Restoring conversation…",
            detail: "Loading the local transcript for this thread.",
            action: null,
          }
        : !providersLoaded
          ? {
              title: "Checking providers…",
              detail: "Discovering local CLIs and adapter packages.",
              action: null,
            }
          : !providerReady
            ? {
                title: `${providerName} is not ready`,
                detail: discoveryTimedOut
                  ? PROVIDER_DISCOVERY_TIMEOUT_DETAIL
                  : providerReadinessMessage ||
                    `Finish setup for ${providerName}, then return here.`,
                action: discoveryTimedOut ? (
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() => {
                      window.dispatchEvent(new Event("aldunis:providers-retry"));
                    }}
                  >
                    Retry provider check
                  </Button>
                ) : provider === "claude-code" ? (
                  <Button variant="primary" size="lg" onClick={() => onOpenProfiles(provider)}>
                    Configure Claude
                  </Button>
                ) : null,
              }
            : !worktree
              ? {
                  title: "Choose a worktree to continue",
                  detail:
                    "Select an available worktree below, then start with the outcome you want.",
                  action: null,
                }
              : {
                  title: "What should we build, fix, or review?",
                  detail:
                    "Start with the outcome you want. Aldunis keeps the conversation bound to this worktree.",
                  action: (
                    <div className="starter-prompts" aria-label="Example prompts">
                      <span className="starter-prompts-label">Try a starting point</span>
                      <div className="starter-prompts-list">
                        {STARTER_PROMPTS.map((prompt) => (
                          <button
                            type="button"
                            className="starter-prompt"
                            key={prompt.label}
                            onClick={() => {
                              setDraft(prompt.value);
                              composerRef.current?.focus();
                            }}
                          >
                            {prompt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ),
                };
  const stateCopy: Record<ProviderState, string> = {
    idle: repository ? "Ready" : "Open a repository to start",
    starting: `Starting ${providerName}…`,
    streaming: `${providerName} is working…`,
    waiting_for_approval: "Waiting for your approval…",
    waiting_for_input: "Waiting for your input…",
    cancelling: "Cancelling…",
    // Successful completion is implied by the answer stopping and the settle
    // notice; only cancelled/failed need explicit recovery copy in the turn.
    completed: "",
    cancelled: `${providerLabel} cancelled · send another prompt to resume`,
    failed: failureRecovery.message,
  };
  const accessScope = {
    label: accessLabel,
    warning: mode !== "ask",
    detail: modeCopy[mode].authority,
  };
  const workspaceCopy = WORKSPACE_MODE_COPY[workspaceMode];
  const workspaceSetupStatus = !repository
    ? { label: "Choose project", tone: "pending" }
    : !worktree
      ? { label: "Choose worktree", tone: "pending" }
      : { label: "Ready", tone: "ready" };
  const newConversationWorkspaceCopy = NEW_CONVERSATION_WORKSPACE_COPY[workspaceMode];
  const hostLabel = formatHostLabel(
    typeof window !== "undefined" ? window.location.hostname : undefined,
  );
  const workspaceSetupRequired = !repository || !worktree;
  const workspaceSetupVisible = workspaceSetupOpen || workspaceSetupRequired;
  const workspaceSummary = !repository
    ? "Choose a project"
    : !worktree
      ? "Choose a worktree"
      : `${repository.name} · ${conversationBranch}`;
  const workspaceSummaryDetail = !repository
    ? "Set the project and worktree before sending"
    : !worktree
      ? "Select an available worktree before sending"
      : `${workspaceCopy.label} · ${hostLabel}`;
  const selectableWorktrees = useMemo(
    () =>
      repository?.worktrees.filter(
        (item) => item.state === "available" || item.state === "detached",
      ) ?? [],
    [repository?.worktrees],
  );
  const filteredSelectableWorktrees = useMemo(
    () =>
      filterSelectableWorktrees(
        selectableWorktrees,
        worktreeFilter,
        repository?.selectedWorktree ?? null,
      ),
    [repository?.selectedWorktree, selectableWorktrees, worktreeFilter],
  );
  const managedSelectableWorktrees = filteredSelectableWorktrees.filter(
    (item) => item.ownership === "aldunis",
  );
  const userSelectableWorktrees = filteredSelectableWorktrees.filter(
    (item) => item.ownership === "user",
  );
  const worktreeFilterHasNoMatches =
    worktreeFilter.trim().length > 0 && filteredSelectableWorktrees.length === 0;
  // Previous worktree is a reuse accelerator for shared checkout only.
  // Managed create uses a separate base-branch dialog and must not compete.
  const previousWorktreeSeed = useMemo(() => {
    if (!canPickWorkspace || workspaceMode !== "shared") return null;
    const seed = resolvePreviousWorktreeSeed({
      conversations: projectConversations,
      projectId: repository?.projectId ?? null,
      currentWorktreePath: repository?.selectedWorktree ?? null,
    });
    if (!seed) return null;
    // Only surface seeds that are still selectable.
    if (!selectableWorktrees.some((item) => item.path === seed.worktreePath)) return null;
    return seed;
  }, [
    canPickWorkspace,
    projectConversations,
    repository?.projectId,
    repository?.selectedWorktree,
    selectableWorktrees,
    workspaceMode,
  ]);
  const previousWorktreeOption = previousWorktreeSeed
    ? (selectableWorktrees.find((item) => item.path === previousWorktreeSeed.worktreePath) ?? null)
    : null;
  const selectPreviousWorktree = () => {
    if (!previousWorktreeSeed) return;
    setWorkspaceMode("shared");
    composerPopovers.closeMenus();
    onSelectWorktree(previousWorktreeSeed.worktreePath);
  };
  const showSharedWorktreePicker = canPickWorkspace && workspaceMode === "shared";
  const showManagedCreateHint = canPickWorkspace && workspaceMode === "aldunis-managed";
  const selectedWorktreePath = repository?.selectedWorktree ?? "";
  const worktreeSelectValue = filteredSelectableWorktrees.some(
    (item) => item.path === selectedWorktreePath,
  )
    ? selectedWorktreePath
    : "";
  const renderTimeline = (
    events: ProviderEvent[],
    keyPrefix: string,
    unfinishedStatus: "running" | "cancelled" = "running",
  ) =>
    presentAssistantTimeline(events, unfinishedStatus, { showThinking }).map(
      (block, blockIndex) => {
        if (block.kind === "text") {
          return (
            <MarkdownBody
              key={`${keyPrefix}-text-${blockIndex}`}
              text={block.text}
              className="turn-md"
            />
          );
        }
        if (block.kind === "thinking") {
          return (
            <section
              className="thinking-block"
              aria-label={`${providerLabel} thinking`}
              key={`${keyPrefix}-thinking-${blockIndex}`}
            >
              <div className="thinking-label">Thinking</div>
              <MarkdownBody text={block.text} className="thinking-body" />
            </section>
          );
        }
        if (block.kind === "plan") {
          const planKey = `${keyPrefix}-plan-${block.artifact.provider}-${block.artifact.id}`;
          return (
            <ProviderPlanCard
              key={planKey}
              plan={block.artifact}
              providerLabel={providerDisplayName(
                block.artifact.provider,
                providers.find((item) => item.id === block.artifact.provider),
              )}
              onOpen={() => {
                setPlanPanelMode("plan");
                setSelectedPlanKey(planKey);
                setPlanOpen(true);
              }}
            />
          );
        }
        return (
          <ToolActivity
            key={`${keyPrefix}-tools-${blockIndex}`}
            rows={block.rows}
            providerLabel={providerLabel}
            // Scope by pane so dual-pane layouts do not emit duplicate DOM ids
            // (aria-controls targets must stay unique document-wide).
            groupId={`${pane}-${keyPrefix}-tools-${blockIndex}`}
          />
        );
      },
    );
  const renderArchivedFailure = (events: ProviderEvent[]) => {
    const event = events
      .filter(
        (candidate): candidate is Extract<ProviderEvent, { kind: "failed" }> =>
          candidate.kind === "failed",
      )
      .at(-1);
    if (!event) return null;
    const view = parseProviderFailure(event.message);
    return (
      <div
        className={`provider-error ${view.kind === "park" ? "provider-error-park" : ""}`}
        role="alert"
      >
        <p>
          {/^provider failed\.?$/i.test(view.summary.trim())
            ? `${providerName} failed.`
            : view.summary}
        </p>
        {view.question && <p className="provider-error-question">Question: {view.question}</p>}
        {view.resumeCommand && (
          <div className="provider-error-resume">
            <code title={view.resumeCommand}>{view.resumeCommand}</code>
          </div>
        )}
      </div>
    );
  };
  const latestMessage = messages.at(-1);
  const suggestionGroups = suggestionMode
    ? groupComposerCommandItems(suggestions, suggestionMode)
    : [];
  const orderedSuggestions = suggestionGroups.flatMap((group) => group.items);

  return (
    <div
      className="conv-root"
      aria-label={`${pane === "primary" ? "Primary" : "Secondary"} conversation: ${conversation?.title ?? "New conversation"}`}
    >
      <div className="topbar">
        <div
          className="crumb"
          title={[
            conversation?.title ?? "New conversation",
            repository?.name ?? null,
            worktree ? conversationBranch : null,
            repository ? providerListLabel(provider) : null,
            repository ? workspaceCopy.shortLabel : null,
            effectiveModel !== "default" ? modelChipLabel : null,
            showReasoningEffort ? reasoningEffort : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span className="crumb-title">
            <b>{conversation?.title ?? "New conversation"}</b>
          </span>
          <span className="crumb-meta">
            {worktree && (
              <span
                className="crumb-chip crumb-chip--branch"
                title={conversationBranch}
                aria-label={`Branch ${conversationBranch}`}
              >
                {conversationBranch}
              </span>
            )}
            {repository && (
              <span
                className="crumb-chip"
                title={`Provider: ${providerListLabel(provider)}`}
                aria-label={`Provider ${providerListLabel(provider)}`}
              >
                {providerListLabel(provider)}
              </span>
            )}
            {repository && (
              <span
                className="crumb-chip"
                title={`Workspace: ${workspaceCopy.label}`}
                aria-label={`Workspace ${workspaceCopy.label}`}
              >
                {workspaceCopy.shortLabel}
              </span>
            )}
            {effectiveModel !== "default" && (
              <span
                className="crumb-chip crumb-chip--secondary"
                title={`Model: ${modelChipLabel}`}
                aria-label={`Model ${modelChipLabel}`}
              >
                {modelChipLabel}
              </span>
            )}
            {showReasoningEffort && (
              <span
                className="crumb-chip crumb-chip--secondary"
                title={`Reasoning effort: ${reasoningEffort}`}
                aria-label={`Reasoning effort ${reasoningEffort}`}
              >
                {reasoningEffort}
              </span>
            )}
          </span>
        </div>
        <div className="tb-r">
          {latestPlan && (
            <button
              ref={planTriggerRef}
              type="button"
              className={`btn btn-ghost btn-sm ${planOpen && planPanelMode === "plan" ? "on" : ""}`}
              onClick={() => {
                if (planOpen && planPanelMode === "plan") {
                  setPlanOpen(false);
                  return;
                }
                setPlanPanelMode("plan");
                setSelectedPlanKey(null);
                setPlanOpen(true);
              }}
              aria-expanded={planOpen && planPanelMode === "plan"}
              aria-controls={
                planOpen && planPanelMode === "plan" ? `${pane}-provider-plan-panel` : undefined
              }
            >
              Plan
            </button>
          )}
          {workGraph.hasPlan || workGraph.hasObservedActivity ? (
            <button
              ref={workGraphTriggerRef}
              type="button"
              className={`btn btn-ghost btn-sm work-graph-trigger ${planOpen && planPanelMode === "graph" ? "on" : ""}`}
              onClick={() => {
                if (planOpen && planPanelMode === "graph") {
                  setPlanOpen(false);
                  return;
                }
                setPlanPanelMode("graph");
                setSelectedPlanKey(null);
                setPlanOpen(true);
              }}
              aria-expanded={planOpen && planPanelMode === "graph"}
              aria-controls={
                planOpen && planPanelMode === "graph" ? `${pane}-provider-plan-panel` : undefined
              }
              title="Work Graph (Beta)"
            >
              Graph{" "}
              <span className="work-graph-trigger-beta" aria-hidden="true">
                β
              </span>
            </button>
          ) : null}
          <div
            className="workspace-panel-selector"
            role="group"
            aria-label={`Workspace panels, ${pane} pane`}
          >
            <span className="workspace-panel-label" aria-hidden="true">
              Workspace
            </span>
            <button
              ref={filesPanelTriggerRef}
              type="button"
              className={`btn btn-ghost btn-sm ${activePanel === "files" ? "on" : ""}`}
              data-workspace-panel="files"
              disabled={!repository}
              tabIndex={workspacePanelStop === "files" ? 0 : -1}
              title={repository ? "Browse worktree files" : "Open a repository to browse files"}
              aria-label={
                repository
                  ? `Files, ${pane} pane`
                  : `Files unavailable, ${pane} pane: open a repository`
              }
              aria-pressed={activePanel === "files"}
              aria-busy={pendingWorkspacePanels.files || undefined}
              onKeyDown={(event) => moveWorkspacePanel(event, "files")}
              onClick={() => activateWorkspacePanel("files")}
            >
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
              </svg>
              Files
            </button>
            <button
              ref={previewPanelTriggerRef}
              type="button"
              className={`btn btn-ghost btn-sm ${activePanel === "preview" ? "on" : ""}`}
              data-workspace-panel="preview"
              disabled={!repository}
              tabIndex={workspacePanelStop === "preview" ? 0 : -1}
              title={repository ? "Local web preview" : "Open a repository to use Preview"}
              aria-label={[
                repository ? "Preview" : "Preview unavailable: open a repository",
                previewIndicator,
                `${pane} pane`,
              ]
                .filter(Boolean)
                .join(", ")}
              aria-pressed={activePanel === "preview"}
              aria-busy={pendingWorkspacePanels.preview || undefined}
              onKeyDown={(event) => moveWorkspacePanel(event, "preview")}
              onClick={() => activateWorkspacePanel("preview")}
            >
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 15h18" />
              </svg>
              Preview
              {previewIndicator && (
                <span
                  className={`workspace-panel-status ${previewStatus.error || previewStatus.state === "failed" ? "error" : ""}`}
                >
                  {previewIndicator}
                </span>
              )}
            </button>
            <EnvironmentControl
              repository={repository}
              pane={pane}
              changesCount={changes.length}
              additions={changesAdded}
              deletions={changesRemoved}
              changesLoading={changesLoading}
              changesError={changesError}
              canDeliver={canDeliverChanges}
              active={activePanel === "changes"}
              tabIndex={workspacePanelStop === "changes" ? 0 : -1}
              triggerRef={changesPanelTriggerRef}
              onKeyDown={(event) => moveWorkspacePanel(event, "changes")}
              onOpenChanges={openChanges}
              onManageWorktrees={onManageWorktrees}
            />
          </div>
          {pane === "primary" && showOpenBeside && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onOpenBeside}
              title="Open a second conversation pane"
              aria-label={
                conversation?.title
                  ? `Open second pane beside "${conversation.title}" · ${providerLabel}`
                  : `Open second conversation pane beside ${providerLabel}`
              }
            >
              Beside
            </button>
          )}
          {threadId && !managedMode && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setForkOpen(true)}
              disabled={runActive}
              title="Fork this conversation to another provider"
              aria-label={`Fork ${providerLabel} conversation to another provider`}
            >
              Fork
            </button>
          )}
          {onClosePane && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onClosePane}
              aria-label={`Close ${pane} pane`}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className={`split ${activePanel === "changes" ? "with-review" : ""}`}>
        <div className={`conv ${conversationWorktreeMissing ? "conv--blocked" : ""}`.trim()}>
          <div className="thread-shell">
            <div
              className="thread"
              ref={transcriptViewport.viewportRef}
              onScroll={transcriptViewport.onScroll}
              data-following={transcriptViewport.following ? "true" : "false"}
            >
              <div className="wrap" ref={transcriptViewport.contentRef}>
                {conversationEmpty ? (
                  <section
                    className={`conversation-empty sparse ${canPickWorkspace ? "conversation-empty--setup" : ""} ${conversationWorktreeMissing ? "conversation-empty--blocked" : ""}`.trim()}
                    aria-labelledby={`${pane}-empty-title`}
                  >
                    <span>
                      {conversation && !historyRestored
                        ? "Restoring"
                        : !providersLoaded
                          ? "Checking"
                          : conversation
                            ? "Conversation"
                            : "New conversation"}
                    </span>
                    <h2 id={`${pane}-empty-title`}>{emptyState.title}</h2>
                    <p>{emptyState.detail}</p>
                    {emptyState.action}
                  </section>
                ) : null}
                {archivedTurns.map((turn, index) => (
                  <React.Fragment key={`archived-${turn.message.createdAt ?? index}`}>
                    <div className="turn user">
                      <div className="role">
                        <span className="av you">Y</span>
                        <span className="rname">You</span>
                        <span className="rtime">
                          {turn.message.createdAt ? formatElapsed(turn.message.createdAt) : "now"}
                        </span>
                      </div>
                      <p>{turn.message.text}</p>
                      {turn.contextReceipt && (
                        <ContextPackageSummary
                          receipt={turn.contextReceipt}
                          label="Submitted context"
                        />
                      )}
                      <TurnCopyAction text={turn.message.text} label="Copy prompt" />
                    </div>
                    <div className="turn">
                      <div className="role">
                        <span className="av">
                          {providerAvatarInitials(provider, providerLabel)}
                        </span>
                        <span className="rname">{providerLabel}</span>
                        <span className="rtime">
                          {turn.assistantAt ? formatElapsed(turn.assistantAt) : "now"}
                        </span>
                      </div>
                      {renderTimeline(
                        turn.events,
                        `archived-${index}`,
                        turn.state === "interrupted" || turn.state === "cancelled"
                          ? "cancelled"
                          : "running",
                      )}
                      <TurnChangesCard
                        checkpoint={turn.checkpoint}
                        pane={pane}
                        onOpen={openTurnChanges}
                      />
                      {renderArchivedFailure(turn.events)}
                      {turn.events
                        .filter(
                          (
                            event,
                          ): event is Extract<ProviderEvent, { kind: "governance_correlation" }> =>
                            event.kind === "governance_correlation",
                        )
                        .map((correlation) => (
                          <GovernanceCorrelationSummary
                            key={correlation.operationId}
                            correlation={correlation}
                          />
                        ))}
                      {(turn.state === "interrupted" || turn.state === "cancelled") && (
                        <p className="provider-state">{providerLabel} cancelled</p>
                      )}
                      <TurnCopyAction
                        text={assistantTextFromEvents(turn.events)}
                        label="Copy answer"
                      />
                    </div>
                  </React.Fragment>
                ))}
                {latestMessage && (
                  <div
                    className="turn user"
                    key={`${latestMessage.text}-${latestMessage.createdAt ?? "latest"}`}
                  >
                    <div className="role">
                      <span className="av you">Y</span>
                      <span className="rname">You</span>
                      <span className="rtime">
                        {latestMessage.createdAt ? formatElapsed(latestMessage.createdAt) : "now"}
                      </span>
                    </div>
                    <p>{latestMessage.text}</p>
                    {currentContextReceipt && (
                      <ContextPackageSummary
                        receipt={currentContextReceipt}
                        label="Submitted context"
                      />
                    )}
                    <TurnCopyAction text={latestMessage.text} label="Copy prompt" />
                  </div>
                )}
                {showAssistantTurn && (
                  <div className="turn" aria-live="polite">
                    <div className="role">
                      <span className="av">{providerAvatarInitials(provider, providerLabel)}</span>
                      <span className="rname">{providerLabel}</span>
                      <span className="rtime">
                        {runActive
                          ? "now"
                          : assistantTurnAt
                            ? formatElapsed(assistantTurnAt)
                            : "now"}
                      </span>
                    </div>
                    {(providerState === "starting" ||
                      providerState === "streaming" ||
                      providerState === "waiting_for_approval" ||
                      providerState === "waiting_for_input" ||
                      providerState === "cancelling") && (
                      <div className="thinking">
                        <span />
                        <span>{stateCopy[providerState]}</span>
                      </div>
                    )}
                    {assistantTimeline.length > 0 &&
                      renderTimeline(
                        providerEvents,
                        "current",
                        providerState === "cancelled" ? "cancelled" : "running",
                      )}
                    <TurnChangesCard checkpoint={checkpoint} pane={pane} onOpen={openTurnChanges} />
                    {providerEvents
                      .filter(
                        (
                          event,
                        ): event is Extract<ProviderEvent, { kind: "governance_correlation" }> =>
                          event.kind === "governance_correlation",
                      )
                      .map((correlation) => (
                        <GovernanceCorrelationSummary
                          key={correlation.operationId}
                          correlation={correlation}
                        />
                      ))}
                    {!runActive && <TurnCopyAction text={assistantText} label="Copy answer" />}
                    {approvals.map((approval) => (
                      <section
                        className={`approval-card ${approval.state}`}
                        key={approval.id}
                        aria-label={`${pane} pane approval required: ${approval.scope.summary}`}
                      >
                        <header>
                          <span>
                            <Icon name="shield" />
                          </span>
                          <div>
                            <strong>{approval.scope.summary}</strong>
                            <small>{approval.toolName} · one action only</small>
                          </div>
                          <em>{approval.state.replace("_", " ")}</em>
                        </header>
                        <dl className="approval-context">
                          <div>
                            <dt>Host</dt>
                            <dd title={location.host}>{location.host}</dd>
                          </div>
                          <div>
                            <dt>Repository</dt>
                            <dd title={approval.repository}>{approval.repository}</dd>
                          </div>
                          <div>
                            <dt>Worktree</dt>
                            <dd title={approval.worktree}>{approval.worktree}</dd>
                          </div>
                          <div>
                            <dt>Provider</dt>
                            <dd title={providerListLabel(approval.provider)}>
                              {providerListLabel(approval.provider)}
                            </dd>
                          </div>
                        </dl>
                        <p>{approval.scope.target}</p>
                        {approval.scope.details.length > 0 && (
                          <ul>
                            {approval.scope.details.map((detail) => (
                              <li key={detail}>{detail}</li>
                            ))}
                          </ul>
                        )}
                        <small className="approval-binding">
                          {location.host} · {pane} pane · conversation{" "}
                          {approval.conversationId.slice(0, 8)} · {approval.repository} ·{" "}
                          {approval.worktree} · {providerListLabel(approval.provider)} · direct ·{" "}
                          {approval.toolName} · {approval.scope.target}
                        </small>
                        {approval.state === "pending" && (
                          <footer>
                            <button
                              type="button"
                              aria-label={`Deny ${approval.toolName}: ${approval.scope.summary}`}
                              onClick={() => void decideApproval(approval, "deny")}
                            >
                              Deny
                            </button>
                            <Button
                              variant="primary"
                              size="sm"
                              aria-label={`Allow once ${approval.toolName}: ${approval.scope.summary}`}
                              onClick={() => void decideApproval(approval, "allow_once")}
                            >
                              Allow once
                            </Button>
                          </footer>
                        )}
                      </section>
                    ))}
                    {inputs.map((input) => (
                      <section
                        className="input-request-card"
                        key={input.id}
                        aria-label={`${pane} pane input required: ${input.question}`}
                      >
                        <header>
                          <strong>{input.question}</strong>
                          <span>
                            {input.responseMode === "native_resume"
                              ? "Resume stays in this conversation with a fresh approval scope"
                              : "Response stays in this child conversation"}
                          </span>
                        </header>
                        {input.responseMode === "native_resume" &&
                        input.resumeState === "unavailable" ? (
                          <p className="provider-error-hint" role="alert">
                            {input.resumeError ??
                              "Native Shikigami resume is unavailable. Start a new run to continue."}
                          </p>
                        ) : (
                          <>
                            {input.recommendation && <p>Recommendation: {input.recommendation}</p>}
                            {input.choices.length > 0 && (
                              <div className="input-request-choices">
                                {input.choices.map((choice) => (
                                  <Button
                                    type="button"
                                    size="sm"
                                    key={choice.id}
                                    title={choice.description ?? undefined}
                                    onClick={() =>
                                      setInputAnswers((current) => ({
                                        ...current,
                                        [input.id]: choice.label,
                                      }))
                                    }
                                  >
                                    {choice.label}
                                  </Button>
                                ))}
                              </div>
                            )}
                            <label htmlFor={`input-request-${pane}-${input.id}`}>
                              Answer for this conversation
                            </label>
                            <textarea
                              id={`input-request-${pane}-${input.id}`}
                              maxLength={4_000}
                              readOnly={!input.allowFreeForm}
                              value={inputAnswers[input.id] ?? ""}
                              onChange={(event) =>
                                setInputAnswers((current) => ({
                                  ...current,
                                  [input.id]: event.target.value,
                                }))
                              }
                            />
                            <footer>
                              <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                disabled={
                                  inputBusyId === input.id || !(inputAnswers[input.id] ?? "").trim()
                                }
                                onClick={() => void answerInput(input)}
                              >
                                Send answer
                              </Button>
                            </footer>
                          </>
                        )}
                      </section>
                    ))}
                    {failureView && (
                      <div
                        className={`provider-error ${failureView.kind === "park" ? "provider-error-park" : ""}`}
                        role="alert"
                      >
                        <p>
                          {/^provider failed\.?$/i.test(failureView.summary.trim())
                            ? `${providerName} failed.`
                            : failureView.summary}
                        </p>
                        {failureView.question && (
                          <p className="provider-error-question">
                            Question: {failureView.question}
                          </p>
                        )}
                        {failureRecovery.showSettings && !managedMode && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => onOpenProfiles(provider)}
                          >
                            Open provider settings
                          </Button>
                        )}
                        {failureView.resumeCommand && (
                          <div className="provider-error-resume">
                            <code title={failureView.resumeCommand}>
                              {failureView.resumeCommand}
                            </code>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              aria-label={`Copy CLI resume command: ${failureView.resumeCommand}`}
                              onClick={() => {
                                void navigator.clipboard
                                  ?.writeText(failureView.resumeCommand!)
                                  .catch(() => undefined);
                              }}
                            >
                              Copy CLI resume
                            </button>
                          </div>
                        )}
                        {failureView.kind === "park" && (
                          <p className="provider-error-hint">
                            Code can resume parked Shikigami runs only when the provider confirms
                            the bound run identity; otherwise start a fresh run from this
                            conversation.
                          </p>
                        )}
                      </div>
                    )}
                    {(providerState === "cancelled" || providerState === "failed") && (
                      <p className="provider-state">{stateCopy[providerState]}</p>
                    )}
                    {checkpoint && (
                      <section
                        className={`checkpoint-card ${checkpoint.state}`}
                        aria-label={`Workspace checkpoint, ${pane} pane: ${checkpoint.state}`}
                      >
                        <header>
                          <div>
                            <strong>Workspace checkpoint</strong>
                            <small>{checkpoint.state}</small>
                          </div>
                          {checkpoint.state === "completed" && !rewindPreview && (
                            <button
                              type="button"
                              aria-label={`Preview workspace rewind, ${pane} pane`}
                              onClick={() => void previewRewind()}
                              disabled={checkpointBusy}
                            >
                              {checkpointBusy ? "Inspecting…" : "Preview rewind"}
                            </button>
                          )}
                        </header>
                        {checkpoint.message && <p>{checkpoint.message}</p>}
                        {rewindPreview && (
                          <>
                            <p>
                              This restores the turn baseline. Only these files will be affected:
                            </p>
                            <ul>
                              {rewindPreview.files.map((file) => (
                                <li key={`${file.path}-${file.previousPath ?? ""}`}>
                                  <span>{file.state}</span>{" "}
                                  {file.previousPath ? `${file.previousPath} → ` : ""}
                                  {file.path}
                                </li>
                              ))}
                            </ul>
                            <footer>
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => rewindSession.clearPreview()}
                                disabled={checkpointBusy}
                                aria-label={`Cancel workspace rewind, ${pane} pane`}
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                className="rewind-confirm"
                                aria-label={`Confirm workspace rewind, ${pane} pane`}
                                onClick={() => void confirmRewind()}
                                disabled={checkpointBusy}
                              >
                                {checkpointBusy ? "Rechecking…" : "Confirm rewind"}
                              </Button>
                            </footer>
                          </>
                        )}
                        {checkpointError && (
                          <p className="checkpoint-error" role="alert">
                            {checkpointError}
                          </p>
                        )}
                      </section>
                    )}
                  </div>
                )}
              </div>
            </div>
            {!transcriptViewport.following && !conversationEmpty && (
              <button
                type="button"
                className="thread-follow-jump"
                onClick={transcriptViewport.jumpToLatest}
                aria-label={`Jump to latest messages, ${pane} pane`}
              >
                Jump to latest
              </button>
            )}
          </div>
          <div className="cwrap">
            {providerState === "completed" && threadId && !completionDismissed && (
              <div className="done" role="status">
                <div className="h">
                  <span className="pill completed">
                    <span className="dot" />
                    Completed
                  </span>
                  <span className="ttl">Workspace still in use</span>
                </div>
                <p className="done-copy">
                  <span className="done-copy-label">Worktree</span>
                  <code title={worktree?.path ?? conversation?.worktree ?? undefined}>
                    {worktree?.path ?? conversation?.worktree}
                  </code>
                  <span>is still checked out. Settling keeps the worktree.</span>
                </p>
                <div className="acts">
                  <button
                    type="button"
                    className="btn btn-default btn-sm"
                    aria-label={`Settle thread, ${pane} pane`}
                    onClick={() => {
                      void lifecycleControl
                        .settle(threadId)
                        .then(() => setCompletionDismissed(true))
                        .catch(() => undefined);
                    }}
                  >
                    Settle thread
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    aria-label={`Settle and release worktree, ${pane} pane`}
                    title="Settle and release worktree"
                    onClick={() => setReleaseWorktreeOpen(true)}
                  >
                    Settle &amp; release
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Keep conversation open, ${pane} pane`}
                    onClick={() => setCompletionDismissed(true)}
                  >
                    Keep open
                  </button>
                </div>
              </div>
            )}
            {canPickWorkspace && (
              <section
                className={`new-chat-context ${workspaceSetupVisible ? "is-open" : "is-collapsed"}`}
                aria-labelledby={`${pane}-new-chat-context-title`}
              >
                <h2 id={`${pane}-new-chat-context-title`} className="sr-only">
                  Choose where this conversation works
                </h2>
                <button
                  type="button"
                  className="new-chat-context-summary"
                  disabled={workspaceSetupRequired}
                  aria-expanded={workspaceSetupVisible}
                  aria-controls={
                    workspaceSetupVisible ? `${pane}-new-chat-context-body` : undefined
                  }
                  aria-label={
                    workspaceSetupRequired
                      ? `Workspace: ${workspaceSummary}. Setup details are required until a project and worktree are selected.`
                      : `Workspace: ${workspaceSummary}. ${workspaceSetupVisible ? "Hide" : "Show"} setup details.`
                  }
                  onClick={() => {
                    if (workspaceSetupRequired) return;
                    setWorkspaceSetupOpen((open) => !open);
                  }}
                >
                  <span className="new-chat-context-summary-icon" aria-hidden="true">
                    <Icon name="route" />
                  </span>
                  <span className="new-chat-context-summary-copy">
                    <span className="new-chat-context-eyebrow">Workspace</span>
                    <strong title={workspaceSummary}>{workspaceSummary}</strong>
                    <small title={workspaceSummaryDetail}>{workspaceSummaryDetail}</small>
                  </span>
                  {workspaceSetupStatus.tone !== "ready" && (
                    <span
                      className={`new-chat-context-status ${workspaceSetupStatus.tone}`}
                      aria-hidden="true"
                    >
                      <span />
                      {workspaceSetupStatus.label}
                    </span>
                  )}
                  <Icon name="chevron" />
                </button>
                {workspaceSetupVisible && (
                  <div className="new-chat-context-body" id={`${pane}-new-chat-context-body`}>
                    <div className="new-chat-context-header">
                      <div className="new-chat-context-heading">
                        <span className="new-chat-context-eyebrow">Workspace setup</span>
                        <p>Adjust the project, worktree, or ownership before sending.</p>
                      </div>
                    </div>
                    <div className="new-chat-context-rows">
                      <div
                        className="new-chat-context-row new-chat-context-row--host"
                        aria-label={`${hostLabel}, current Aldunis host`}
                      >
                        <Icon name="computer" />
                        <span className="new-chat-context-copy">
                          <strong>Execution host</strong>
                          <small>{hostLabel}</small>
                        </span>
                      </div>
                      <div className="new-chat-context-control" ref={projectMenuRef}>
                        <button
                          type="button"
                          className="new-chat-context-row new-chat-context-row--button"
                          onClick={openProjectMenu}
                          title={repository?.root ?? "Choose a project"}
                          aria-haspopup="listbox"
                          aria-expanded={projectMenuOpen}
                          aria-controls={
                            projectMenuOpen ? `${pane}-new-chat-project-menu` : undefined
                          }
                          aria-label={
                            repository
                              ? `Project ${repository.name}. Open project selector.`
                              : "Choose a project."
                          }
                        >
                          <Icon name="folder" />
                          <span className="new-chat-context-copy">
                            <strong>{repository?.name ?? "Choose a project"}</strong>
                            <small title={repository?.root}>
                              {repository?.root ?? "Choose a project before sending"}
                            </small>
                          </span>
                          <Icon name="chevron" />
                        </button>
                        {projectMenuOpen && (
                          <div
                            id={`${pane}-new-chat-project-menu`}
                            className="new-chat-context-menu composer-provider-menu"
                            role="listbox"
                            aria-label="Choose project"
                          >
                            {projects.map((project) => {
                              const selected =
                                project.id === repository?.projectId ||
                                project.memberIds?.includes(repository?.projectId ?? "") ||
                                project.root === repository?.root;
                              return (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  aria-label={`${project.name}: ${project.root}${selected ? ", selected" : ""}`}
                                  data-project-option=""
                                  data-project-id={project.id}
                                  key={project.id}
                                  className={`composer-provider-option ${selected ? "active" : ""}`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    selectProject(project.id);
                                  }}
                                >
                                  <span className="n">
                                    {project.name}
                                    {selected ? " · selected" : ""}
                                  </span>
                                  <span className="p">{project.root}</span>
                                </button>
                              );
                            })}
                            {projects.length === 0 && (
                              <p className="new-chat-context-note" role="note">
                                No registered projects yet.
                              </p>
                            )}
                            <button
                              type="button"
                              className="composer-provider-option add"
                              aria-label="Add project: Register a local repository once"
                              onClick={() => {
                                composerPopovers.closeMenus();
                                onAddProject();
                              }}
                            >
                              <span className="n">Add project…</span>
                              <span className="p">Register a local repository once</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="new-chat-context-control" ref={workspaceMenuRef}>
                        <button
                          type="button"
                          className="new-chat-context-row new-chat-context-row--button"
                          aria-haspopup="listbox"
                          aria-expanded={workspaceMenuOpen}
                          aria-controls={
                            workspaceMenuOpen ? `${pane}-new-chat-workspace-menu` : undefined
                          }
                          title={workspaceCopy.detail}
                          aria-label={`Workspace strategy: ${workspaceCopy.label}. Open workspace strategy menu.`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openWorkspaceMenu();
                          }}
                        >
                          <Icon name="code" />
                          <span className="new-chat-context-copy">
                            <strong>{newConversationWorkspaceCopy.label}</strong>
                            <small>{newConversationWorkspaceCopy.summary}</small>
                          </span>
                          <Icon name="chevron" />
                        </button>
                        {workspaceMenuOpen && (
                          <div
                            id={`${pane}-new-chat-workspace-menu`}
                            className="new-chat-context-menu composer-provider-menu"
                            role="listbox"
                            aria-label="Choose workspace strategy"
                          >
                            {NEW_CONVERSATION_WORKSPACE_MODES.map((item) => {
                              const selected = item === workspaceMode;
                              const native = item === "provider-native";
                              const available = !native || providerNativeWorkspaceAvailable;
                              const itemCopy = NEW_CONVERSATION_WORKSPACE_COPY[item];
                              const detail =
                                native && !available
                                  ? "Provider-owned workspaces are not available for this provider yet."
                                  : itemCopy.detail;
                              return (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  aria-disabled={!available}
                                  disabled={!available}
                                  aria-label={`${itemCopy.label}: ${detail}${selected ? ", selected" : ""}`}
                                  key={item}
                                  data-workspace-option=""
                                  data-workspace-mode={item}
                                  className={`composer-provider-option ${selected ? "active" : ""} ${available ? "" : "not-ready"}`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    selectWorkspaceMode(item, "menu");
                                  }}
                                >
                                  <span className="n">
                                    {itemCopy.label}
                                    {selected ? " · selected" : ""}
                                  </span>
                                  <span className="p">{detail}</span>
                                </button>
                              );
                            })}
                            {!providerNativeWorkspaceAvailable && (
                              <p className="new-chat-context-note" role="note">
                                Provider-owned workspaces are unavailable for this provider. A
                                dedicated worktree is ready to use.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                      {showManagedCreateHint && (
                        <div
                          className="new-chat-context-worktree-picker new-chat-context-worktree-picker--create"
                          role="note"
                          aria-label="Dedicated worktree will be created"
                        >
                          <div className="new-chat-context-row new-chat-context-row--static">
                            <Icon name="branch" />
                            <span className="new-chat-context-copy">
                              <strong>New worktree on start</strong>
                              <small>
                                Choose the starting branch when you approve creation.
                                {repository?.defaultBranch
                                  ? ` Default base: ${repository.defaultBranch}.`
                                  : ""}
                              </small>
                            </span>
                          </div>
                        </div>
                      )}
                      {showSharedWorktreePicker && (
                        <div
                          className="new-chat-context-worktree-picker"
                          role="group"
                          aria-label="Choose the conversation worktree"
                        >
                          {selectableWorktrees.length > 1 && (
                            <div className="new-chat-worktree-tools">
                              <label
                                htmlFor={`${pane}-worktree-filter`}
                                className="new-chat-worktree-filter-label"
                              >
                                Filter branches
                              </label>
                              <input
                                id={`${pane}-worktree-filter`}
                                type="search"
                                value={worktreeFilter}
                                onChange={(event) => setWorktreeFilter(event.target.value)}
                                placeholder="Filter branches…"
                                aria-controls={`${pane}-worktree-select`}
                              />
                              <span className="new-chat-worktree-count" aria-live="polite">
                                {worktreeFilterHasNoMatches
                                  ? "No matches"
                                  : `${filteredSelectableWorktrees.length} available`}
                              </span>
                            </div>
                          )}
                          {previousWorktreeSeed && previousWorktreeOption && (
                            <button
                              type="button"
                              className="previous-worktree-seed"
                              onClick={selectPreviousWorktree}
                              title={previousWorktreeSeed.worktreePath}
                              aria-label={`Use previous worktree ${formatWorktreeOptionLabel(previousWorktreeOption)}`}
                            >
                              <span className="previous-worktree-seed__label">
                                Previous worktree
                              </span>
                              <span className="previous-worktree-seed__value">
                                {formatWorktreeOptionLabel(previousWorktreeOption)}
                              </span>
                            </button>
                          )}
                          <label className="new-chat-context-row new-chat-context-row--select">
                            <Icon name="branch" />
                            <span className="new-chat-context-copy">
                              <strong>
                                {worktree?.branch ??
                                  (worktree ? "Detached HEAD" : "Choose a worktree")}
                              </strong>
                              <small title={worktree?.path}>
                                {worktree?.path ?? "Select an available branch"}
                              </small>
                            </span>
                            <Icon name="chevron" />
                            <select
                              id={`${pane}-worktree-select`}
                              aria-label="Choose the conversation worktree"
                              value={worktreeSelectValue}
                              disabled={
                                selectableWorktrees.length === 0 || worktreeFilterHasNoMatches
                              }
                              onChange={(event) => {
                                if (event.target.value) onSelectWorktree(event.target.value);
                              }}
                            >
                              {selectableWorktrees.length === 0 && (
                                <option value="">No available worktree</option>
                              )}
                              {worktreeFilterHasNoMatches && (
                                <option value="">No matching worktree</option>
                              )}
                              {managedSelectableWorktrees.length > 0 && (
                                <optgroup label="Aldunis worktrees">
                                  {managedSelectableWorktrees.map((item) => (
                                    <option value={item.path} key={item.path}>
                                      {formatWorktreeOptionLabel(item)}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {userSelectableWorktrees.length > 0 && (
                                <optgroup label="Existing worktrees">
                                  {userSelectableWorktrees.map((item) => (
                                    <option value={item.path} key={item.path}>
                                      {formatWorktreeOptionLabel(item)}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            <div
              className={`cbox${composerDragDepth > 0 ? " is-drop-target" : ""}${composerImageBusy ? " is-staging-images" : ""}`}
              data-composer-drop-zone={pane}
              onDragEnter={(event) => {
                if (!dataTransferHasFiles(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                setComposerDragDepth((depth) => depth + 1);
              }}
              onDragOver={(event) => {
                if (!dataTransferHasFiles(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (!dataTransferHasFiles(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                setComposerDragDepth((depth) => Math.max(0, depth - 1));
              }}
              onDrop={(event) => {
                if (!dataTransferHasFiles(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                setComposerDragDepth(0);
                const { images, rejected } = collectComposerImagesFromDataTransfer(
                  event.dataTransfer,
                );
                if (images.length === 0) {
                  setContextError(
                    rejected > 0
                      ? "Only GIF, JPEG, PNG, and WebP images up to 2 MB can be dropped into the composer."
                      : "Drop a supported image file onto the composer.",
                  );
                  return;
                }
                if (rejected > 0) {
                  setContextError(
                    "Some dropped files were skipped. Only GIF, JPEG, PNG, and WebP images up to 2 MB are accepted.",
                  );
                }
                void attachComposerImageFiles(images, { preserveError: rejected > 0 });
              }}
            >
              {composerDragDepth > 0 && (
                <div className="composer-drop-affordance" role="status" aria-live="polite">
                  Drop images to attach
                </div>
              )}
              {promptStash.length > 0 && (
                <button
                  type="button"
                  className={`composer-stash-badge${stashPulse ? " is-pulse" : ""}${stashMenuOpen ? " is-open" : ""}`}
                  data-prompt-stash-badge={pane}
                  aria-label={`Stashed prompts: ${promptStash.length}. Open stash.`}
                  aria-expanded={stashMenuOpen}
                  aria-controls={`${pane}-prompt-stash-menu`}
                  title={`Stashed prompts (${PROMPT_STASH_SHORTCUT_LABEL})`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => {
                    loadLatestPromptStash();
                    setStashMenuOpen((open) => !open);
                  }}
                >
                  <span className="composer-stash-badge-label">Stash</span>
                  <span className="composer-stash-badge-count" aria-hidden="true">
                    {promptStash.length}
                  </span>
                </button>
              )}
              {stashMenuOpen && promptStash.length > 0 && (
                <div
                  ref={stashMenuRef}
                  id={`${pane}-prompt-stash-menu`}
                  className="composer-stash-menu"
                  role="listbox"
                  aria-label="Stashed prompts"
                >
                  <div className="composer-stash-menu-label">Stashed prompts</div>
                  <ul className="composer-stash-menu-list">
                    {promptStash.map((entry) => (
                      <li key={entry.id} className="composer-stash-menu-row">
                        <button
                          type="button"
                          role="option"
                          className="composer-stash-menu-item"
                          aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                          onClick={() => restoreStashEntry(entry.id)}
                        >
                          <span className="composer-stash-menu-snippet">
                            {stashEntrySnippet(entry)}
                          </span>
                          <small className="composer-stash-menu-time">
                            {formatElapsed(entry.createdAt)}
                          </small>
                        </button>
                        <button
                          type="button"
                          className="composer-stash-menu-delete"
                          aria-label={`Delete stashed prompt: ${stashEntrySnippet(entry)}`}
                          onClick={() => deleteStashEntry(entry.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {stashStatus && (
                <div className="composer-stash-status" role="status" aria-live="polite">
                  {stashStatus}
                </div>
              )}
              {elementReferences.length > 0 && (
                <div className="composer-context" aria-label="Attached element context">
                  {elementReferences.map((reference, index) => (
                    <span key={`${reference.selector}-${index}`}>
                      {reference.tag} · {reference.name ?? reference.selector}
                      <button
                        type="button"
                        onClick={() =>
                          setElementReferences((current) =>
                            current.filter((_, item) => item !== index),
                          )
                        }
                        aria-label={`Remove element reference ${reference.name ?? reference.selector}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {attachments.length > 0 && (
                <div className="context-chips" aria-label="Attached local context">
                  {attachments.map((path) => (
                    <span key={path}>
                      @{path}
                      <button
                        type="button"
                        onClick={() =>
                          setAttachments((current) => current.filter((item) => item !== path))
                        }
                        aria-label={`Remove ${path}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="composer-context-summary"
                onClick={() => {
                  setPlanOpen(false);
                  setContextOpen(true);
                }}
                aria-label="Inspect draft context package"
              >
                Context:{" "}
                {draftContextReceipt
                  ? `${draftContextReceipt.entries.filter((entry) => entry.omissionReason === null).length} files, approximately ${draftContextReceipt.estimatedTokens.toLocaleString()} tokens`
                  : contextPackageBusy
                    ? "resolving…"
                    : "unavailable"}
              </button>
              {suggestionMode && (
                <div
                  className="composer-suggestions"
                  role="listbox"
                  aria-label={
                    suggestionMode === "path"
                      ? "File suggestions"
                      : suggestionMode === "skill"
                        ? "Skill suggestions"
                        : "Command suggestions"
                  }
                >
                  {suggestionGroups.map((group) => (
                    <section className="composer-suggestions-group" key={group.id}>
                      <div className="composer-suggestions-group-label">{group.label}</div>
                      {group.items.map((suggestion) => {
                        const index = orderedSuggestions.indexOf(suggestion);
                        return (
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === suggestionIndex}
                            aria-label={suggestion.label + ": " + suggestion.description}
                            title={suggestion.label + " — " + suggestion.description}
                            className={index === suggestionIndex ? "active" : ""}
                            key={suggestion.id}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setSuggestionIndex(index)}
                            onClick={() => selectSuggestion(suggestion)}
                          >
                            {suggestion.type === "path" && (
                              <span className="composer-suggestion-kind" aria-hidden="true">
                                @
                              </span>
                            )}
                            <strong title={suggestion.label}>{suggestion.label}</strong>
                            <small title={suggestion.description}>{suggestion.description}</small>
                          </button>
                        );
                      })}
                    </section>
                  ))}
                  {suggestions.length === 0 && (
                    <p className="composer-suggestions-empty">
                      {suggestionMode === "path"
                        ? "No matching files or folders."
                        : suggestionMode === "skill"
                          ? "No matching skills."
                          : "No matching commands."}
                    </p>
                  )}
                </div>
              )}
              <textarea
                ref={composerRef}
                className="composer-input"
                value={draft}
                spellCheck
                onChange={(event) => {
                  const value = event.target.value;
                  if (voiceInputState === "listening") voiceInputModule.stop();
                  voiceInputModule.clearError();
                  setDraft(value);
                  // Typing while recalling a prior prompt exits history browse (live draft).
                  setPromptHistoryBrowse((current) =>
                    isBrowsingPromptHistory(current, promptHistory)
                      ? resetPromptHistoryBrowse(promptHistory)
                      : current,
                  );
                }}
                onPaste={(event) => {
                  voiceInputModule.clearError();
                  const { images, rejected } = collectComposerImagesFromClipboard(
                    event.clipboardData,
                  );
                  if (images.length === 0) {
                    setContextError(null);
                    return;
                  }
                  // Image paste replaces the default binary/file paste into the textarea.
                  event.preventDefault();
                  if (rejected > 0) {
                    setContextError(
                      "Some pasted items were skipped. Only GIF, JPEG, PNG, and WebP images up to 2 MB are accepted.",
                    );
                  } else {
                    setContextError(null);
                  }
                  void attachComposerImageFiles(images, { preserveError: rejected > 0 });
                }}
                onKeyDown={(event) => {
                  if (matchesPromptStashShortcut(event)) {
                    event.preventDefault();
                    if (draft.trim()) {
                      stashCurrentDraft();
                      return;
                    }
                    const latest = loadLatestPromptStash();
                    if (latest.length > 0) {
                      setStashMenuOpen((open) => !open);
                      setStashStatus(null);
                    }
                    return;
                  }
                  if (
                    suggestionMode &&
                    orderedSuggestions.length > 0 &&
                    (event.key === "ArrowDown" || event.key === "ArrowUp")
                  ) {
                    event.preventDefault();
                    setSuggestionIndex((current) =>
                      event.key === "ArrowDown"
                        ? (current + 1) % orderedSuggestions.length
                        : (current - 1 + orderedSuggestions.length) % orderedSuggestions.length,
                    );
                    return;
                  }
                  if (
                    suggestionMode &&
                    orderedSuggestions.length > 0 &&
                    (event.key === "Tab" || event.key === "Enter")
                  ) {
                    event.preventDefault();
                    selectSuggestion(orderedSuggestions[suggestionIndex]);
                    return;
                  }
                  if (event.key === "Escape" && stashMenuOpen) {
                    event.preventDefault();
                    setStashMenuOpen(false);
                    return;
                  }
                  if (event.key === "Escape" && suggestionMode) {
                    event.preventDefault();
                    setSuggestionMode(null);
                    return;
                  }
                  if (
                    event.key === "Escape" &&
                    isBrowsingPromptHistory(promptHistoryBrowse, promptHistory)
                  ) {
                    event.preventDefault();
                    setDraft(promptHistoryBrowse.draftBeforeHistory);
                    setPromptHistoryBrowse(resetPromptHistoryBrowse(promptHistory));
                    return;
                  }
                  // Shell-style prompt history: ↑ at start/empty (or while browsing), ↓ while browsing.
                  if (!suggestionMode && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    const browsing = isBrowsingPromptHistory(promptHistoryBrowse, promptHistory);
                    if (event.key === "ArrowUp") {
                      if (!browsing && !isComposerHistoryBoundary(event.currentTarget)) return;
                      const next = stepPromptHistoryUp(promptHistory, promptHistoryBrowse, draft);
                      if (!next) return;
                      event.preventDefault();
                      setPromptHistoryBrowse(next);
                      setDraft(draftForPromptHistoryIndex(promptHistory, next));
                      return;
                    }
                    if (!browsing) return;
                    const next = stepPromptHistoryDown(promptHistory, promptHistoryBrowse);
                    if (!next) return;
                    event.preventDefault();
                    setPromptHistoryBrowse(next);
                    setDraft(draftForPromptHistoryIndex(promptHistory, next));
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  !historyRestored
                    ? "Restoring conversation session…"
                    : conversationWorktreeMissing
                      ? "Conversation worktree is not available for the open repository…"
                      : !providerReady
                        ? providerReadinessMessage
                        : worktree
                          ? readyComposerPlaceholder(providerName, threadId)
                          : "Choose a project and worktree to continue…"
                }
                id={`${pane}-composer`}
                name={`${pane}-composer`}
                aria-label={`Message ${providerName}`}
                title={`Stash draft with ${PROMPT_STASH_SHORTCUT_LABEL}`}
                disabled={!worktree || !providerReady || runActive || !historyRestored}
              />
              {voiceInputState === "listening" && (
                <div className="voice-input-status" role="status" aria-live="polite">
                  <span className="voice-input-status-dot" aria-hidden="true" />
                  <span>
                    Listening… {voiceInputInterim ? `“${voiceInputInterim}”` : "Speak naturally."}
                  </span>
                </div>
              )}
              {voiceInputError && (
                <div className="context-error voice-input-error" role="alert">
                  {voiceInputError}
                </div>
              )}
              {!providerReady && historyRestored && providersLoaded && (
                <div className="context-error" role="status">
                  {providerReadinessMessage}
                </div>
              )}
              {contextError && !contextOpen && (
                <div className="context-error" role="alert">
                  {contextError}
                </div>
              )}
              {historyRestoreError && (
                <div className="context-error" role="alert">
                  {historyRestoreError}
                </div>
              )}
              <div className="crow">
                <button
                  type="button"
                  className={`voice-input-toggle ${voiceInputState === "listening" ? "is-listening" : ""} ${voiceInputState === "error" ? "is-error" : ""}`}
                  aria-pressed={voiceInputState === "listening"}
                  aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
                  aria-label={
                    voiceInputState === "listening"
                      ? "Stop voice input"
                      : voiceInputState === "unsupported"
                        ? "Voice input unavailable"
                        : voiceInputState === "error"
                          ? "Try voice input again"
                          : "Start voice input"
                  }
                  title={
                    voiceInputState === "listening"
                      ? `Stop voice input (${VOICE_INPUT_SHORTCUT_LABEL})`
                      : voiceInputState === "unsupported"
                        ? "Voice input is not available in this browser"
                        : voiceInputState === "error"
                          ? `Try voice input again (${VOICE_INPUT_SHORTCUT_LABEL})`
                          : `Start voice input (${VOICE_INPUT_SHORTCUT_LABEL})`
                  }
                  disabled={!worktree || !providerReady || runActive || !historyRestored}
                  onClick={() => {
                    voiceInputModule.toggle(draft);
                  }}
                >
                  <svg className="ic ic-lg" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                  </svg>
                </button>
                {contextUsage && <ContextWindowMeter usage={contextUsage} />}
                <div className="composer-run-settings" role="group" aria-label="Run settings">
                  <div className="composer-provider" ref={providerMenuRef}>
                    <button
                      type="button"
                      className="cc"
                      disabled={runActive || managedMode}
                      aria-haspopup={
                        managedMode ? undefined : canSwitchProvider ? "listbox" : undefined
                      }
                      aria-expanded={
                        managedMode ? undefined : canSwitchProvider ? providerMenuOpen : undefined
                      }
                      title={
                        managedMode
                          ? "Managed hosted mode fixes Shikigami and does not allow provider selection."
                          : !providersLoaded
                            ? "Checking provider…"
                            : !providerReady
                              ? providerReadinessMessage
                              : canSwitchProvider
                                ? "Open the provider menu"
                                : conversation
                                  ? "Provider is fixed for this conversation. Use Fork in the top bar to change providers. Click opens provider profiles."
                                  : "Open provider profiles"
                      }
                      aria-label={
                        managedMode
                          ? "Managed hosted mode: Shikigami"
                          : !providersLoaded
                            ? `Checking ${providerName}…`
                            : !providerReady
                              ? `${providerName} not ready: ${providerReadinessMessage}`
                              : canSwitchProvider
                                ? `Provider ${providerName}. Open menu to choose among ${availableProviders.length} providers.`
                                : conversation
                                  ? "Open provider profiles. Provider is fixed — use Fork to change providers."
                                  : "Open provider profiles"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (managedMode) return;
                        if (!canSwitchProvider) {
                          closeComposerMenus();
                          onOpenProfiles(provider);
                          return;
                        }
                        composerPopovers.toggleMenu("provider");
                      }}
                    >
                      <span className="pv" aria-hidden="true">
                        {providerAvatarInitials(provider, providerLabel)}
                      </span>
                      {providerChipName}
                      {selectedProfileName && (
                        <span
                          className="composer-provider-profile-chip"
                          title={`Profile: ${selectedProfileName}`}
                        >
                          · {selectedProfileName}
                        </span>
                      )}
                      {!managedMode && (
                        <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      )}
                    </button>
                    {providerMenuOpen && canSwitchProvider && (
                      <div
                        className="composer-provider-menu"
                        role="listbox"
                        aria-label="Choose provider"
                      >
                        {availableProviders.map((id) => {
                          const discovery = providers.find((item) => item.id === id);
                          const label = providerDisplayName(id, discovery);
                          const chip = formatProviderChipName(id, discovery);
                          const selected = id === provider;
                          const menuProfileId =
                            id === "shikigami"
                              ? shikigamiProfiles.some((profile) => profile.id === profileId)
                                ? profileId
                                : defaultShikigamiProfileId
                              : id === "claude-code"
                                ? claudeProfiles.some((profile) => profile.id === profileId)
                                  ? profileId
                                  : defaultClaudeProfileId
                                : null;
                          const readiness = assessProviderRunReadiness({
                            provider: id,
                            discoveryLoaded: providersLoaded,
                            discovery,
                            profileId: menuProfileId,
                            profiles,
                            providerName: label,
                          });
                          const ready = readiness.canRun;
                          const status = ready
                            ? selected
                              ? "selected"
                              : "ready"
                            : readiness.message;
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              aria-label={`${label}: ${chip} · ${status}`}
                              key={id}
                              data-provider-option=""
                              data-provider-id={id}
                              className={`composer-provider-option ${selected ? "active" : ""} ${ready ? "" : "not-ready"}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                selectProvider(id, "menu");
                              }}
                            >
                              <span className="n">{label}</span>
                              <span className="p">
                                {chip} · {status}
                              </span>
                            </button>
                          );
                        })}
                        {provider === "claude-code" && claudeProfiles.length > 1 && (
                          <div className="composer-provider-profile">
                            <label htmlFor={`${pane}-composer-claude-profile`}>
                              Claude Code profile
                              <select
                                id={`${pane}-composer-claude-profile`}
                                value={profileId}
                                aria-label="Claude Code profile"
                                onChange={(event) => setProfileId(event.target.value)}
                              >
                                {claudeProfiles.map((profile) => (
                                  <option value={profile.id} key={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        )}
                        {provider === "shikigami" && shikigamiProfiles.length > 1 && (
                          <div className="composer-provider-profile">
                            <label htmlFor={`${pane}-composer-shikigami-profile`}>
                              Shikigami profile
                              <select
                                id={`${pane}-composer-shikigami-profile`}
                                value={profileId}
                                onChange={(event) => {
                                  const nextProfileId = event.target.value;
                                  setProfileId(nextProfileId);
                                  setModel(
                                    resolveDefaultProviderModel(
                                      "shikigami",
                                      providerDiscoveryForProfile(
                                        "shikigami",
                                        shikigamiProvider,
                                        nextProfileId,
                                      ),
                                    ),
                                  );
                                }}
                              >
                                {shikigamiProfiles.map((profile) => (
                                  <option value={profile.id} key={profile.id}>
                                    {profile.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        )}
                        <div
                          className="composer-menu-section composer-menu-section--separator"
                          role="presentation"
                        >
                          Provider setup
                        </div>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          aria-label="Provider profiles: Manage binaries and env for each provider"
                          className="composer-provider-option add"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            composerPopovers.closeMenus();
                            onOpenProfiles(provider);
                          }}
                        >
                          <span className="n">Provider profiles…</span>
                          <span className="p">Manage binaries and env for each provider</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="composer-provider" ref={modelMenuRef}>
                    <button
                      type="button"
                      className="cc"
                      disabled={!canPickModel}
                      aria-haspopup={managedMode ? undefined : "listbox"}
                      aria-expanded={managedMode ? undefined : modelMenuOpen}
                      title={
                        managedMode
                          ? "Managed hosted mode fixes the operator-approved model."
                          : "Open the model menu"
                      }
                      aria-label={
                        managedMode
                          ? `Managed model ${modelChipDisplay}`
                          : showReasoningEffort
                            ? `Model ${modelChipDisplay}, effort ${reasoningEffort}. Open menu to choose a model or reasoning effort.`
                            : `Model ${modelChipDisplay}. Open menu to choose a model.`
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (managedMode) return;
                        if (!canPickModel) return;
                        composerPopovers.toggleMenu("model");
                      }}
                    >
                      {showReasoningEffort
                        ? `${modelChipDisplay} · ${reasoningEffort}`
                        : modelChipDisplay}
                      {!managedMode && (
                        <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      )}
                    </button>
                    {modelMenuOpen && canPickModel && (
                      <div
                        className="composer-provider-menu"
                        role="listbox"
                        aria-label="Choose model"
                      >
                        {modelOptions.map((option) => {
                          const selected = option.id === effectiveModel || option.id === model;
                          const isDiscoveryDefault = selectedProvider?.models?.some(
                            (entry) => entry.id === option.id && entry.isDefault,
                          );
                          const detail =
                            [
                              isDiscoveryDefault ? "Default model" : null,
                              selected ? "Selected" : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "Available";
                          return (
                            <button
                              type="button"
                              role="option"
                              aria-selected={selected}
                              aria-label={`${option.displayName} (${option.id}): ${detail}`}
                              title={option.id}
                              key={option.id}
                              data-model-option=""
                              data-model-id={option.id}
                              className={`composer-provider-option ${selected ? "active" : ""}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                selectModel(option.id, "menu");
                              }}
                            >
                              <span className="n">{option.displayName}</span>
                              <span className="p">{detail}</span>
                            </button>
                          );
                        })}
                        {showReasoningEffort && (
                          <>
                            <div className="composer-menu-section" role="presentation">
                              Reasoning effort
                            </div>
                            {reasoningEfforts.map((effort) => {
                              const selected = effort === reasoningEffort;
                              return (
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  aria-label={`Reasoning effort ${effort}${selected ? ", selected" : ""}`}
                                  key={`effort-${effort}`}
                                  className={`composer-provider-option ${selected ? "active" : ""}`}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (!composerPopovers.pointerSelectionAllowed("model")) return;
                                    setReasoningEffort(effort);
                                    composerPopovers.closeMenus();
                                  }}
                                >
                                  <span className="n">{effort}</span>
                                  <span className="p">{selected ? "selected" : "reasoning"}</span>
                                </button>
                              );
                            })}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="cdiv" />
                  {!managedMode && (
                    <div className="composer-provider composer-mode-group" ref={modeMenuRef}>
                      {/* Single control: mode + tool scope. Dual Access/Mode chips both
                  opened the same menu and "Access Read-only" read like privacy. */}
                      <button
                        type="button"
                        className={`cc ${accessScope.warning ? "scoped" : ""}`}
                        disabled={!canPickMode}
                        aria-haspopup={managedMode ? undefined : "listbox"}
                        aria-expanded={managedMode ? undefined : modeMenuOpen}
                        aria-controls={
                          managedMode
                            ? undefined
                            : modeMenuOpen
                              ? `${pane}-composer-mode-menu`
                              : undefined
                        }
                        title={
                          managedMode
                            ? "Managed hosted mode fixes Build · Worktree write."
                            : `${modeCopy[mode].label} · ${accessScope.detail}`
                        }
                        aria-label={
                          managedMode
                            ? "Managed hosted mode: Build, Worktree write"
                            : `Mode ${modeCopy[mode].label}, tool scope ${accessScope.label}. ${accessScope.detail}. Opens the mode menu.`
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (managedMode) return;
                          if (!canPickMode) return;
                          openModeMenu();
                        }}
                      >
                        <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="3" y="11" width="18" height="10" rx="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        <span className="mode-chip-label">
                          {modeCopy[mode].label}
                          <span className="mode-chip-scope"> · {accessScope.label}</span>
                        </span>
                        {!managedMode && (
                          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        )}
                      </button>
                      {modeMenuOpen && canPickMode && (
                        <div
                          id={`${pane}-composer-mode-menu`}
                          className="composer-provider-menu"
                          role="listbox"
                          aria-label="Choose interaction mode"
                        >
                          {INTERACTION_MODES.map((item) => {
                            const selected = item === mode;
                            const scopeLabel =
                              item === "ask"
                                ? "Read-only"
                                : item === "plan"
                                  ? "Plan only"
                                  : "Worktree write";
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-label={`${modeCopy[item].label} · ${scopeLabel}: ${modeCopy[item].authority}${selected ? ", selected" : ""}`}
                                key={item}
                                data-mode-option=""
                                data-mode-id={item}
                                className={`composer-provider-option ${selected ? "active" : ""}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  selectMode(item, "menu");
                                }}
                              >
                                <span className="n">
                                  {modeCopy[item].label} · {scopeLabel}
                                </span>
                                <span className="p">
                                  {modeCopy[item].authority}
                                  {selected ? " · selected" : ""}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  {!canPickWorkspace && (
                    <div
                      className="composer-provider composer-workspace-group"
                      ref={workspaceMenuRef}
                    >
                      <button
                        type="button"
                        className="cc workspace-mode-chip"
                        disabled={!canPickWorkspace}
                        aria-haspopup={canPickWorkspace ? "listbox" : undefined}
                        aria-expanded={canPickWorkspace ? workspaceMenuOpen : undefined}
                        aria-controls={
                          canPickWorkspace && workspaceMenuOpen
                            ? `${pane}-composer-workspace-menu`
                            : undefined
                        }
                        title={
                          conversation
                            ? `Workspace is fixed to ${workspaceCopy.label}. Use a reviewed fork to create another conversation.`
                            : workspaceCopy.detail
                        }
                        aria-label={
                          conversation
                            ? `Workspace ${workspaceCopy.label}. Fixed for this conversation.`
                            : `Workspace ${workspaceCopy.label}. Opens workspace mode menu.`
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (canPickWorkspace) openWorkspaceMenu();
                        }}
                      >
                        {workspaceCopy.shortLabel}
                        {canPickWorkspace && (
                          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        )}
                      </button>
                      {workspaceMenuOpen && canPickWorkspace && (
                        <div
                          id={`${pane}-composer-workspace-menu`}
                          className="composer-provider-menu workspace-mode-menu"
                          role="listbox"
                          aria-label="Choose conversation workspace"
                        >
                          {(Object.keys(WORKSPACE_MODE_COPY) as WorkspaceMode[]).map((item) => {
                            const selected = item === workspaceMode;
                            const native = item === "provider-native";
                            const available = !native || providerNativeWorkspaceAvailable;
                            const detail =
                              native && !available
                                ? (capabilities?.workspace?.providerNativeDetail ??
                                  "This provider adapter does not expose native worktree creation yet.")
                                : WORKSPACE_MODE_COPY[item].detail;
                            return (
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                aria-disabled={!available}
                                disabled={!available}
                                aria-label={`${WORKSPACE_MODE_COPY[item].label}: ${detail}${selected ? ", selected" : ""}`}
                                key={item}
                                data-workspace-option=""
                                data-workspace-mode={item}
                                className={`composer-provider-option ${selected ? "active" : ""} ${available ? "" : "not-ready"}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  selectWorkspaceMode(item, "menu");
                                }}
                              >
                                <span className="n">
                                  {WORKSPACE_MODE_COPY[item].label}
                                  {selected ? " · selected" : ""}
                                </span>
                                <span className="p">{detail}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {runId ? (
                  <button
                    type="button"
                    className="send"
                    onClick={() => void cancel()}
                    disabled={providerState === "cancelling"}
                    aria-label={`Cancel, ${pane} pane`}
                  >
                    <svg className="ic ic-lg" viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="6" y="6" width="12" height="12" rx="1" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="send"
                    onClick={() => void send()}
                    disabled={
                      !draft.trim() || !worktree || !providerReady || runActive || !historyRestored
                    }
                    aria-label={`${threadId ? "Send" : "Start"} conversation, ${pane} pane`}
                  >
                    <svg
                      className="ic ic-lg"
                      viewBox="0 0 24 24"
                      style={{ strokeWidth: 2 }}
                      aria-hidden="true"
                    >
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* File browser and preview stay inside .conv; the selector guarantees
          only one workspace destination is visible at a time. */}
          {repository && (activePanel === "preview" || previewFloating || agentBrowserViewOpen) && (
            <OptionalControlBoundary
              label="Preview"
              onDismiss={dismissPreview}
              onPendingChange={onPreviewPendingChange}
              fallback={
                <WorkspacePanelPendingFallback
                  destination="preview"
                  pane={pane}
                  floating={previewFloating}
                  observation={agentBrowserViewOpen ? latestAgentBrowserObservation : null}
                  onClose={closePreview}
                />
              }
            >
              <PreviewPanel
                key={`${repository.root}:${repository.selectedWorktree}`}
                repository={repository}
                pane={pane}
                active={activePanel === "preview" || previewFloating || agentBrowserViewOpen}
                floating={previewFloating}
                conversationId={conversation?.id ?? threadId}
                agentObservation={agentBrowserViewOpen ? latestAgentBrowserObservation : null}
                onClose={closePreview}
                onToggleFloating={togglePreviewFloating}
                onReference={(reference) =>
                  setElementReferences((current) => [...current.slice(-2), reference])
                }
                onStatusChange={updatePreviewStatus}
              />
            </OptionalControlBoundary>
          )}
          {activePanel === "files" && repository && (
            <OptionalControlBoundary
              label="Files"
              onDismiss={() => closeWorkspacePanel("files")}
              onPendingChange={onFilesPendingChange}
              fallback={
                <WorkspacePanelPendingFallback
                  destination="files"
                  pane={pane}
                  onClose={() => closeWorkspacePanel("files")}
                />
              }
            >
              <FileBrowserPanel
                repository={repository}
                pane={pane}
                attached={attachments}
                maxAttachments={100}
                onAttach={(path) => {
                  if (!attachments.includes(path) && contextPins.length < 100) {
                    setAttachments((current) => [...current, path]);
                    setContextError(null);
                  }
                }}
                onClose={() => closeWorkspacePanel("files")}
              />
            </OptionalControlBoundary>
          )}
        </div>
        {activePanel === "changes" && repository && (
          <aside className="rv review-dock" aria-label={`Review changes, ${pane} pane`}>
            <OptionalControlBoundary
              label="Changes"
              onDismiss={() => closeWorkspacePanel("changes")}
              onPendingChange={onChangesPendingChange}
              fallback={
                <WorkspacePanelPendingFallback
                  destination="changes"
                  pane={pane}
                  onClose={() => closeWorkspacePanel("changes")}
                />
              }
            >
              <ChangesPanel
                repository={repository}
                threadId={threadId}
                pane={pane}
                files={turnChangesReview?.files ?? changes}
                loading={turnChangesReview ? false : changesLoading}
                error={turnChangesReview ? null : changesError}
                onClose={() => closeWorkspacePanel("changes")}
                onRefresh={onRefreshChanges}
                canSendRevision={historyRestored && !runActive && providerReady}
                mode={changesMode}
                onModeChange={(mode) => dispatchWorkspacePanel({ type: "set_changes_mode", mode })}
                checkpointId={turnChangesReview?.checkpointId ?? null}
                readOnly={turnChangesReview !== null}
                panelTitle={turnChangesReview ? "Turn changes" : "Changes"}
                onSendRevision={(prompt) => {
                  closeWorkspacePanel("changes", false);
                  void send(prompt);
                }}
              />
            </OptionalControlBoundary>
          </aside>
        )}
        {planOpen &&
          ((planPanelMode === "graph" && (workGraph.hasPlan || workGraph.hasObservedActivity)) ||
            (planPanelMode === "plan" && panelPlan)) && (
            <aside
              id={`${pane}-provider-plan-panel`}
              className="provider-plan-panel"
              aria-label={`${planPanelMode === "graph" ? "Work graph" : "Latest plan"}, ${pane} pane`}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setPlanOpen(false);
                (planPanelMode === "graph" ? workGraphTriggerRef : planTriggerRef).current?.focus();
              }}
            >
              <header>
                {planPanelMode === "graph" ? (
                  <div>
                    <small>Work Graph · Beta</small>
                    <h2>{workGraph.title}</h2>
                  </div>
                ) : panelPlan ? (
                  <div>
                    <small>
                      {providerDisplayName(
                        panelPlan.provider,
                        providers.find((item) => item.id === panelPlan.provider),
                      )}
                    </small>
                    <h2>{panelPlan.title?.trim() || "Plan"}</h2>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  autoFocus
                  onClick={() => {
                    setPlanOpen(false);
                    (planPanelMode === "graph"
                      ? workGraphTriggerRef
                      : planTriggerRef
                    ).current?.focus();
                  }}
                  aria-label={
                    planPanelMode === "graph"
                      ? `Close work graph, ${pane} pane`
                      : `Close plan panel, ${pane} pane`
                  }
                >
                  ×
                </button>
              </header>
              <div className="provider-plan-panel-body">
                {planPanelMode === "graph" ? (
                  <WorkGraphContent graph={workGraph} />
                ) : panelPlan ? (
                  <ProviderPlanContent plan={panelPlan} />
                ) : null}
              </div>
              {planPanelMode === "plan" && panelPlan && (
                <footer>
                  <ProviderPlanActions plan={panelPlan} />
                </footer>
              )}
            </aside>
          )}
        {contextOpen && (
          <ContextPackagePanel
            receipt={draftContextReceipt}
            pins={contextPins}
            busy={contextPackageBusy}
            error={contextError}
            onAdd={(pin) => {
              if (contextPins.some((item) => item.kind === pin.kind && item.path === pin.path))
                return;
              if (contextPins.length >= 100) {
                setContextError("Pin at most 100 file or folder paths.");
                return;
              }
              if (!isRepositoryRelativeContextPinPath(pin.path)) {
                setContextError("Use a repository-relative path inside the selected worktree.");
                return;
              }
              if (pin.kind === "file") setAttachments((current) => [...current, pin.path]);
              else setFolderPins((current) => [...current, pin.path]);
            }}
            onRemove={(pin) => {
              if (pin.kind === "file") {
                setAttachments((current) => current.filter((path) => path !== pin.path));
              } else {
                setFolderPins((current) => current.filter((path) => path !== pin.path));
              }
            }}
            onClose={() => setContextOpen(false)}
          />
        )}
        {workspaceDialogOpen && !conversation && repository && (
          <OptionalControlBoundary
            label="Conversation workspace"
            onDismiss={() => setWorkspaceDialogOpen(false)}
            pendingDialog
          >
            <ConversationWorkspaceDialog
              repository={repository}
              conversationId={conversationId}
              onClose={() => setWorkspaceDialogOpen(false)}
              onUseCurrentWorkspace={() => {
                setPreparedWorkspaceRepository(null);
                setWorkspaceApprovalPending(false);
                setWorkspaceMode("shared");
                setWorkspaceDialogOpen(false);
              }}
              onCreated={(next) => {
                setPreparedWorkspaceRepository(next);
                onRepositoryChanged?.(next);
                setWorkspaceDialogOpen(false);
                setWorkspaceApprovalPending(true);
              }}
            />
          </OptionalControlBoundary>
        )}
      </div>
      <>
        {forkOpen && threadId && !managedMode && repository && (
          <OptionalControlBoundary
            label="Conversation fork"
            onDismiss={() => setForkOpen(false)}
            pendingDialog
          >
            <ForkConversationDialog
              sourceThreadId={threadId}
              sourceProvider={provider}
              sourceWorkspaceMode={conversation?.workspaceMode ?? "shared"}
              repository={repository}
              profiles={profiles}
              providers={providers}
              onClose={() => setForkOpen(false)}
              onRepositoryChanged={onRepositoryChanged}
              onCreated={(id) => {
                setForkOpen(false);
                onConversationAvailable?.(id);
              }}
            />
          </OptionalControlBoundary>
        )}
      </>
      {releaseWorktreeOpen && threadId && (
        <OptionalControlBoundary
          label="Release worktree"
          onDismiss={() => setReleaseWorktreeOpen(false)}
          pendingDialog
        >
          <ReleaseWorktreeDialog
            title={conversation?.title?.trim() || "This conversation"}
            provider={providerListLabel(provider)}
            worktree={worktree?.path ?? conversation?.worktree}
            settle
            onClose={() => setReleaseWorktreeOpen(false)}
            onConfirm={async () => {
              await lifecycleControl.settleAndRelease(threadId);
              setCompletionDismissed(true);
            }}
          />
        </OptionalControlBoundary>
      )}
    </div>
  );
}
