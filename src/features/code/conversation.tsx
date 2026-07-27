import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
import {
  cycleReasoningEffort,
  parseProviderFailure,
  providerAvatarInitials,
  providerChipName as formatProviderChipName,
  providerDisplayName,
  providerListLabel,
  providerModelLabel,
  providerModelOptions,
  providerNotReadyMessage,
  providerReasoningEfforts,
} from "../../lib/provider-readiness";
import { joinAssistantTextChunks } from "../../lib/assistant-text";
import { presentToolRows, shortToolCallId } from "../../lib/tool-presentation";
import { MarkdownBody } from "../../components/markdown-body";
import { formatElapsed } from "./conversation-list";

export function Conversation({
  repository,
  conversation,
  pane,
  active,
  onOpenBeside,
  showOpenBeside = true,
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
  /** Hide primary topbar Open beside when a secondary pane is already open. */
  showOpenBeside?: boolean;
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
  const [messages, setMessages] = useState<Array<{ text: string; mode: InteractionMode; createdAt?: string }>>([]);
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
  const claudeProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider === "claude-code" || !profile.provider),
    [profiles],
  );
  const defaultClaudeProfileId = claudeProfiles.find((profile) => profile.id === "default:claude-code")?.id
    ?? claudeProfiles[0]?.id
    ?? "";
  const [model, setModel] = useState("default");
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const lastAttentionState = useRef<string | null>(null);
  // Seed from the bound thread so reopen never flashes Claude readiness for Codex/Grok.
  const [provider, setProvider] = useState<ProviderId>(
    () => conversation?.provider ?? "claude-code",
  );
  const [providers, setProviders] = useState<ProviderDiscovery[]>([]);
  /** False until first /api/providers/discover settles — avoids “Install CLI” flash. */
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  useEffect(() => {
    const loadProviders = () => {
      void fetch("/api/providers/discover", { method: "POST" })
        .then((response) => response.json())
        .then((body: { providers?: ProviderDiscovery[] }) => setProviders(body.providers ?? []))
        .catch(() => setProviders([{ id: "claude-code", installed: true }]))
        .finally(() => setProvidersLoaded(true));
    };
    loadProviders();
    window.addEventListener("aldunis:adapters-changed", loadProviders);
    return () => window.removeEventListener("aldunis:adapters-changed", loadProviders);
  }, []);
  const codex = providers.find((item) => item.id === "codex-cli");
  const shikigamiProvider = providers.find((item) => item.id === "shikigami");
  const selectedProvider = providers.find((item) => item.id === provider);
  const providerName = providerDisplayName(provider, selectedProvider);
  /** Short role label in the transcript (Claude / Codex / Grok Build / …). */
  const providerLabel = providerListLabel(provider);
  /** Compact composer chip text — adapters use presentation names, not raw ids. */
  const providerChipName = formatProviderChipName(provider, selectedProvider);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  /** Ignore option activation that rides the same gesture that opened the menu. */
  const providerMenuOpenedAtRef = useRef(0);
  const modelMenuOpenedAtRef = useRef(0);
  const modeMenuOpenedAtRef = useRef(0);
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
    const list: ProviderId[] = [];
    const claude = providers.find((item) => item.id === "claude-code");
    // Keep Claude selectable when installed; empty profiles disable send, not the choice.
    if (!claude || claude.installed !== false) list.push("claude-code");
    if (codex?.installed) list.push("codex-cli");
    if (shikigamiProvider?.installed) list.push("shikigami");
    for (const item of providers) {
      if (
        typeof item.id === "string"
        && item.id.startsWith("adapter:")
        && item.installed !== false
        && item.enabled !== false
      ) {
        list.push(item.id);
      }
    }
    return list;
  }, [codex?.installed, shikigamiProvider?.installed, providers]);
  /**
   * New conversations only, before a thread/run is created. Once threadId or
   * runId exists the provider is fixed (cross-provider moves use fork).
   * No automatic fallback effect — that races profile loading and can steal
   * the Claude default mid-flight.
   */
  const canSwitchProvider = conversation === null
    && !threadId
    && !runId
    && availableProviders.length > 1;
  const applyProviderDefaults = (next: ProviderId) => {
    if (next === "claude-code") {
      setProfileId((current) => current || defaultClaudeProfileId);
      setModel("default");
      setReasoningEffort("medium");
      return;
    }
    if (next === "codex-cli") {
      const defaultModel = codex?.models?.find((entry) => entry.isDefault)?.id
        ?? codex?.models?.[0]?.id
        ?? "default";
      setModel(defaultModel);
      const match = codex?.models?.find((entry) => entry.id === defaultModel);
      setReasoningEffort(match?.defaultReasoningEffort ?? "medium");
      return;
    }
    if (next === "shikigami") {
      const defaultModel = shikigamiProvider?.models?.find((entry) => entry.isDefault)?.id
        ?? shikigamiProvider?.models?.[0]?.id
        ?? "default";
      setModel(defaultModel);
      setReasoningEffort("medium");
      return;
    }
    // Declarative ACP adapters (Kiro, Grok, OpenCode, …) — use discovered models.
    const discovery = providers.find((item) => item.id === next);
    const defaultModel = discovery?.models?.find((entry) => entry.isDefault)?.id
      ?? discovery?.models?.[0]?.id
      ?? "default";
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
    if (source === "menu" && performance.now() < providerMenuOpenedAtRef.current) {
      return;
    }
    if (!canSwitchProvider) {
      setProviderMenuOpen(false);
      return;
    }
    if (next !== provider) {
      setProvider(next);
      applyProviderDefaults(next);
    }
    setProviderMenuOpen(false);
    setModelMenuOpen(false);
    setModeMenuOpen(false);
  };
  const selectModel = (nextModel: string, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && performance.now() < modelMenuOpenedAtRef.current) {
      return;
    }
    if (nextModel !== model) {
      setModel(nextModel);
      if (provider === "codex-cli" && nextModel !== "default") {
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
    setModelMenuOpen(false);
  };
  const selectMode = (nextMode: InteractionMode, source: "menu" | "keyboard" = "menu") => {
    if (source === "menu" && performance.now() < modeMenuOpenedAtRef.current) {
      return;
    }
    if (nextMode !== mode) setMode(nextMode);
    setModeMenuOpen(false);
  };
  const closeComposerMenus = () => {
    setProviderMenuOpen(false);
    setModelMenuOpen(false);
    setModeMenuOpen(false);
  };
  const openModeMenu = () => {
    setProviderMenuOpen(false);
    setModelMenuOpen(false);
    setModeMenuOpen((open) => {
      if (open) return false;
      modeMenuOpenedAtRef.current = performance.now() + 200;
      return true;
    });
  };
  const modelOptions = providerModelOptions(provider, selectedProvider);
  useEffect(() => {
    if (!providerMenuOpen) return;
    const optionButtons = () => Array.from(
      providerMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-provider-option]") ?? [],
    );
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && providerMenuRef.current?.contains(target)) return;
      // Prevent the outside click from also activating a chip beneath the menu.
      event.preventDefault();
      setProviderMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProviderMenuOpen(false);
        return;
      }
      const options = optionButtons();
      if (options.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = options.findIndex((button) => button === active);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0
          ? (delta > 0 ? 0 : options.length - 1)
          : (index + delta + options.length) % options.length;
        options[next]?.focus();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        options[0]?.focus();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        options[options.length - 1]?.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        const id = options[index]?.dataset.providerId as ProviderId | undefined;
        if (id) selectProvider(id, "keyboard");
      }
    };
    // Attach after the opening gesture finishes so the open click cannot select.
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [providerMenuOpen, canSwitchProvider, provider]);
  useEffect(() => {
    if (!modelMenuOpen) return;
    const optionButtons = () => Array.from(
      modelMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-model-option]") ?? [],
    );
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && modelMenuRef.current?.contains(target)) return;
      event.preventDefault();
      setModelMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setModelMenuOpen(false);
        return;
      }
      const options = optionButtons();
      if (options.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = options.findIndex((button) => button === active);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0
          ? (delta > 0 ? 0 : options.length - 1)
          : (index + delta + options.length) % options.length;
        options[next]?.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        const id = options[index]?.dataset.modelId;
        if (id) selectModel(id, "keyboard");
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modelMenuOpen, model, provider, selectedProvider, reasoningEffort]);
  useEffect(() => {
    if (!modeMenuOpen) return;
    const optionButtons = () => Array.from(
      modeMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-mode-option]") ?? [],
    );
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && modeMenuRef.current?.contains(target)) return;
      event.preventDefault();
      setModeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setModeMenuOpen(false);
        return;
      }
      const options = optionButtons();
      if (options.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const index = options.findIndex((button) => button === active);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = index < 0
          ? (delta > 0 ? 0 : options.length - 1)
          : (index + delta + options.length) % options.length;
        options[next]?.focus();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        const id = options[index]?.dataset.modeId as InteractionMode | undefined;
        if (id === "ask" || id === "plan" || id === "build") selectMode(id, "keyboard");
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [modeMenuOpen, mode]);
  useEffect(() => {
    if (!canSwitchProvider) setProviderMenuOpen(false);
  }, [canSwitchProvider]);
  useEffect(() => {
    if (!claudeProfiles.some((profile) => profile.id === profileId)) {
      setProfileId(defaultClaudeProfileId);
    }
  }, [claudeProfiles, defaultClaudeProfileId, profileId]);
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
  /** Hides the post-turn settle prompt until the next completed turn. */
  const [completionDismissed, setCompletionDismissed] = useState(false);
  useEffect(() => {
    setSessionId(null);
    setHistoryRestored(conversation === null);
    setHistoryRestoreError(null);
    setThreadId(conversation?.id ?? null);
    // Prefer the summary provider immediately so crumb/empty state match the thread
    // while /api/state/load is in flight (avoids Claude-not-ready flash on reopen).
    if (conversation?.provider && conversation.provider !== provider) {
      setProvider(conversation.provider);
      return;
    }
    setCheckpoint(null);
    setCompletionDismissed(false);
    setRewindPreview(null);
    setMessages([]);
    setProviderEvents([]);
    setProviderState("idle");
    setRunId(null);
  }, [conversation?.id, conversation?.provider, repository?.projectId, repository?.selectedWorktree, provider]);
  useEffect(() => {
    if (providerState !== "completed" && providerState !== "cancelled") {
      setCompletionDismissed(false);
    }
  }, [providerState]);
  useEffect(() => {
    if (!repository?.projectId) return;
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
        activities?: Array<{
          turnId: string;
          kind: "tool_started" | "tool_finished" | "provider_failed";
          toolCallId: string | null;
          name: string | null;
          failed: boolean | null;
          message: string | null;
          createdAt: string;
        }>;
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
        createdAt: message.createdAt,
      })));
      // Keep whitespace-only assistant chunks (e.g. "\n\n" from ACP streams).
      // Dropping them via trim() glued "shikigami" + "There" into unreadable text.
      const assistantEvents: ProviderEvent[] = history
        .filter((message) => message.role === "assistant" && message.text.length > 0)
        .map((message) => ({
          kind: "assistant_text" as const,
          text: message.text,
        }));
      // Rehydrate tool runs and provider failures from activity rows. Without
      // this, reopening a failed turn only shows the user prompt.
      const activityEvents: ProviderEvent[] = (projection.activities ?? [])
        .filter((activity) => turnIds.has(activity.turnId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .flatMap((activity): ProviderEvent[] => {
          if (activity.kind === "provider_failed") {
            // Scope default copy with the thread provider so dual-pane failures
            // are not both "Provider failed."
            const fallback = `${providerDisplayName(provider, selectedProvider)} failed.`;
            return [{
              kind: "failed",
              message: activity.message?.trim() || fallback,
            }];
          }
          if (activity.kind === "tool_started" && activity.toolCallId) {
            return [{
              kind: "tool_started",
              toolCallId: activity.toolCallId,
              name: activity.name?.trim() || "Tool",
            }];
          }
          if (activity.kind === "tool_finished" && activity.toolCallId) {
            return [{
              kind: "tool_finished",
              toolCallId: activity.toolCallId,
              failed: activity.failed === true,
            }];
          }
          return [];
        });
      setProviderEvents([...assistantEvents, ...activityEvents]);
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
  const canPickModel = !runActive && modelOptions.length > 0;
  const canPickMode = !runActive;
  useEffect(() => {
    if (!canPickModel) setModelMenuOpen(false);
  }, [canPickModel]);
  useEffect(() => {
    if (!canPickMode) setModeMenuOpen(false);
  }, [canPickMode]);
  /** Whether the selected provider can start a run right now. */
  const providerReady = !providersLoaded
    ? false
    : provider === "claude-code"
    ? Boolean(profileId)
    : provider === "codex-cli"
      ? Boolean(codex?.installed && codex.authenticated)
      : provider === "shikigami"
      ? Boolean(shikigamiProvider?.installed && shikigamiProvider.authenticated)
      : Boolean(
        selectedProvider
        && selectedProvider.installed !== false
        && selectedProvider.enabled !== false
        && selectedProvider.authenticated !== false,
      );
  const providerReadinessMessage = !providersLoaded
    ? "Checking provider…"
    : providerReady
    ? ""
    : providerNotReadyMessage(provider, selectedProvider, {
      hasClaudeProfile: Boolean(profileId),
      providerName,
    });
  const modelChipLabel = providerModelLabel(provider, model, selectedProvider);
  const reasoningEfforts = providerReasoningEfforts(provider, model, selectedProvider);
  const showReasoningEffort = (
    (provider === "codex-cli" && model !== "default")
    || (typeof provider === "string" && provider.startsWith("adapter:") && model !== "default")
  ) && reasoningEfforts.length > 0;
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
      || !providerReady
      || runActive
      || !historyRestored
    ) return;
    const turnMode = mode;
    setMessages((current) => [...current, { text: value, mode: turnMode, createdAt: new Date().toISOString() }]);
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
          profileId: provider === "claude-code" ? profileId : null,
          model,
          provider,
          reasoningEffort: (
            (provider === "codex-cli" || (typeof provider === "string" && provider.startsWith("adapter:")))
            && model !== "default"
          )
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
  const assistantText = joinAssistantTextChunks(
    providerEvents
      .filter((event): event is Extract<ProviderEvent, { kind: "assistant_text" }> => event.kind === "assistant_text")
      .map((event) => event.text),
  );
  const toolEvents = providerEvents.filter((event) => event.kind === "tool_started" || event.kind === "tool_finished");
  const approvals = providerEvents.filter(
    (event): event is Extract<ProviderEvent, { kind: "approval_pending" }> => event.kind === "approval_pending",
  );
  const failure = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "failed" }> => event.kind === "failed")
    .at(-1);
  const failureView = failure ? parseProviderFailure(failure.message) : null;
  const hasAssistantContent = Boolean(assistantText.trim())
    || toolEvents.length > 0
    || approvals.length > 0
    || failure != null;
  // Avoid empty assistant shells after restore (header-only with no body).
  // runActive covers starting/streaming/waiting_for_approval/cancelling.
  const showAssistantTurn = hasAssistantContent
    || runActive
    || (providerState === "completed" && Boolean(threadId))
    || providerState === "failed"
    || providerState === "cancelled"
    || Boolean(failureView);
  const conversationEmpty = messages.length === 0
    && !showAssistantTurn
    && providerState === "idle"
    && !draft.trim();
  const conversationWorktreeMissing = Boolean(
    conversation?.worktree
    && repository
    && !repository.worktrees.some((item) => item.path === conversation.worktree),
  );
  const accessLabel = mode === "ask" ? "Read-only" : mode === "plan" ? "Plan only" : "Worktree write";
  const emptyState = !repository
    ? {
        title: "Open a repository to begin",
        detail: "Choose an explicit local root before starting a provider conversation.",
        action: <Button variant="primary" size="lg" onClick={onOpenRepository}>Open repository</Button>,
      }
    : conversationWorktreeMissing
      ? {
          title: "Worktree is not available",
          detail: `This conversation is bound to ${conversation?.worktree}, which is not among the discovered worktrees for the open repository. Switch project or recreate the worktree before sending.`,
          action: <Button variant="primary" size="lg" onClick={onManageWorktrees}>Manage worktrees</Button>,
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
          detail: providerReadinessMessage || `Finish setup for ${providerName}, then return here.`,
          action: provider === "claude-code"
            ? <Button variant="primary" size="lg" onClick={onOpenProfiles}>Configure Claude</Button>
            : null,
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
    cancelled: `${providerLabel} cancelled · send another prompt to resume`,
    failed: `${providerLabel} stopped · send another prompt to resume`,
  };
  const accessScope = {
    label: accessLabel,
    warning: mode !== "ask",
    detail: modeCopy[mode].authority,
  };

  return (
    <div
      className="conv-root"
      aria-label={`${pane === "primary" ? "Primary" : "Secondary"} conversation: ${conversation?.title ?? "New conversation"}`}
    >
      <div className="topbar">
        <div className="crumb">
          <b>{conversation?.title ?? "New conversation"}</b>
          {worktree && <> · {conversationBranch}</>}
          {repository && <> · {providerListLabel(provider)}</>}
          {model !== "default" && <> · {modelChipLabel}</>}
          {showReasoningEffort && <> · {reasoningEffort}</>}
        </div>
        <div className="tb-r">
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${filesOpen ? "on" : ""}`}
            onClick={() => {
              // Grid control is the worktree file browser. Fall back to add-project
              // only when nothing is open yet (first-run / empty workbench).
              if (!repository) {
                onOpenRepository();
                return;
              }
              // Toggle browse; exclusive with preview overlay and the review dock
              // (stacked dual-pane left browse + review fighting for ~100–200px).
              if (filesOpen) onHideFiles();
              else {
                setPreviewOpen(false);
                onHideChanges();
                onBrowseFiles();
              }
            }}
            title={repository ? "Browse worktree files" : "Open a project"}
            aria-label={
              repository
                ? `Browse files, ${pane} pane`
                : `Open project, ${pane} pane`
            }
            aria-pressed={repository ? filesOpen : undefined}
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
            </svg>
            {repository ? "Browse" : "Project"}
          </button>
          <span className="cdiv" aria-hidden="true" />
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${changesOpen ? "on" : ""}`}
            onClick={() => {
              // Toggle review; exclusive with browse/preview overlays so stacked
              // dual-pane does not keep both a full-column overlay and the dock.
              if (changesOpen) onHideChanges();
              else {
                onHideFiles();
                setPreviewOpen(false);
                onShowChanges();
              }
            }}
            disabled={!repository}
            title="Review panel"
            aria-label={`${changes.length} changes, ${pane} pane`}
            aria-pressed={changesOpen}
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M15 3v18" />
            </svg>
            {changes.length} changes
          </button>
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${previewOpen ? "on" : ""}`}
            onClick={() => {
              // Toggle preview; exclusive with browse overlay and review dock.
              if (previewOpen) setPreviewOpen(false);
              else {
                onHideFiles();
                onHideChanges();
                setPreviewOpen(true);
              }
            }}
            disabled={!repository}
            title="Preview panel"
            aria-label={`Preview, ${pane} pane`}
            aria-pressed={previewOpen}
          >
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 15h18" />
            </svg>
          </button>
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
          {threadId && (
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
          )
          : null}
        {messages.map((message, index) => (
          <div className="turn user" key={`${message.text}-${index}`}>
            <div className="role">
              <span className="av you">Y</span>
              <span className="rname">You</span>
              <span className="rtime">{message.createdAt ? formatElapsed(message.createdAt) : "now"}</span>
            </div>
            <p>{message.text}</p>
          </div>
        ))}
        {showAssistantTurn && (
          <div className="turn" aria-live="polite">
            <div className="role">
              <span className="av">{providerAvatarInitials(provider, providerLabel)}</span>
              <span className="rname">{providerLabel}</span>
              <span className="rtime">
                {runActive
                  ? "now"
                  : conversation?.updatedAt
                    ? formatElapsed(conversation.updatedAt)
                    : "now"}
              </span>
            </div>
              {(providerState === "starting" || providerState === "streaming" || providerState === "waiting_for_approval" || providerState === "cancelling") && (
                <div className="thinking"><span /><span>{stateCopy[providerState]}</span></div>
              )}
              {assistantText && <MarkdownBody text={assistantText} className="turn-md" />}
              {toolEvents.length > 0 && (
                <div className="tools" role="list" aria-label={`${providerLabel} tool activity`}>
                  {presentToolRows(toolEvents).map((row) => {
                    const statusLabel = row.status === "running"
                      ? "Running"
                      : row.status === "failed"
                        ? "Failed"
                        : "Done";
                    const shortId = shortToolCallId(row.toolCallId);
                    return (
                      <div
                        className={`tool tool-${row.status}`}
                        role="listitem"
                        key={row.toolCallId}
                        aria-label={`${statusLabel} ${row.name} ${shortId}`}
                      >
                        <span aria-hidden="true">
                          {row.status === "running" ? "Run" : row.status === "failed" ? "Failed" : "Done"}
                        </span>
                        <code aria-hidden="true">{row.name}</code>
                        <span className="r" title={row.toolCallId} aria-hidden="true">{shortId}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {providerState === "completed" && threadId && !completionDismissed && (
                <div className="done" role="status">
                  <div className="h">
                    <span className="pill completed"><span className="dot" />Completed</span>
                    <span className="ttl">Nothing left to do here</span>
                  </div>
                  <p>
                    Worktree <code>{worktree?.path ?? conversation?.worktree}</code> is still checked out. Settling keeps the worktree.
                  </p>
                  <div className="acts">
                    <button
                      type="button"
                      className="btn btn-default btn-sm"
                      aria-label={`Settle thread, ${pane} pane`}
                      onClick={() => {
                        void (async () => {
                          const response = await fetch("/api/state/conversations/settle", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ threadId }),
                          });
                          if (!response.ok) return;
                          setCompletionDismissed(true);
                          // Refresh sidebar so the thread moves into Settled.
                          onConversationAvailable?.(threadId);
                        })().catch(() => undefined);
                      }}
                    >
                      Settle thread
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      aria-label={`Settle and release worktree, ${pane} pane`}
                      onClick={() => {
                        const settleLabel = [
                          conversation?.title?.trim() || "this conversation",
                          providerListLabel(provider),
                        ].join(" · ");
                        if (!window.confirm(
                          `Settle and release the managed worktree for "${settleLabel}"? The conversation is kept.`,
                        )) return;
                        void (async () => {
                          const settle = await fetch("/api/state/conversations/settle", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ threadId }),
                          });
                          if (!settle.ok) return;
                          const release = await fetch("/api/state/conversations/release-worktree", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ threadId, confirm: true }),
                          });
                          if (!release.ok) return;
                          setCompletionDismissed(true);
                          onConversationAvailable?.(threadId);
                        })().catch(() => undefined);
                      }}
                    >
                      Settle and release worktree
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
                    <div><dt>Provider</dt><dd>{providerListLabel(approval.provider)}</dd></div>
                  </dl>
                  <p>{approval.scope.target}</p>
                  {approval.scope.details.length > 0 && (
                    <ul>{approval.scope.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  )}
                  <small className="approval-binding">
                    {location.host} · {pane} pane · conversation {approval.conversationId.slice(0, 8)} · {approval.repository} · {approval.worktree} · {providerListLabel(approval.provider)} · direct · {approval.toolName} · {approval.scope.target}
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
              {failureView && (
                <div className={`provider-error ${failureView.kind === "park" ? "provider-error-park" : ""}`} role="alert">
                  <p>
                    {/^provider failed\.?$/i.test(failureView.summary.trim())
                      ? `${providerName} failed.`
                      : failureView.summary}
                  </p>
                  {failureView.question && (
                    <p className="provider-error-question">Question: {failureView.question}</p>
                  )}
                  {failureView.resumeCommand && (
                    <div className="provider-error-resume">
                      <code>{failureView.resumeCommand}</code>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        aria-label={`Copy CLI resume command: ${failureView.resumeCommand}`}
                        onClick={() => {
                          void navigator.clipboard?.writeText(failureView.resumeCommand!).catch(() => undefined);
                        }}
                      >
                        Copy CLI resume
                      </button>
                    </div>
                  )}
                  {failureView.kind === "park" && (
                    <p className="provider-error-hint">
                      Park answers are not wired in the workbench yet. Resume from a terminal with the command above.
                    </p>
                  )}
                </div>
              )}
              {(providerState === "completed" || providerState === "cancelled" || providerState === "failed")
                && <p className="provider-state">{stateCopy[providerState]}</p>}
              {checkpoint && (
                <section className={`checkpoint-card ${checkpoint.state}`} aria-label={`Workspace checkpoint, ${pane} pane: ${checkpoint.state}`}>
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
                      <p>This restores the turn baseline. Only these files will be affected:</p>
                      <ul>
                        {rewindPreview.files.map((file) => (
                          <li key={`${file.path}-${file.previousPath ?? ""}`}>
                            <span>{file.state}</span> {file.previousPath ? `${file.previousPath} → ` : ""}{file.path}
                          </li>
                        ))}
                      </ul>
                      <footer>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => setRewindPreview(null)}
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
            <div
              className="composer-suggestions"
              role="listbox"
              aria-label={suggestionMode === "files" ? "File suggestions" : "Command suggestions"}
            >
              {suggestions.map((suggestion, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === suggestionIndex}
                  aria-label={`${suggestion.value}: ${suggestion.detail}`}
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
              !historyRestored
                ? "Restoring conversation session…"
                : conversationWorktreeMissing
                ? "Conversation worktree is not available for the open repository…"
                : !providerReady
                ? providerReadinessMessage
                : worktree
                ? `Reply to ${providerName}…`
                : "Open a repository with an available worktree…"
            }
            id={`${pane}-composer`}
            name={`${pane}-composer`}
            aria-label={`Message ${providerName}`}
            disabled={
              !worktree
              || !providerReady
              || runActive
              || !historyRestored
            }
          />
          {!providerReady && historyRestored && providersLoaded && (
            <div className="context-error" role="status">{providerReadinessMessage}</div>
          )}
          {contextError && <div className="context-error" role="alert">{contextError}</div>}
          {historyRestoreError && <div className="context-error" role="alert">{historyRestoreError}</div>}
          <div className="crow">
            <div className="composer-provider" ref={providerMenuRef}>
              <button
                type="button"
                className="cc"
                disabled={runActive}
                aria-haspopup={canSwitchProvider ? "listbox" : undefined}
                aria-expanded={canSwitchProvider ? providerMenuOpen : undefined}
                title={
                  !providersLoaded
                    ? "Checking provider…"
                    : !providerReady
                    ? providerReadinessMessage
                    : canSwitchProvider
                    ? "Open the provider menu. Alt-click opens provider profiles."
                    : conversation
                      ? "Provider is fixed for this conversation. Use Fork in the top bar to change providers. Click opens provider profiles."
                      : "Open provider profiles"
                }
                aria-label={
                  !providersLoaded
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
                  // Alt/Option-click always opens provider profile admin.
                  if (event.altKey || !canSwitchProvider) {
                    closeComposerMenus();
                    onOpenProfiles();
                    return;
                  }
                  setModelMenuOpen(false);
                  setModeMenuOpen(false);
                  setProviderMenuOpen((open) => {
                    if (open) return false;
                    // Block accidental option activation from the open gesture.
                    providerMenuOpenedAtRef.current = performance.now() + 200;
                    return true;
                  });
                }}
              >
                <span className="pv" aria-hidden="true">
                  {providerAvatarInitials(provider, providerLabel)}
                </span>
                {providerChipName}
                <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
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
                    const ready = id === "claude-code"
                      ? Boolean(profileId)
                      : id === "codex-cli"
                      ? Boolean(codex?.installed && codex.authenticated)
                      : id === "shikigami"
                      ? Boolean(shikigamiProvider?.installed && shikigamiProvider.authenticated)
                      : Boolean(
                        discovery
                        && discovery.installed !== false
                        && discovery.enabled !== false
                        && discovery.authenticated !== false,
                      );
                    const status = ready
                      ? (selected ? "selected" : "ready")
                      : (discovery?.detail?.trim()
                        || providerNotReadyMessage(id, discovery, {
                          hasClaudeProfile: Boolean(profileId),
                          providerName: label,
                        }));
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
                        <span className="p">{chip} · {status}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-label="Provider profiles: Manage binaries and env for each provider"
                    className="composer-provider-option add"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setProviderMenuOpen(false);
                      onOpenProfiles();
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
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                title={
                  showReasoningEffort
                    ? "Open the model menu. Alt-click cycles Codex reasoning effort."
                    : "Open the model menu"
                }
                aria-label={
                  showReasoningEffort
                    ? `Model ${modelChipLabel}, effort ${reasoningEffort}. Open menu to choose a model; Alt-click cycles effort.`
                    : `Model ${modelChipLabel}. Open menu to choose a model.`
                }
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!canPickModel) return;
                  if (showReasoningEffort && event.altKey) {
                    setReasoningEffort((current) => cycleReasoningEffort(
                      provider,
                      model,
                      current,
                      selectedProvider,
                    ));
                    return;
                  }
                  setProviderMenuOpen(false);
                  setModeMenuOpen(false);
                  setModelMenuOpen((open) => {
                    if (open) return false;
                    modelMenuOpenedAtRef.current = performance.now() + 200;
                    return true;
                  });
                }}
              >
                {showReasoningEffort
                  ? `${modelChipLabel} · ${reasoningEffort}`
                  : modelChipLabel}
                <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {modelMenuOpen && canPickModel && (
                <div
                  className="composer-provider-menu"
                  role="listbox"
                  aria-label="Choose model"
                >
                  {modelOptions.map((option) => {
                    const selected = option.id === model;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-label={`${option.displayName}: ${option.id}${selected ? ", selected" : ""}`}
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
                        <span className="p">{option.id}{selected ? " · selected" : ""}</span>
                      </button>
                    );
                  })}
                  {showReasoningEffort && (
                    <>
                      <div className="composer-menu-section" role="presentation">Reasoning effort</div>
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
                              if (performance.now() < modelMenuOpenedAtRef.current) return;
                              setReasoningEffort(effort);
                              setModelMenuOpen(false);
                            }}
                          >
                            <span className="n">{effort}</span>
                            <span className="p">{selected ? "selected" : "Codex reasoning"}</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
            <span className="cdiv" />
            <div className="composer-provider composer-mode-group" ref={modeMenuRef}>
              {/* Single control: mode + tool scope. Dual Access/Mode chips both
                  opened the same menu and "Access Read-only" read like privacy. */}
              <button
                type="button"
                className={`cc ${accessScope.warning ? "scoped" : ""}`}
                disabled={!canPickMode}
                aria-haspopup="listbox"
                aria-expanded={modeMenuOpen}
                aria-controls={modeMenuOpen ? "composer-mode-menu" : undefined}
                title={`${modeCopy[mode].label} · ${accessScope.detail}`}
                aria-label={`Mode ${modeCopy[mode].label}, tool scope ${accessScope.label}. ${accessScope.detail}. Opens the mode menu.`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
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
                <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>
              {modeMenuOpen && canPickMode && (
                <div
                  id="composer-mode-menu"
                  className="composer-provider-menu"
                  role="listbox"
                  aria-label="Choose interaction mode"
                >
                  {INTERACTION_MODES.map((item) => {
                    const selected = item === mode;
                    const scopeLabel = item === "ask" ? "Read-only" : item === "plan" ? "Plan only" : "Worktree write";
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
                        <span className="n">{modeCopy[item].label} · {scopeLabel}</span>
                        <span className="p">{modeCopy[item].authority}{selected ? " · selected" : ""}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {runId
              ? (
                <button type="button" className="send" onClick={() => void cancel()} disabled={providerState === "cancelling"} aria-label={`Cancel, ${pane} pane`}>
                  <svg className="ic ic-lg" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                </button>
              )
              : (
                <button
                  type="button"
                  className="send"
                  onClick={() => void send()}
                  disabled={!draft.trim() || !worktree || !providerReady || runActive || !historyRestored}
                  aria-label={`Send message, ${pane} pane`}
                >
                  <svg className="ic ic-lg" viewBox="0 0 24 24" style={{ strokeWidth: 2 }} aria-hidden="true">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
          </div>
        </div>
      </div>
      {/* File browser / preview stay inside .conv so the review dock remains
          visible and usable when both panels are open. */}
      {previewOpen && repository && (
        <PreviewPanel
          repository={repository}
          pane={pane}
          onClose={() => setPreviewOpen(false)}
          onReference={(reference) => setElementReferences((current) => [...current.slice(-2), reference])}
        />
      )}
      {filesOpen && repository && (
        <FileBrowserPanel
          repository={repository}
          pane={pane}
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
      {changesOpen && repository && (
        <aside className="rv review-dock" aria-label={`Review changes, ${pane} pane`}>
          <ChangesPanel
            repository={repository}
            threadId={threadId}
            pane={pane}
            files={changes}
            loading={changesLoading}
            error={changesError}
            onClose={onHideChanges}
            onRefresh={onRefreshChanges}
            canSendRevision={historyRestored && !runActive && providerReady}
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
    </div>
  );
}


