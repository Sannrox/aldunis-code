import React, { FormEvent, useEffect, useRef, useState } from "react";
import type {
  RepositoryMetadata, ConversationSummary, ClaudeProfile, ProviderId, ProviderDiscovery,
  ProviderCapabilities, ProviderState, ProviderEvent, InteractionMode, ReasoningEffort,
  ChangedFile, TurnCheckpoint, CheckpointFile, ApprovalState, ElementReference,
} from "../../types";
import { Button, CloseButton } from "../../components/ui";
import { Icon } from "../../components/icon";
import { ChangesPanel } from "../changes/changes-panel";
import { FileBrowserPanel } from "../files/file-browser-panel";
import { PreviewPanel } from "../preview/preview-panel";
import { ForkConversationDialog } from "../dialogs/fork-conversation-dialog";
import { DESIGN_MOCK_PRIMARY_ID, DESIGN_MOCK_THREAD } from "./design-mock";

export function Conversation({
  repository,
  conversation,
  pane,
  active,
  onOpenBeside,
  onClosePane,
  onConversationAvailable,
  onOpenRepository,
  onManageWorktrees,
  changes,
  changesLoading,
  changesError,
  changesOpen,
  onShowChanges,
  onHideChanges,
  onRefreshChanges,
  filesOpen,
  onBrowseFiles,
  onHideFiles,
  profiles,
  onOpenProfiles,
}: {
  repository: RepositoryMetadata | null;
  conversation: ConversationSummary | null;
  pane: "primary" | "secondary";
  active: boolean;
  onOpenBeside: () => void;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  onOpenRepository: () => void;
  onManageWorktrees: () => void;
  changes: ChangedFile[];
  changesLoading: boolean;
  changesError: string | null;
  changesOpen: boolean;
  onShowChanges: () => void;
  onHideChanges: () => void;
  onRefreshChanges: () => void;
  filesOpen: boolean;
  onBrowseFiles: () => void;
  onHideFiles: () => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Array<{ text: string; mode: InteractionMode }>>([]);
  const [mode, setMode] = useState<InteractionMode>("ask");
  const [providerEvents, setProviderEvents] = useState<ProviderEvent[]>([]);
  const [providerState, setProviderState] = useState<ProviderState>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [historyRestored, setHistoryRestored] = useState(() => conversation === null);
  const [historyRestoreError, setHistoryRestoreError] = useState<string | null>(null);
  const [conversationId] = useState(() => conversation?.id ?? crypto.randomUUID());
  const [threadId, setThreadId] = useState<string | null>(conversation?.id ?? null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Array<{ value: string; detail: string }>>([]);
  const [suggestionMode, setSuggestionMode] = useState<"files" | "commands" | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [contextError, setContextError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("default");
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const lastAttentionState = useRef<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [providers, setProviders] = useState<ProviderDiscovery[]>([]);
  const [forkOpen, setForkOpen] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  useEffect(() => {
    const loadProviders = () => {
      void fetch("/api/providers/discover", { method: "POST" })
        .then((response) => response.json())
        .then((body: { providers?: ProviderDiscovery[] }) => setProviders(body.providers ?? []))
        .catch(() => setProviders([{ id: "claude-code", installed: true }]));
    };
    loadProviders();
    window.addEventListener("aldunis:adapters-changed", loadProviders);
    return () => window.removeEventListener("aldunis:adapters-changed", loadProviders);
  }, []);
  const codex = providers.find((item) => item.id === "codex-cli");
  const selectedProvider = providers.find((item) => item.id === provider);
  const selectedCodexModel = codex?.models?.find((item) => item.id === model);
  const providerName = provider === "codex-cli"
    ? "Codex CLI"
    : provider === "claude-code"
    ? "Claude Code"
    : selectedProvider?.name ?? "Provider adapter unavailable";
  const providerLabel = provider === "codex-cli" ? "Codex" : provider === "claude-code" ? "Claude" : providerName;
  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) {
      setProfileId(profiles[0]?.id ?? "");
    }
  }, [profiles, profileId]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [elementReferences, setElementReferences] = useState<ElementReference[]>([]);
  const [checkpoint, setCheckpoint] = useState<TurnCheckpoint | null>(null);
  const [rewindPreview, setRewindPreview] = useState<{
    currentIdentity: string;
    currentIndexIdentity: string;
    files: CheckpointFile[];
  } | null>(null);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(null);
    setHistoryRestored(conversation === null);
    setHistoryRestoreError(null);
    setThreadId(conversation?.id ?? null);
    setCheckpoint(null);
    setRewindPreview(null);
    setMessages([]);
    setProviderEvents([]);
    setProviderState("idle");
    setRunId(null);
  }, [conversation?.id, repository?.projectId, repository?.selectedWorktree, provider]);
  useEffect(() => {
    if (!repository?.projectId) return;
    // Design mock fixtures: no server history.
    if (conversation?.id?.startsWith("mock-")) {
      if (conversation.id === DESIGN_MOCK_PRIMARY_ID) {
        setMessages([{ text: DESIGN_MOCK_THREAD.user, mode: "build" }]);
        setProviderEvents([{ kind: "assistant_text", text: DESIGN_MOCK_THREAD.assistant }]);
        setProviderState("completed");
        setModel(DESIGN_MOCK_THREAD.model);
        setMode("build");
        setThreadId(conversation.id);
      }
      setHistoryRestored(true);
      return;
    }
    let active = true;
    let timer: number | undefined;
    const restore = async () => {
      const response = await fetch("/api/state/load", { method: "POST" });
      if (!active) return;
      if (!response.ok) throw new Error("Conversation history could not be restored.");
      const projection = await response.json() as {
        threads: Array<{
          id: string;
          projectId: string;
          worktree: string;
          provider?: ProviderId;
          profileId?: string | null;
          model?: string | null;
          updatedAt: string;
        }>;
        turns: Array<{
          id: string;
          threadId: string;
          status: "active" | "idle" | "waiting_for_user" | "waiting_for_approval" | "completed" | "failed" | "interrupted" | "running" | "cancelled";
          mode?: InteractionMode;
          providerRunId?: string;
          createdAt: string;
        }>;
        messages: Array<{ turnId: string; role: "user" | "assistant"; text: string; createdAt: string }>;
        providerSessions: Array<{ threadId: string; provider?: ProviderId; sessionId: string }>;
      };
      const thread = conversation
        ? projection.threads.find((item) => (
            item.id === conversation.id
            && item.projectId === repository.projectId
            && item.worktree === repository.selectedWorktree
          ))
        : null;
      if (!thread) {
        setHistoryRestored(true);
        return;
      }
      const threadProvider = thread.provider ?? "claude-code";
      if (threadProvider !== provider) {
        setProvider(threadProvider);
        return;
      }
      if (thread.profileId) setProfileId(thread.profileId);
      if (thread.model) setModel(thread.model);
      const turns = projection.turns
        .filter((item) => item.threadId === thread.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const latest = turns.at(-1);
      if (!latest) {
        setHistoryRestored(true);
        return;
      }
      setThreadId(thread.id);
      setSessionId(projection.providerSessions.find((item) => (
        item.threadId === thread.id
        && (item.provider ?? "claude-code") === provider
      ))?.sessionId ?? null);
      setRunId(
        latest.providerRunId && (
          latest.status === "active"
          || latest.status === "running"
          || latest.status === "waiting_for_approval"
        )
          ? latest.providerRunId
          : null,
      );
      const turnIds = new Set(turns.map((turn) => turn.id));
      const history = projection.messages
        .filter((message) => turnIds.has(message.turnId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      setMessages(history.filter((message) => message.role === "user").map((message) => ({
        text: message.text,
        mode: turns.find((turn) => turn.id === message.turnId)?.mode ?? "ask",
      })));
      setProviderEvents(history.filter((message) => message.role === "assistant").map((message) => ({
        kind: "assistant_text" as const,
        text: message.text,
      })));
      const nextState: ProviderState = latest.status === "active" || latest.status === "running"
        ? "streaming"
        : latest.status === "waiting_for_approval"
          ? "waiting_for_approval"
          : latest.status === "interrupted" || latest.status === "cancelled"
            ? "cancelled"
            : latest.status === "failed"
              ? "failed"
              : latest.status === "completed"
                ? "completed"
                : "idle";
      setProviderState(nextState);
      if (latest.providerRunId && latest.status === "waiting_for_approval") {
        const approvalsResponse = await fetch("/api/provider/approvals/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: latest.providerRunId }),
        });
        if (approvalsResponse.ok) {
          const body = await approvalsResponse.json() as {
            approvals: Array<Extract<ProviderEvent, { kind: "approval_pending" }>>;
          };
          setProviderEvents((current) => [
            ...current.filter((event) => event.kind !== "approval_pending"),
            ...body.approvals.map(({ kind: _kind, ...approval }) => ({
              kind: "approval_pending" as const,
              ...approval,
            })),
          ]);
        }
      }
      if (
        notificationsEnabled
        && document.visibilityState !== "visible"
        && lastAttentionState.current !== latest.status
        && ["waiting_for_approval", "completed", "failed", "interrupted"].includes(latest.status)
      ) {
        new Notification("Aldunis Code needs attention", {
          body: latest.status === "waiting_for_approval"
            ? "A local action is waiting for your decision."
            : "A background turn changed state.",
        });
      }
      lastAttentionState.current = latest.status;
      setHistoryRestored(true);
      setHistoryRestoreError(null);
      if (
        latest.status === "active"
        || latest.status === "running"
        || latest.status === "waiting_for_approval"
      ) {
        timer = window.setTimeout(() => attempt(), 10_000);
      }
    };
    const attempt = () => {
      void restore().catch(() => {
        if (!active) return;
        setHistoryRestoreError("Conversation history could not be restored. Retrying locally…");
        timer = window.setTimeout(attempt, 5_000);
      });
    };
    attempt();
    const visible = () => { if (document.visibilityState === "visible") attempt(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [conversation?.id, notificationsEnabled, provider, repository?.projectId, repository?.selectedWorktree]);
  useEffect(() => {
    void fetch("/api/provider/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async (response) => {
      if (response.ok) setCapabilities(await response.json() as ProviderCapabilities);
    });
  }, []);
  const worktree = repository?.worktrees.find((item) => (
    item.path === repository.selectedWorktree
    && (item.state === "available" || item.state === "detached")
  )) ?? null;
  const conversationBranch = worktree?.branch ?? "Detached HEAD";
  const runActive = providerState === "starting"
    || providerState === "streaming"
    || providerState === "waiting_for_approval"
    || providerState === "cancelling";
  const modeCopy: Record<InteractionMode, { label: string; authority: string }> = {
    ask: { label: "Ask", authority: "Read-only tools" },
    plan: { label: "Plan", authority: "Planning; mutations blocked" },
    build: { label: "Build", authority: "Mutations require approval" },
  };
  useEffect(() => {
    const token = draft.slice(0, draft.length).match(/(?:^|\s)([@/])([^\s]*)$/);
    if (!token || !worktree || !repository) {
      setSuggestionMode(null);
      setSuggestions([]);
      return;
    }
    const [, prefix, query] = token;
    setSuggestionIndex(0);
    if (prefix === "/") {
      setSuggestionMode("commands");
      setSuggestions((capabilities?.commands ?? [])
        .filter((command) => command.name.slice(1).includes(query.toLocaleLowerCase()))
        .map((command) => ({ value: command.name, detail: command.description })));
      return;
    }
    setSuggestionMode("files");
    const controller = new AbortController();
    void fetch("/api/context/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: repository.root, worktree: worktree.path, query }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { files?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository files could not be searched.");
      setSuggestions((body.files ?? []).map((path) => ({ value: path, detail: "Local repository file" })));
    }).catch((error) => {
      if (error instanceof Error && error.name !== "AbortError") setContextError(error.message);
    });
    return () => controller.abort();
  }, [capabilities, draft, repository, worktree]);
  const selectSuggestion = (value: string) => {
    if (suggestionMode === "files") {
      if (!attachments.includes(value)) {
        if (attachments.length >= (capabilities?.attachments.maxCount ?? 8)) {
          setContextError(`Attach at most ${capabilities?.attachments.maxCount ?? 8} files.`);
          return;
        }
        setAttachments((current) => [...current, value]);
      }
      setDraft((current) => current.replace(/(?:^|\s)@[^\s]*$/, (match) => match.startsWith(" ") ? " " : ""));
    } else {
      setDraft((current) => current.replace(/(?:^|\s)\/[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}${value} `));
    }
    setContextError(null);
    setSuggestionMode(null);
    setSuggestions([]);
  };
  const send = async (promptOverride?: string) => {
    const value = (promptOverride ?? draft).trim();
    if (
      !value
      || !repository
      || !worktree
      || (provider === "claude-code" && !profileId)
      || runActive
      || !historyRestored
    ) return;
    const turnMode = mode;
    setMessages((current) => [...current, { text: value, mode: turnMode }]);
    if (promptOverride === undefined) setDraft("");
    const sentAttachments = promptOverride === undefined ? attachments : [];
    if (promptOverride === undefined) setAttachments([]);
    const sentElementReferences = promptOverride === undefined ? elementReferences : [];
    if (promptOverride === undefined) setElementReferences([]);
    setProviderEvents([]);
    setProviderState("starting");
    setRunId(null);
    setCheckpoint(null);
    setRewindPreview(null);
    setCheckpointError(null);
    let activeTurnId: string | null = null;
    let createdThreadId: string | null = null;
    try {
      const response = await fetch("/api/provider/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktree.path,
          prompt: value,
          mode: turnMode,
          conversationId,
          projectId: repository.projectId,
          threadId: threadId ?? undefined,
          resumeSessionId: sessionId ?? undefined,
          attachments: sentAttachments,
          profileId,
          model,
          provider,
          reasoningEffort: provider === "codex-cli" && model !== "default"
            ? reasoningEffort
            : undefined,
          elementReferences: sentElementReferences.map(({ screenshot: _screenshot, ...reference }) => reference),
        }),
      });
      createdThreadId = response.headers.get("x-thread-id");
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? `${providerName} could not start.`);
      }
      const activeRunId = response.headers.get("x-provider-run-id");
      setRunId(activeRunId);
      setThreadId(createdThreadId);
      activeTurnId = response.headers.get("x-turn-id");
      setProviderState("streaming");
      if (!response.body) throw new Error(`${providerName} returned no event stream.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = JSON.parse(line) as ProviderEvent;
            if (event.kind === "approval_resolved") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.id === event.id
                  ? { ...candidate, state: event.state }
                  : candidate
              )));
              newline = buffer.indexOf("\n");
              continue;
            }
            setProviderEvents((current) => [...current, event]);
            if (event.kind === "session_started" || event.kind === "turn_completed") setSessionId(event.sessionId);
            if (event.kind === "turn_completed") setProviderState("completed");
            if (event.kind === "cancelled") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.state === "pending"
                  ? { ...candidate, state: "cancelled" }
                  : candidate
              )));
              setProviderState("cancelled");
            }
            if (event.kind === "failed") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.state === "pending"
                  ? { ...candidate, state: "provider_failed" }
                  : candidate
              )));
              setProviderState("failed");
            }
          }
          newline = buffer.indexOf("\n");
        }
        if (result.done) break;
      }
      if (activeTurnId) {
        const stateResponse = await fetch("/api/state/load", { method: "POST" });
        if (stateResponse.ok) {
          const projection = await stateResponse.json() as { checkpoints?: TurnCheckpoint[] };
          setCheckpoint(projection.checkpoints?.find((item) => item.turnId === activeTurnId) ?? null);
        }
      }
    } catch (error) {
      if (promptOverride === undefined) {
        setAttachments(sentAttachments);
        setElementReferences(sentElementReferences);
      }
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : `${providerName} failed.`,
      }]);
      setProviderState("failed");
    } finally {
      setRunId(null);
      const availableThreadId = createdThreadId ?? conversation?.id;
      if (availableThreadId) onConversationAvailable?.(availableThreadId);
    }
  };
  const previewRewind = async () => {
    if (!checkpoint || !repository || !worktree) return;
    setCheckpointBusy(true);
    setCheckpointError(null);
    try {
      const response = await fetch(`/api/checkpoints/${checkpoint.id}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: worktree.path }),
      });
      const body = await response.json() as {
        currentIdentity?: string;
        currentIndexIdentity?: string;
        files?: CheckpointFile[];
        error?: string;
      };
      if (!response.ok || !body.currentIdentity || !body.currentIndexIdentity || !body.files) {
        throw new Error(body.error ?? "The rewind preview could not be prepared.");
      }
      setRewindPreview({
        currentIdentity: body.currentIdentity,
        currentIndexIdentity: body.currentIndexIdentity,
        files: body.files,
      });
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "The rewind preview failed.");
    } finally {
      setCheckpointBusy(false);
    }
  };
  const confirmRewind = async () => {
    if (!checkpoint || !rewindPreview || !repository || !worktree) return;
    setCheckpointBusy(true);
    setCheckpointError(null);
    try {
      const response = await fetch(`/api/checkpoints/${checkpoint.id}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktree.path,
          currentIdentity: rewindPreview.currentIdentity,
          currentIndexIdentity: rewindPreview.currentIndexIdentity,
          confirm: true,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The workspace could not be rewound.");
      setCheckpoint({ ...checkpoint, state: "superseded", message: "Workspace rewound to the turn baseline." });
      setRewindPreview(null);
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "The workspace rewind failed.");
    } finally {
      setCheckpointBusy(false);
    }
  };
  const cancel = async () => {
    if (!runId) return;
    setProviderState("cancelling");
    try {
      const response = await fetch(`/api/provider/runs/${runId}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("The provider run could not be cancelled.");
    } catch (error) {
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : "Cancellation failed.",
      }]);
      setProviderState("failed");
    }
  };
  const decideApproval = async (
    approval: Extract<ProviderEvent, { kind: "approval_pending" }>,
    decision: "allow_once" | "deny",
  ) => {
    try {
      const response = await fetch(`/api/provider/approvals/${approval.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: approval.runId,
          conversationId: approval.conversationId,
          repository: approval.repository,
          worktree: approval.worktree,
          toolCallId: approval.toolCallId,
          decision,
        }),
      });
      const body = await response.json() as typeof approval | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Approval decision failed.");
      setProviderEvents((current) => current.map((event) => (
        event.kind === "approval_pending" && event.id === approval.id
          ? { ...event, state: (body as typeof approval).state }
          : event
      )));
    } catch (error) {
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : "Approval decision failed.",
      }]);
    }
  };
  const assistantText = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "assistant_text" }> => event.kind === "assistant_text")
    .map((event) => event.text)
    .join("\n");
  const toolEvents = providerEvents.filter((event) => event.kind === "tool_started" || event.kind === "tool_finished");
  const approvals = providerEvents.filter(
    (event): event is Extract<ProviderEvent, { kind: "approval_pending" }> => event.kind === "approval_pending",
  );
  const failure = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "failed" }> => event.kind === "failed")
    .at(-1);
  const conversationEmpty = messages.length === 0
    && providerEvents.length === 0
    && providerState === "idle";
  const emptyState = !repository
    ? {
        title: "Open a repository to begin",
        detail: "Choose an explicit local root before starting a provider conversation.",
        action: <Button variant="primary" size="lg" onClick={onOpenRepository}>Open repository</Button>,
      }
    : provider === "claude-code" && !profileId
      ? {
          title: "Configure Claude Code to begin",
          detail: "Add a local Claude profile, then return here to describe the task.",
          action: <Button variant="primary" size="lg" onClick={onOpenProfiles}>Configure Claude</Button>,
        }
      : {
          title: "What do you want to work on?",
          detail: "Describe the outcome in the composer. Aldunis Code will keep the conversation bound to this worktree.",
          action: null,
        };
  const stateCopy: Record<ProviderState, string> = {
    idle: repository ? "Ready" : "Open a repository to start",
    starting: `Starting ${providerName}…`,
    streaming: `${providerName} is working…`,
    waiting_for_approval: "Waiting for your approval…",
    cancelling: "Cancelling…",
    completed: "Turn completed",
    cancelled: "Turn cancelled · send another prompt to resume",
    failed: "Provider stopped · send another prompt to resume",
  };
  const accessScope = mode === "ask"
    ? { label: "Read-only", warning: false }
    : mode === "plan"
      ? { label: "Plan only", warning: true }
      : { label: "Build · approve mutations", warning: true };

  return (
    <div
      className="conv-root"
      aria-label={`${pane === "primary" ? "Primary" : "Secondary"} conversation: ${conversation?.title ?? "New conversation"}`}
    >
      <div className="topbar">
        <div className="crumb">
          <b>{conversation?.title ?? "New conversation"}</b>
          {worktree && <> · {conversationBranch}</>}
          {repository && <> · {providerName.toLocaleLowerCase().replace(/\s+/g, "-")}</>}
          {model !== "default" && <> · {model}</>}
        </div>
        <div className="tb-r">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenRepository}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
            </svg>
            Open
          </button>
          <span className="cdiv" aria-hidden="true" />
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${changesOpen ? "on" : ""}`}
            onClick={onShowChanges}
            disabled={!repository}
            title="Review panel"
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3v18" />
            </svg>
            {conversation?.id === DESIGN_MOCK_PRIMARY_ID ? 6 : changes.length} changes
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPreviewOpen(true)}
            disabled={!repository || conversation?.id?.startsWith("mock-")}
            title="Preview panel"
            aria-label="Preview"
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 15h18" />
            </svg>
          </button>
          {onClosePane && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClosePane} aria-label={`Close ${pane} pane`}>×</button>
          )}
        </div>
      </div>
      <div className={`split ${changesOpen ? "with-review" : ""}`}>
      <div className="conv">
      <div className="thread">
        <div className="wrap">
        {conversationEmpty
          ? (
            <section className="conversation-empty sparse" aria-labelledby={`${pane}-empty-title`}>
              <span>New conversation</span>
              <h2 id={`${pane}-empty-title`}>{emptyState.title}</h2>
              <p>{emptyState.detail}</p>
              {emptyState.action}
            </section>
          )
          : null}
        {messages.map((message, index) => (
          <div className="turn user" key={`${message.text}-${index}`}>
            <div className="role">
              <span className="av you">{conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "R" : "Y"}</span>
              <span className="rname">You</span>
              <span className="rtime">{conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "13:10" : "now"}</span>
            </div>
            <p>{message.text}</p>
          </div>
        ))}
        {(providerState !== "idle" || providerEvents.length > 0) && (
          <div className="turn" aria-live="polite">
            <div className="role">
              <span className="av">{provider === "claude-code" ? "CC" : provider === "codex-cli" ? "CX" : "AD"}</span>
              <span className="rname">{providerLabel}</span>
              <span className="rtime">{conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "13:52" : "now"}</span>
            </div>
              {(providerState === "starting" || providerState === "streaming" || providerState === "waiting_for_approval" || providerState === "cancelling") && (
                <div className="thinking"><span /><span>{stateCopy[providerState]}</span></div>
              )}
              {assistantText && <p>{assistantText}</p>}
              {conversation?.id === DESIGN_MOCK_PRIMARY_ID && (
                <div className="tools">
                  {DESIGN_MOCK_THREAD.tools.map((tool) => (
                    <div className="tool" key={tool.code}>
                      <span>{tool.label}</span>
                      <code>{tool.code}</code>
                      <span className="r" style={{ color: "var(--emerald)" }}>{tool.result}</span>
                    </div>
                  ))}
                </div>
              )}
              {toolEvents.length > 0 && conversation?.id !== DESIGN_MOCK_PRIMARY_ID && (
                <div className="tools">
                  {toolEvents.map((event, index) => {
                    const id = event.toolCallId;
                    const label = event.kind === "tool_started"
                      ? event.name
                      : id;
                    const failed = event.kind === "tool_finished" && event.failed;
                    return (
                      <div className="tool" key={`${id}-${event.kind}-${index}`}>
                        <span>{event.kind === "tool_started" ? "Run" : failed ? "Failed" : "Done"}</span>
                        <code>{label}</code>
                        <span className="r">{id.slice(0, 8)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {providerState === "completed" && threadId && (
                <div className="done" role="status">
                  <div className="h">
                    <span className="pill completed"><span className="dot" />Completed</span>
                    <span className="ttl">Nothing left to do here</span>
                  </div>
                  <p>
                    {conversation?.id === DESIGN_MOCK_PRIMARY_ID
                      ? <>{DESIGN_MOCK_THREAD.done.files} · worktree <code>{DESIGN_MOCK_THREAD.done.worktree}</code> is still checked out.</>
                      : <>Worktree <code>{worktree?.path ?? conversation?.worktree}</code> is still checked out. Settling keeps the worktree.</>}
                  </p>
                  <div className="acts">
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      onClick={() => {
                        if (threadId.startsWith("mock-")) return;
                        void fetch("/api/state/conversations/settle", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ threadId }),
                        }).catch(() => undefined);
                      }}
                    >
                      Settle thread
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        if (threadId.startsWith("mock-")) return;
                        if (!window.confirm("Settle and release the managed worktree? The conversation is kept.")) return;
                        void fetch("/api/state/conversations/settle", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ threadId }),
                        }).then(() => fetch("/api/state/conversations/release-worktree", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ threadId, confirm: true }),
                        })).catch(() => undefined);
                      }}
                    >
                      Settle and release worktree
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm">Keep open</button>
                  </div>
                  {conversation?.id === DESIGN_MOCK_PRIMARY_ID && (
                    <p style={{ margin: "10px 0 0", fontSize: 12 }}>
                      Settling keeps the worktree. You&apos;re using{" "}
                      <b style={{ color: "var(--amber)", fontWeight: 500 }}>{DESIGN_MOCK_THREAD.done.meter}</b>.
                    </p>
                  )}
                </div>
              )}
              {approvals.map((approval) => (
                <section className={`approval-card ${approval.state}`} key={approval.id} aria-label={`${pane} pane approval required: ${approval.scope.summary}`}>
                  <header>
                    <span><Icon name="shield" /></span>
                    <div>
                      <strong>{approval.scope.summary}</strong>
                      <small>{approval.toolName} · one action only</small>
                    </div>
                    <em>{approval.state.replace("_", " ")}</em>
                  </header>
                  <dl className="approval-context">
                    <div><dt>Host</dt><dd>{location.host}</dd></div>
                    <div><dt>Repository</dt><dd>{approval.repository}</dd></div>
                    <div><dt>Worktree</dt><dd>{approval.worktree}</dd></div>
                    <div><dt>Provider</dt><dd>{approval.provider}</dd></div>
                  </dl>
                  <p>{approval.scope.target}</p>
                  {approval.scope.details.length > 0 && (
                    <ul>{approval.scope.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  )}
                  <small className="approval-binding">
                    {location.host} · {pane} pane · conversation {approval.conversationId} · {approval.repository} · {approval.worktree} · {approval.provider} · direct · {approval.toolName} · {approval.scope.target}
                  </small>
                  {approval.state === "pending" && (
                    <footer>
                      <button onClick={() => void decideApproval(approval, "deny")}>Deny</button>
                      <Button variant="primary" size="sm" onClick={() => void decideApproval(approval, "allow_once")}>Allow once</Button>
                    </footer>
                  )}
                </section>
              ))}
              {failure && <div className="provider-error" role="alert">{failure.message}</div>}
              {(providerState === "completed" || providerState === "cancelled")
                && !conversation?.id?.startsWith("mock-")
                && <p className="provider-state">{stateCopy[providerState]}</p>}
              {checkpoint && (
                <section className={`checkpoint-card ${checkpoint.state}`} aria-label={`Workspace checkpoint: ${checkpoint.state}`}>
                  <header>
                    <div>
                      <strong>Workspace checkpoint</strong>
                      <small>{checkpoint.state}</small>
                    </div>
                    {checkpoint.state === "completed" && !rewindPreview && (
                      <button onClick={() => void previewRewind()} disabled={checkpointBusy}>
                        {checkpointBusy ? "Inspecting…" : "Preview rewind"}
                      </button>
                    )}
                  </header>
                  {checkpoint.message && <p>{checkpoint.message}</p>}
                  {rewindPreview && (
                    <>
                      <p>This restores the turn baseline. Only these files will be affected:</p>
                      <ul>
                        {rewindPreview.files.map((file) => (
                          <li key={`${file.path}-${file.previousPath ?? ""}`}>
                            <span>{file.state}</span> {file.previousPath ? `${file.previousPath} → ` : ""}{file.path}
                          </li>
                        ))}
                      </ul>
                      <footer>
                        <button onClick={() => setRewindPreview(null)} disabled={checkpointBusy}>Cancel</button>
                        <button className="rewind-confirm" onClick={() => void confirmRewind()} disabled={checkpointBusy}>
                          {checkpointBusy ? "Rechecking…" : "Confirm rewind"}
                        </button>
                      </footer>
                    </>
                  )}
                  {checkpointError && <p className="checkpoint-error" role="alert">{checkpointError}</p>}
                </section>
              )}
          </div>
        )}
        </div>
      </div>
      <div className="cwrap">
        <div className="cbox">
          {elementReferences.length > 0 && (
            <div className="composer-context" aria-label="Attached element context">
              {elementReferences.map((reference, index) => (
                <span key={`${reference.selector}-${index}`}>
                  {reference.tag} · {reference.name ?? reference.selector}
                  <button
                    type="button"
                    onClick={() => setElementReferences((current) => current.filter((_, item) => item !== index))}
                    aria-label={`Remove element reference ${reference.name ?? reference.selector}`}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="context-chips" aria-label="Attached local context">
              {attachments.map((path) => (
                <span key={path}>@{path}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item !== path))} aria-label={`Remove ${path}`}>×</button></span>
              ))}
            </div>
          )}
          {suggestionMode && (
            <div className="composer-suggestions" role="listbox">
              {suggestions.map((suggestion, index) => (
                <button
                  type="button"
                  className={index === suggestionIndex ? "active" : ""}
                  key={suggestion.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSuggestion(suggestion.value)}
                >
                  <strong>{suggestion.value}</strong>
                  <small>{suggestion.detail}</small>
                </button>
              ))}
            </div>
          )}
          {!draft && conversation?.id === DESIGN_MOCK_PRIMARY_ID && (
            <div className="cph" aria-hidden="true">Reply to Claude Code…</div>
          )}
          <textarea
            className="composer-input"
            value={draft}
            spellCheck
            onChange={(event) => setDraft(event.target.value)}
            onPaste={() => setContextError(null)}
            onKeyDown={(event) => {
              if (suggestionMode && suggestions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setSuggestionIndex((current) => (
                  event.key === "ArrowDown"
                    ? (current + 1) % suggestions.length
                    : (current - 1 + suggestions.length) % suggestions.length
                ));
                return;
              }
              if (suggestionMode && suggestions.length > 0 && (event.key === "Tab" || event.key === "Enter")) {
                event.preventDefault();
                selectSuggestion(suggestions[suggestionIndex].value);
                return;
              }
              if (event.key === "Escape" && suggestionMode) {
                event.preventDefault();
                setSuggestionMode(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={
              conversation?.id === DESIGN_MOCK_PRIMARY_ID
                ? ""
                : !historyRestored
                ? "Restoring conversation session…"
                : provider === "claude-code" && !profileId
                ? "Configure a Claude profile first…"
                : worktree
                ? `Reply to ${providerName}…`
                : "Open a repository with an available worktree…"
            }
            aria-label={`Message ${providerName}`}
            disabled={
              conversation?.id?.startsWith("mock-")
              || !worktree
              || (provider === "claude-code" && !profileId)
              || runActive
              || !historyRestored
            }
          />
          {contextError && <div className="context-error" role="alert">{contextError}</div>}
          {historyRestoreError && <div className="context-error" role="alert">{historyRestoreError}</div>}
          <div className="crow">
            <button type="button" className="cc" onClick={onOpenProfiles} disabled={runActive}>
              <span className="pv">{provider === "claude-code" ? "CC" : provider === "codex-cli" ? "CX" : "AD"}</span>
              {conversation?.id === DESIGN_MOCK_PRIMARY_ID
                ? "claude-code · sonnet"
                : `${provider === "claude-code" ? "claude-code" : provider === "codex-cli" ? "codex-cli" : provider}${model !== "default" ? ` · ${model}` : ""}`}
              <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            <button
              type="button"
              className="cc"
              disabled={runActive || conversation?.id?.startsWith("mock-")}
              onClick={() => {
                // Cycle reasoning/default model presentation without inventing UI
                if (provider === "claude-code") {
                  const order = ["default", "sonnet", "opus", "haiku"];
                  const next = order[(order.indexOf(model) + 1) % order.length] ?? "default";
                  setModel(next);
                }
              }}
            >
              {conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "default" : model === "default" ? "default" : model}
              <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            <span className="cdiv" />
            <button
              type="button"
              className={`cc ${accessScope.warning || conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "scoped" : ""}`}
              title={modeCopy[mode].authority}
              onClick={() => {
                if (conversation?.id?.startsWith("mock-")) return;
                const order: InteractionMode[] = ["ask", "plan", "build"];
                setMode(order[(order.indexOf(mode) + 1) % order.length]!);
              }}
            >
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {conversation?.id === DESIGN_MOCK_PRIMARY_ID
                ? "Worktree write"
                : mode === "ask" ? "Read-only" : mode === "plan" ? "Plan only" : "Worktree write"}
              <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            <button
              type="button"
              className="cc"
              disabled={runActive || conversation?.id?.startsWith("mock-")}
              onClick={() => {
                const order: InteractionMode[] = ["ask", "plan", "build"];
                setMode(order[(order.indexOf(mode) + 1) % order.length]!);
              }}
            >
              {conversation?.id === DESIGN_MOCK_PRIMARY_ID ? "Build" : modeCopy[mode].label}
              <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {runId
              ? (
                <button type="button" className="send" onClick={() => void cancel()} disabled={providerState === "cancelling"} aria-label="Cancel">
                  <svg className="ic ic-lg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                </button>
              )
              : (
                <button
                  type="button"
                  className="send"
                  onClick={() => void send()}
                  disabled={!draft.trim() || !worktree || (provider === "claude-code" && !profileId) || runActive || !historyRestored}
                  aria-label="Send message"
                >
                  <svg className="ic ic-lg" viewBox="0 0 24 24" style={{ strokeWidth: 2 }} aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
          </div>
        </div>
      </div>
      </div>
      {changesOpen && repository && (
        <aside className="rv review-dock" aria-label="Review changes">
          <ChangesPanel
            repository={repository}
            threadId={threadId}
            files={changes}
            loading={changesLoading}
            error={changesError}
            onClose={onHideChanges}
            onRefresh={onRefreshChanges}
            canSendRevision={historyRestored && !runActive && (
              provider === "codex-cli"
                ? Boolean(codex?.installed && codex.authenticated)
                : Boolean(profileId)
            )}
            onSendRevision={(prompt) => {
              onHideChanges();
              void send(prompt);
            }}
          />
        </aside>
      )}
      </div>
      {forkOpen && threadId && (
        <ForkConversationDialog
          sourceThreadId={threadId}
          sourceProvider={provider}
          profiles={profiles}
          providers={providers}
          onClose={() => setForkOpen(false)}
          onCreated={(id) => {
            setForkOpen(false);
            onConversationAvailable?.(id);
          }}
        />
      )}
      {previewOpen && repository && (
        <PreviewPanel
          repository={repository}
          onClose={() => setPreviewOpen(false)}
          onReference={(reference) => setElementReferences((current) => [...current.slice(-2), reference])}
        />
      )}
      {filesOpen && repository && (
        <FileBrowserPanel
          repository={repository}
          attached={attachments}
          maxAttachments={capabilities?.attachments.maxCount ?? 8}
          onAttach={(path) => {
            if (!attachments.includes(path) && attachments.length < (capabilities?.attachments.maxCount ?? 8)) {
              setAttachments((current) => [...current, path]);
              setContextError(null);
            }
          }}
          onClose={onHideFiles}
        />
      )}
    </div>
  );
}


