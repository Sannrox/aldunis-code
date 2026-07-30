import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RepositoryMetadata,
  ConversationSummary,
  ClaudeProfile,
  ChangedFile,
  ProviderId,
  DelegatedConversationOutcomeProjection,
  DelegatedConversationRelationship,
} from "../../types";
import { clampSplitPercent, normalizeSplitWorkspaceState } from "../../split-workspace";
import { CodeSidebar, type ProjectFilter } from "./sidebar";
import { PaneConversation } from "./pane-conversation";
import { MissingConversation } from "./missing-conversation";
import {
  branchFromWorktree,
  conversationListFromProjection,
  loadConversationList,
  type ConversationListProjection,
} from "./conversation-list";
import {
  isQuietDelegatedChild,
  summarizeDelegatedOutcomes,
} from "./delegated-outcomes";
import { Icon } from "../../components/icon";
import { Button, CloseButton } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { DomainPage } from "../shell/domain-page";
import type { SavedProject } from "../dialogs/repository-dialog";
import { RenameConversationDialog } from "../dialogs/rename-conversation-dialog";
import {
  DeleteConversationDialog,
  type ConversationDeletionPreview,
} from "../dialogs/delete-conversation-dialog";
import { ReleaseWorktreeDialog } from "../dialogs/release-worktree-dialog";
import { delegatedConversationLabels } from "./delegated-conversation-labels";

/** Pane tab label: title alone collides when dual-pane hosts same-titled forks. */
function paneConversationLabel(
  conversation: ConversationSummary | null | undefined,
  fallback: string,
): string {
  if (!conversation) return fallback;
  const title = conversation.title.trim() || "Conversation";
  if (!conversation.provider) return title;
  return `${title} · ${providerListLabel(conversation.provider)}`;
}


const PROJECT_FILTER_KEY = "aldunis.projectFilter";

function DelegatedChildrenPanel({
  parent,
  conversations,
  relationships,
  outcomes,
  onOpen,
  onChanged,
}: {
  parent: ConversationSummary;
  conversations: ConversationSummary[];
  relationships: DelegatedConversationRelationship[];
  outcomes: DelegatedConversationOutcomeProjection[];
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [selectedChildId, setSelectedChildId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outcomeSummary = summarizeDelegatedOutcomes(parent.id, conversations, relationships);
  const unavailableChildIds = new Set(relationships.map((item) => item.childThreadId));
  const candidates = conversations.filter((item) => (
    item.id !== parent.id
    && !item.archivedAt
    && !unavailableChildIds.has(item.id)
  ));
  const candidateLabels = delegatedConversationLabels(candidates);
  const mutate = async (route: string, childThreadId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentThreadId: parent.id, childThreadId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Delegated conversation update failed.");
      setSelectedChildId("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delegated conversation update failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="delegated-children" aria-labelledby={`delegated-title-${parent.id}`}>
      <div className="delegated-children-header">
        <div>
          <h3 id={`delegated-title-${parent.id}`}>Delegated conversations</h3>
          <p>Quiet status summary. Child messages and provider context stay independent.</p>
          {outcomeSummary.outcomes.length > 0 && (
            <div className="delegated-counts" aria-live="polite" aria-atomic="true">
              <span>{outcomeSummary.running} working</span>
              <span>{outcomeSummary.approvals} approval</span>
              <span>{outcomeSummary.inputs} input</span>
              <span>{outcomeSummary.failures} failed</span>
              <span>{outcomeSummary.completed} completed</span>
            </div>
          )}
        </div>
        <div className="delegated-link-control">
          <label className="sr-only" htmlFor={`delegated-child-${parent.id}`}>
            Existing conversation to link
          </label>
          <select
            id={`delegated-child-${parent.id}`}
            value={selectedChildId}
            disabled={busy || candidates.length === 0}
            onChange={(event) => setSelectedChildId(event.target.value)}
          >
            <option value="">Link existing…</option>
            {candidates.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidateLabels.get(candidate.id)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            disabled={busy || !selectedChildId}
            onClick={() => void mutate(
              "/api/state/delegated-conversations/link",
              selectedChildId,
            )}
          >
            Link
          </Button>
        </div>
      </div>
      {error && <p className="delegated-error" role="alert">{error}</p>}
      {outcomeSummary.outcomes.length === 0 ? (
        <p className="delegated-empty">No delegated conversations linked.</p>
      ) : (
        <ul className="delegated-list">
          {outcomeSummary.outcomes.map(({ relationship, child }) => {
            const status = child.status ?? "idle";
            if (status === "completed") {
              const outcome = outcomes.find((item) => item.childThreadId === child.id);
              return (
                <li key={relationship.id} className="delegated-outcome completed">
                  <details>
                    <summary>
                      <strong>{child.title}</strong>
                      <span>Completed · Review outcome</span>
                    </summary>
                    <div className="delegated-outcome-body">
                      <div className="delegated-summary">
                        <span>{child.projectName ?? "Unknown project"} · {providerListLabel(child.provider)}</span>
                        <span className="delegated-worktree">
                          {branchFromWorktree(child.worktree)} · {child.worktree}
                        </span>
                        <p className="delegated-result">
                          {outcome?.summary ?? "Outcome summary is loading…"}
                        </p>
                      </div>
                      <Button type="button" size="sm" onClick={() => onOpen(child.id)}>
                        Open child
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => void mutate(
                          "/api/state/delegated-conversations/unlink",
                          child.id,
                        )}
                      >
                        Detach
                      </Button>
                    </div>
                  </details>
                </li>
              );
            }
            return (
              <li key={relationship.id} className={`delegated-outcome ${status}`}>
                <div className="delegated-summary">
                  <strong>{child.title}</strong>
                  <span>{child.projectName ?? "Unknown project"} · {providerListLabel(child.provider)}</span>
                  <span className="delegated-worktree">
                    {branchFromWorktree(child.worktree)} · {child.worktree}
                  </span>
                </div>
                <span className={`delegated-status status-${status}`}>
                  {status.replaceAll("_", " ")}
                </span>
                <Button type="button" size="sm" onClick={() => onOpen(child.id)}>
                  Open child
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void mutate(
                    "/api/state/delegated-conversations/unlink",
                    child.id,
                  )}
                >
                  Detach
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function CodeWorkbench({
  product,
  onProductChange,
  productAvailability,
  repository,
  repositoryRestoring = false,
  projects = [],
  onAddProject,
  onSelectProject,
  profiles,
  onOpenProfiles,
  onOpenPalette,
  onSelectWorktree,
  onManageWorktrees,
  onSettings,
  orchestrationThreadsBeta = false,
}: {
  product: import("../../types").Product;
  onProductChange: (product: import("../../types").Product) => void;
  productAvailability?: import("../../lib/product-availability").ProductAvailability;
  repository: RepositoryMetadata | null;
  /** True while boot is reopening the last project — avoid flashing empty inbox. */
  repositoryRestoring?: boolean;
  projects?: SavedProject[];
  /** Opens path picker only when registering a new project (T3 "Add project"). */
  onAddProject: () => void;
  /** Activates a registered project by id — no directory tree. */
  onSelectProject: (projectId: string) => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: (provider?: ProviderId) => void;
  onOpenPalette: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
  onSettings: () => void;
  orchestrationThreadsBeta?: boolean;
}) {
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(() => {
    if (typeof window === "undefined") return "all";
    try {
      return window.localStorage.getItem(PROJECT_FILTER_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [primaryChangesSignal, setPrimaryChangesSignal] = useState(0);
  const [primaryFilesSignal, setPrimaryFilesSignal] = useState(0);
  const [secondaryChangesSignal, setSecondaryChangesSignal] = useState(0);
  const [secondaryFilesSignal, setSecondaryFilesSignal] = useState(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [delegatedRelationships, setDelegatedRelationships] = useState<
    DelegatedConversationRelationship[]
  >([]);
  const [delegatedOutcomes, setDelegatedOutcomes] = useState<
    DelegatedConversationOutcomeProjection[]
  >([]);
  const [showingArchived, setShowingArchived] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    conversation: ConversationSummary;
    preview: ConversationDeletionPreview;
  } | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ConversationSummary | null>(null);
  const [incompleteDeletionIds, setIncompleteDeletionIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryNewKey, setPrimaryNewKey] = useState(0);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitPercent, setSplitPercent] = useState(50);
  const renameReturnFocusReference = useRef<HTMLElement | null>(null);
  const deleteReturnFocusReference = useRef<HTMLElement | null>(null);
  const releaseReturnFocusReference = useRef<HTMLElement | null>(null);
  const [restoreState, setRestoreState] = useState<"idle" | "loading" | "ready" | "failed">(
    () => (repository ? "loading" : "idle"),
  );
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const splitReference = useRef<HTMLDivElement>(null);
  const restoredProjectReference = useRef<string | null>(null);
  /** Last projectId we asked the host to open for the active primary thread (dedupes async switch). */
  const requestedProjectForPrimaryRef = useRef<string | null>(null);
  const primarySelectionReference = useRef("new:0");
  const secondaryIdReference = useRef<string | null>(null);
  const primaryPaneReference = useRef<HTMLDivElement>(null);
  const secondaryPaneReference = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_FILTER_KEY, projectFilter);
    } catch {
      /* ignore */
    }
  }, [projectFilter]);

  // Load the inbox once (and on explicit retry). Do not re-run when the active
  // repository changes — selecting a chat must not reshuffle or reselect.
  useEffect(() => {
    let active = true;
    setRestoreState("loading");
    const restore = async () => {
      const available = await loadConversationList(null);
      if (!active) return;
      setConversations(available);
      const lifecycleResponse = await fetch("/api/state/load", { method: "POST" });
      const lifecycleProjection = await lifecycleResponse.json() as {
        conversationDeletions?: Array<{ threadId: string; status: string }>;
        delegatedOutcomes?: DelegatedConversationOutcomeProjection[];
        delegatedRelationships?: DelegatedConversationRelationship[];
      };
      setDelegatedRelationships(lifecycleProjection.delegatedRelationships ?? []);
      setDelegatedOutcomes(lifecycleProjection.delegatedOutcomes ?? []);
      setIncompleteDeletionIds(
        (lifecycleProjection.conversationDeletions ?? [])
          .filter((deletion) => deletion.status !== "completed")
          .map((deletion) => deletion.threadId),
      );
      // Only apply stored selection on the first successful load.
      if (restoredProjectReference.current === null) {
        const parameters = new URLSearchParams(window.location.search);
        const preferredProjectId = repository?.projectId
          ?? parameters.get("project")
          ?? projects[0]?.id
          ?? null;
        const stored = preferredProjectId
          ? window.localStorage.getItem(`aldunis.split.${preferredProjectId}`)
          : null;
        let saved: { primaryId?: string | null; secondaryId?: string | null; splitPercent?: number } = {};
        try { saved = stored ? JSON.parse(stored) as typeof saved : {}; } catch { saved = {}; }
        const urlConversation = parameters.get("conversation");
        const restored = normalizeSplitWorkspaceState({
          primaryId: urlConversation ?? saved.primaryId,
          secondaryId: parameters.get("beside") ?? saved.secondaryId,
          splitPercent: saved.splitPercent,
        }, available[0]?.id ?? null);
        setPrimaryId(restored.primaryId);
        primarySelectionReference.current = restored.primaryId ?? `new:${primaryNewKey}`;
        setSecondaryId(restored.secondaryId);
        secondaryIdReference.current = restored.secondaryId;
        setSplitPercent(restored.splitPercent);
      }
      restoredProjectReference.current = repository?.projectId ?? "inbox";
      setRestoreState("ready");
    };
    void restore().catch(() => {
      if (!active) return;
      restoredProjectReference.current = null;
      setRestoreState("failed");
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/retry only; repo switches must not reshuffle
  }, [restoreAttempt]);

  // Track the bound project for split persistence without resetting the inbox selection.
  useEffect(() => {
    if (!repository) return;
    restoredProjectReference.current = repository.projectId;
  }, [repository?.projectId]);
  useEffect(() => {
    if (!repository || restoredProjectReference.current !== repository.projectId) return;
    window.localStorage.setItem(`aldunis.split.${repository.projectId}`, JSON.stringify({
      primaryId,
      secondaryId,
      splitPercent,
    }));
    const parameters = new URLSearchParams(window.location.search);
    parameters.set("project", repository.projectId);
    if (primaryId) parameters.set("conversation", primaryId); else parameters.delete("conversation");
    if (secondaryId) parameters.set("beside", secondaryId); else parameters.delete("beside");
    window.history.replaceState(null, "", `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`);
  }, [primaryId, repository?.projectId, secondaryId, splitPercent]);
  useEffect(() => {
    const moveFocus = (event: KeyboardEvent) => {
      if (!secondaryId || !event.altKey || !event.shiftKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActivePane("primary");
        primaryPaneReference.current?.focus();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActivePane("secondary");
        secondaryPaneReference.current?.focus();
      }
    };
    window.addEventListener("keydown", moveFocus);
    return () => window.removeEventListener("keydown", moveFocus);
  }, [secondaryId]);
  const primary = conversations.find((conversation) => conversation.id === primaryId) ?? null;
  const secondary = conversations.find((conversation) => conversation.id === secondaryId) ?? null;
  const quietPrimaryChild = orchestrationThreadsBeta && isQuietDelegatedChild(
    primaryId,
    activePane === "secondary" ? secondaryId : null,
    delegatedRelationships,
  );
  const quietSecondaryChild = orchestrationThreadsBeta && isQuietDelegatedChild(
    secondaryId,
    activePane === "primary" ? primaryId : null,
    delegatedRelationships,
  );
  // Full labels also used as title tooltips when ellipsis truncates narrow dual-pane tabs.
  const paneSwitcherPrimaryLabel = `Primary · ${paneConversationLabel(
    primary,
    primaryId ? "Replace conversation" : "New conversation",
  )}`;
  const paneSwitcherSecondaryLabel = secondaryId
    ? `Secondary · ${paneConversationLabel(
      secondary,
      secondaryId.startsWith("new:") ? "New conversation" : "Replace conversation",
    )}`
    : "";
  const primarySelectionKey = primaryId ?? `new:${primaryNewKey}`;
  const activeConversation = activePane === "secondary" ? secondary : primary;
  const loadDelegatedProjection = async () => {
    const response = await fetch("/api/state/load", { method: "POST" });
    const body = await response.json() as ConversationListProjection & {
      delegatedOutcomes?: DelegatedConversationOutcomeProjection[];
      delegatedRelationships?: DelegatedConversationRelationship[];
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "Delegated conversations could not be loaded.");
    return body;
  };
  const refreshDelegatedRelationships = async () => {
    const body = await loadDelegatedProjection();
    setDelegatedRelationships(body.delegatedRelationships ?? []);
    setDelegatedOutcomes(body.delegatedOutcomes ?? []);
  };
  useEffect(() => {
    if (!orchestrationThreadsBeta) return;
    let active = true;
    const synchronize = () => {
      void loadDelegatedProjection().then((delegated) => {
        if (!active) return;
        setConversations(conversationListFromProjection(delegated));
        setDelegatedRelationships(delegated.delegatedRelationships ?? []);
        setDelegatedOutcomes(delegated.delegatedOutcomes ?? []);
      }).catch(() => undefined);
    };
    synchronize();
    const events = new EventSource("/api/state/events");
    events.addEventListener("open", synchronize);
    events.addEventListener("thread_status", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as {
          threadId?: unknown;
          status?: unknown;
          at?: unknown;
        };
        if (
          typeof update.threadId !== "string"
          || typeof update.status !== "string"
          || typeof update.at !== "string"
        ) return;
        const threadId = update.threadId;
        const status = update.status as ConversationSummary["status"];
        const statusSince = update.at;
        setConversations((current) => current.map((conversation) => (
          conversation.id === threadId
            ? {
              ...conversation,
              status,
              statusSince,
            }
            : conversation
        )));
        if (status === "completed") {
          void refreshDelegatedRelationships().catch(() => undefined);
        }
      } catch {
        /* malformed status events do not replace the last valid projection */
      }
    });
    return () => {
      active = false;
      events.close();
    };
    // The host hides relationships while disabled, so enable performs a fresh load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestrationThreadsBeta]);
  const listedConversations = useMemo(() => {
    const memberIds = projectFilter === "all"
      ? null
      : new Set(
        projects.find((project) => project.id === projectFilter)?.memberIds
          ?? [projectFilter],
      );
    return conversations.filter((conversation) => {
      if (memberIds && !memberIds.has(conversation.projectId)) return false;
      return showingArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt;
    });
  }, [conversations, projectFilter, projects, showingArchived]);
  const worktreeLimit = 10;
  const managedWorktreeCount = repository?.worktrees.filter((wt) => wt.ownership === "aldunis").length ?? 0;
  const postLifecycle = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Conversation lifecycle action failed.");
    setConversations(await loadConversationList(null, { fresh: true }));
    return result;
  };
  const manageConversation = async (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => {
    setLifecycleError(null);
    try {
      if (action === "rename") {
        const active = document.activeElement;
        renameReturnFocusReference.current = active instanceof HTMLElement
          ? active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null
          : null;
        setRenameTarget(conversation);
      } else if (action === "pin") {
        await postLifecycle("/api/state/conversations/pin", {
          threadId: conversation.id,
          pinned: !conversation.pinnedAt,
        });
      } else if (action === "archive" || action === "restore") {
        await postLifecycle(`/api/state/conversations/${action}`, { threadId: conversation.id });
        if (action === "archive") {
          if (primaryId === conversation.id) setPrimaryId(null);
          if (secondaryId === conversation.id) setSecondaryId(null);
        }
      } else {
        const active = document.activeElement;
        deleteReturnFocusReference.current = active instanceof HTMLElement
          ? active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null
          : null;
        const previewResponse = await fetch("/api/state/conversations/delete/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: conversation.id }),
        });
        const preview = await previewResponse.json() as {
          affectedRecords?: Record<string, number>;
          excluded?: string[];
          error?: string;
        };
        if (!previewResponse.ok) throw new Error(preview.error ?? "Deletion preview failed.");
        setDeleteTarget({ conversation, preview });
      }
    } catch (error) {
      setLifecycleError(error instanceof Error ? error.message : "Conversation lifecycle action failed.");
    }
  };
  const worktreeForActive = (() => {
    if (!repository) return null;
    const candidate = activeConversation?.worktree ?? repository.selectedWorktree;
    if (!candidate) return null;
    return repository.worktrees.some((worktree) => worktree.path === candidate)
      ? candidate
      : repository.selectedWorktree;
  })();
  const refresh = async () => {
    if (!repository || !worktreeForActive) {
      setChanges([]);
      return;
    }
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktreeForActive,
        }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch {
      setChanges([]);
    }
  };
  useEffect(() => { void refresh(); }, [worktreeForActive, repository?.root, repository?.selectedWorktree]);
  // URL/local restore can pair a conversation with the wrong open repository.
  // Activate the thread's project so runs/tools bind to the correct root.
  useEffect(() => {
    if (!primaryId || restoreState !== "ready") return;
    const thread = conversations.find((item) => item.id === primaryId);
    if (!thread) {
      requestedProjectForPrimaryRef.current = null;
      return;
    }
    const activeIds = new Set([
      repository?.projectId,
      ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
    ].filter(Boolean) as string[]);
    if (activeIds.has(thread.projectId)) {
      requestedProjectForPrimaryRef.current = thread.projectId;
      return;
    }
    // Dedup: async openRepository does not update projectId immediately.
    if (requestedProjectForPrimaryRef.current === thread.projectId) return;
    requestedProjectForPrimaryRef.current = thread.projectId;
    onSelectProject(thread.projectId);
  }, [conversations, onSelectProject, primaryId, projects, repository?.projectId, restoreState]);
  const repositoryFor = (conversation: ConversationSummary | null) => {
    if (!repository) return null;
    if (!conversation?.worktree) return repository;
    // Never stamp a foreign worktree onto the open root — that causes /api/changes
    // 403s and a disabled composer while project switch is still in flight.
    const known = repository.worktrees.some((worktree) => worktree.path === conversation.worktree);
    if (!known) return repository;
    return {
      ...repository,
      selectedWorktree: conversation.worktree,
      name: conversation.projectName ?? repository.name,
    };
  };
  const openBeside = (id?: string) => {
    // Prefer an explicit id (thread-row Beside). Topbar Open beside should stay in the
    // active project — not open a random foreign-worktree thread that cannot send.
    const sameProjectIds = new Set([
      repository?.projectId,
      ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
      primary?.projectId,
    ].filter(Boolean) as string[]);
    const sameProjectOther = conversations.find((conversation) => (
      conversation.id !== primaryId
      && !conversation.archivedAt
      && !conversation.settledAt
      && (sameProjectIds.size === 0 || sameProjectIds.has(conversation.projectId))
    ));
    const candidate = id
      ?? sameProjectOther?.id
      ?? `new:${crypto.randomUUID()}`;
    secondaryIdReference.current = candidate;
    setSecondaryId(candidate);
    setActivePane("secondary");
  };
  const openConversation = useCallback((id: string) => {
    const thread = conversations.find((item) => item.id === id);
    // Activate the thread's repository for runs/tools, but do not change the
    // project chip filter — inbox "All" must stay on All when clicking a chat.
    if (thread) {
      const activeIds = new Set([
        repository?.projectId,
        ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
      ].filter(Boolean) as string[]);
      if (!activeIds.has(thread.projectId)) {
        onSelectProject(thread.projectId);
      }
    }
    primarySelectionReference.current = id;
    setPrimaryId(id);
    if (secondaryIdReference.current === id) {
      secondaryIdReference.current = null;
      setSecondaryId(null);
    }
    setActivePane("primary");
    // Patch visit locally — do not reload/resort the inbox on every selection.
    const visitedAt = new Date().toISOString();
    setConversations((current) => current.map((item) => (
      item.id === id ? { ...item, lastVisitedAt: visitedAt } : item
    )));
    void fetch("/api/state/conversations/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: id }),
    }).catch(() => undefined);
  }, [conversations, onSelectProject, projects, repository?.projectId]);
  // Thread search lives outside the workbench shell; open hits via shared event.
  useEffect(() => {
    const onOpenFromSearch = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) openConversation(threadId);
    };
    window.addEventListener("aldunis:open-conversation", onOpenFromSearch);
    return () => window.removeEventListener("aldunis:open-conversation", onOpenFromSearch);
  }, [openConversation]);
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = splitReference.current;
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      setSplitPercent(clampSplitPercent(((pointer.clientX - bounds.left) / bounds.width) * 100));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  return (
    <>
      <CodeSidebar
        product={product}
        onProductChange={onProductChange}
        productAvailability={productAvailability}
        repository={repository}
        repositoryRestoring={repositoryRestoring}
        projects={projects}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onAddProject={onAddProject}
        onSelectProject={onSelectProject}
        changes={changes}
        onShowChanges={() => {
          void refresh();
          if (activePane === "secondary") setSecondaryChangesSignal((value) => value + 1);
          else setPrimaryChangesSignal((value) => value + 1);
        }}
        onBrowseFiles={() => (
          activePane === "secondary"
            ? setSecondaryFilesSignal((value) => value + 1)
            : setPrimaryFilesSignal((value) => value + 1)
        )}
        conversations={listedConversations}
        primaryConversationId={primaryId}
        secondaryConversationId={secondaryId}
        onOpenConversation={openConversation}
        onOpenBeside={openBeside}
        onNewConversation={() => {
          // New thread uses the active/filter project for runs — never opens a path tree,
          // and never rewrites the chip filter (especially "All").
          if (projectFilter !== "all") {
            onSelectProject(projectFilter);
          } else if (!repository) {
            if (projects[0]) onSelectProject(projects[0].id);
            else {
              onAddProject();
              return;
            }
          }
          primarySelectionReference.current = `new:${primaryNewKey + 1}`;
          setPrimaryId(null);
          setPrimaryNewKey((value) => value + 1);
          if (secondaryId?.startsWith("new:")) {
            secondaryIdReference.current = null;
            setSecondaryId(null);
          }
          setActivePane("primary");
        }}
        onOpenPalette={onOpenPalette}
        onSelectWorktree={onSelectWorktree}
        onManageWorktrees={onManageWorktrees}
        showingArchived={showingArchived}
        onToggleArchived={() => setShowingArchived((value) => !value)}
        onConversationAction={(conversation, action) => { void manageConversation(conversation, action); }}
        onSettle={(conversation) => {
          void postLifecycle("/api/state/conversations/settle", { threadId: conversation.id })
            .catch((error: unknown) => setLifecycleError(
              error instanceof Error ? error.message : "Settle failed.",
            ));
        }}
        onUnsettle={(conversation) => {
          void postLifecycle("/api/state/conversations/unsettle", { threadId: conversation.id })
            .catch((error: unknown) => setLifecycleError(
              error instanceof Error ? error.message : "Unsettle failed.",
            ));
        }}
        onReleaseWorktree={(conversation) => {
          const active = document.activeElement;
          releaseReturnFocusReference.current = active instanceof HTMLElement ? active : null;
          setReleaseTarget(conversation);
        }}
        worktreeLimit={worktreeLimit}
        managedWorktreeCount={managedWorktreeCount}
        onSettings={onSettings}
      />
      <main className="main">
      {product !== "code" ? (
        <DomainPage product={product as Exclude<import("../../types").Product, "code">} />
      ) : (
      <div className="code-view conversation-workspace" data-active-pane={activePane} aria-label="Conversation workspace">
        {lifecycleError && (
          <div className="workspace-state error" role="alert">
            <span>{lifecycleError}</span>
            <CloseButton
              onClick={() => setLifecycleError(null)}
              label="Dismiss lifecycle error"
            />
          </div>
        )}
        {incompleteDeletionIds.map((threadId) => {
          // Prefer title · provider over a raw UUID in the recovery banner.
          const conversation = conversations.find((item) => item.id === threadId);
          const deletionLabel = conversation
            ? paneConversationLabel(conversation, "conversation")
            : `conversation ${threadId.slice(0, 8)}`;
          return (
          <div className="workspace-state error" role="alert" key={threadId}>
            <span>Deletion of “{deletionLabel}” is incomplete.</span>
            <Button
              type="button"
              size="sm"
              aria-label={`Retry incomplete deletion of ${deletionLabel}`}
              onClick={() => {
                void postLifecycle("/api/state/conversations/delete", { threadId, confirm: true })
                  .then(() => setIncompleteDeletionIds((ids) => ids.filter((id) => id !== threadId)))
                  .catch((error: unknown) => setLifecycleError(
                    error instanceof Error ? error.message : "Conversation deletion retry failed.",
                  ));
              }}
            >
              Retry deletion
            </Button>
          </div>
          );
        })}
        {restoreState === "loading" && <div className="workspace-state" role="status">Restoring local conversations…</div>}
        {restoreState === "failed" && (
          <div className="workspace-state failed" role="alert">
            <span>Local conversation history could not be loaded.</span>
            <Button
              type="button"
              size="sm"
              aria-label="Retry loading local conversation history"
              onClick={() => setRestoreAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {(restoreState === "ready" || !repository) && <>
        {secondaryId && (
          <nav className="pane-switcher" aria-label="Visible conversation pane">
            <button
              type="button"
              className={activePane === "primary" ? "active" : ""}
              aria-current={activePane === "primary" ? "true" : undefined}
              title={paneSwitcherPrimaryLabel}
              onClick={() => setActivePane("primary")}
            >
              {paneSwitcherPrimaryLabel}
            </button>
            <button
              type="button"
              className={activePane === "secondary" ? "active" : ""}
              aria-current={activePane === "secondary" ? "true" : undefined}
              title={paneSwitcherSecondaryLabel}
              onClick={() => setActivePane("secondary")}
            >
              {paneSwitcherSecondaryLabel}
            </button>
          </nav>
        )}
        <div
          className={`split-workspace ${secondaryId ? "split" : ""}`}
          ref={splitReference}
          style={secondaryId ? { gridTemplateColumns: `${splitPercent}% 6px minmax(0, 1fr)` } : undefined}
        >
          <div className="conversation-pane primary-pane" tabIndex={-1} ref={primaryPaneReference} onFocusCapture={() => setActivePane("primary")}>
            {primaryId && !primary
              ? <MissingConversation pane="primary" conversations={conversations.filter((item) => item.id !== secondaryId)} onReplace={(id) => {
                  primarySelectionReference.current = id ?? `new:${primaryNewKey + 1}`;
                  setPrimaryId(id);
                }} />
              : <>
                {orchestrationThreadsBeta && primary && (
                  <DelegatedChildrenPanel
                    parent={primary}
                    conversations={conversations}
                    relationships={delegatedRelationships}
                    outcomes={delegatedOutcomes}
                    onOpen={openConversation}
                    onChanged={refreshDelegatedRelationships}
                  />
                )}
                <PaneConversation key={primaryId ?? `new-primary:${primaryNewKey}`} repository={repositoryFor(primary)} conversation={primary} pane="primary" active={activePane === "primary"} quietDelegatedChild={quietPrimaryChild} profiles={profiles} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} showOpenBeside={!secondaryId} showChangesSignal={primaryChangesSignal} showFilesSignal={primaryFilesSignal} onConversationAvailable={(id) => {
                  if (primarySelectionReference.current === primarySelectionKey) {
                    primarySelectionReference.current = id;
                    setPrimaryId(id);
                  }
                  void loadConversationList(null, { fresh: true }).then(setConversations).catch(() => {});
                }} />
              </>}
          </div>
          {secondaryId && (
            <>
              <div
                className="split-divider"
                role="separator"
                aria-label="Resize conversation panes"
                aria-orientation="vertical"
                aria-valuemin={30}
                aria-valuemax={70}
                aria-valuenow={Math.round(splitPercent)}
                aria-valuetext={`${Math.round(splitPercent)} percent primary width`}
                tabIndex={0}
                onPointerDown={resize}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") setSplitPercent((value) => Math.max(30, value - 5));
                  if (event.key === "ArrowRight") setSplitPercent((value) => Math.min(70, value + 5));
                }}
              />
              <div className="conversation-pane secondary-pane" tabIndex={-1} ref={secondaryPaneReference} onFocusCapture={() => setActivePane("secondary")}>
                {!secondary && !secondaryId.startsWith("new:")
                  ? <MissingConversation pane="secondary" conversations={conversations.filter((item) => item.id !== primaryId)} onReplace={setSecondaryId} onClose={() => setSecondaryId(null)} />
                  : <>
                    {orchestrationThreadsBeta && secondary && (
                      <DelegatedChildrenPanel
                        parent={secondary}
                        conversations={conversations}
                        relationships={delegatedRelationships}
                        outcomes={delegatedOutcomes}
                        onOpen={openConversation}
                        onChanged={refreshDelegatedRelationships}
                      />
                    )}
                    <PaneConversation key={secondaryId} repository={repositoryFor(secondary)} conversation={secondary} pane="secondary" active={activePane === "secondary"} quietDelegatedChild={quietSecondaryChild} profiles={profiles} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} onClosePane={() => {
                      secondaryIdReference.current = null;
                      setSecondaryId(null);
                      setActivePane("primary");
                    }} showChangesSignal={secondaryChangesSignal} showFilesSignal={secondaryFilesSignal} onConversationAvailable={(id) => {
                      if (secondaryIdReference.current !== secondaryId) return;
                      secondaryIdReference.current = id;
                      setSecondaryId(id);
                      void loadConversationList(null, { fresh: true }).then(setConversations).catch(() => {});
                    }} />
                  </>}
              </div>
            </>
          )}
        </div>
        </>}
      </div>
      )}
      </main>
      {renameTarget && (
        <RenameConversationDialog
          conversation={renameTarget}
          onClose={() => {
            setRenameTarget(null);
            const returnFocus = renameReturnFocusReference.current;
            renameReturnFocusReference.current = null;
            window.requestAnimationFrame(() => returnFocus?.focus());
          }}
          onRename={async (title) => {
            await postLifecycle("/api/state/conversations/rename", {
              threadId: renameTarget.id,
              title,
            });
          }}
        />
      )}
      {deleteTarget && (
        <DeleteConversationDialog
          conversation={deleteTarget.conversation}
          preview={deleteTarget.preview}
          onClose={() => {
            setDeleteTarget(null);
            const returnFocus = deleteReturnFocusReference.current;
            deleteReturnFocusReference.current = null;
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => returnFocus?.focus());
            });
          }}
          onDelete={async () => {
            const conversation = deleteTarget.conversation;
            const response = await fetch("/api/state/conversations/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ threadId: conversation.id, confirm: true }),
            });
            const result = await response.json() as { error?: string };
            if (!response.ok) throw new Error(result.error ?? "Conversation deletion failed.");
            if (primaryId === conversation.id) setPrimaryId(null);
            if (secondaryId === conversation.id) setSecondaryId(null);
            setConversations((current) => current.filter((item) => item.id !== conversation.id));
            void loadConversationList(null, { fresh: true })
              .then(setConversations)
              .catch(() => setLifecycleError(
                "Conversation deleted, but the conversation list could not be refreshed.",
              ));
          }}
        />
      )}
      {releaseTarget && (
        <ReleaseWorktreeDialog
          title={releaseTarget.title}
          provider={releaseTarget.provider ? providerListLabel(releaseTarget.provider) : "Unknown provider"}
          worktree={releaseTarget.worktree}
          onClose={() => {
            setReleaseTarget(null);
            const returnFocus = releaseReturnFocusReference.current;
            releaseReturnFocusReference.current = null;
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => returnFocus?.focus()));
          }}
          onConfirm={async () => {
            await postLifecycle("/api/state/conversations/release-worktree", {
              threadId: releaseTarget.id,
              confirm: true,
            });
          }}
        />
      )}
    </>
  );
}
