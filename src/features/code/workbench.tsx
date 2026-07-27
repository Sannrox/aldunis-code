import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RepositoryMetadata, ConversationSummary, ClaudeProfile, ChangedFile, ProviderId } from "../../types";
import { clampSplitPercent, normalizeSplitWorkspaceState } from "../../split-workspace";
import { CodeSidebar, type ProjectFilter } from "./sidebar";
import { PaneConversation } from "./pane-conversation";
import { MissingConversation } from "./missing-conversation";
import { loadConversationList } from "./conversation-list";
import { Icon } from "../../components/icon";
import { DomainPage } from "../shell/domain-page";
import type { SavedProject } from "../dialogs/repository-dialog";

const PROJECT_FILTER_KEY = "aldunis.projectFilter";

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
  onSearch,
  onOpenPalette,
  onSelectWorktree,
  onManageWorktrees,
  onSettings,
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
  onOpenProfiles: () => void;
  onSearch: () => void;
  onOpenPalette: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
  onSettings: () => void;
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
  const [showingArchived, setShowingArchived] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [incompleteDeletionIds, setIncompleteDeletionIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryNewKey, setPrimaryNewKey] = useState(0);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitPercent, setSplitPercent] = useState(50);
  const [restoreState, setRestoreState] = useState<"idle" | "loading" | "ready" | "failed">(
    () => (repository ? "loading" : "idle"),
  );
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const splitReference = useRef<HTMLDivElement>(null);
  const restoredProjectReference = useRef<string | null>(null);
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
      };
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
  const primarySelectionKey = primaryId ?? `new:${primaryNewKey}`;
  const activeConversation = activePane === "secondary" ? secondary : primary;
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
    setConversations(await loadConversationList(null));
    return result;
  };
  const manageConversation = async (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => {
    setLifecycleError(null);
    try {
      if (action === "rename") {
        const title = window.prompt("Rename conversation:", conversation.title);
        if (title === null) return;
        await postLifecycle("/api/state/conversations/rename", { threadId: conversation.id, title });
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
        const affected = Object.entries(preview.affectedRecords ?? {})
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${count} ${name}`)
          .join(", ");
        const confirmed = window.confirm(
          `Delete "${conversation.title}"?\n\nLocal data removed: ${affected}.\n\nNot removed: ${(preview.excluded ?? []).join(", ")}.\n\nThis cannot be undone.`,
        );
        if (!confirmed) return;
        await postLifecycle("/api/state/conversations/delete", {
          threadId: conversation.id,
          confirm: true,
        });
        if (primaryId === conversation.id) setPrimaryId(null);
        if (secondaryId === conversation.id) setSecondaryId(null);
      }
    } catch (error) {
      setLifecycleError(error instanceof Error ? error.message : "Conversation lifecycle action failed.");
    }
  };
  const refresh = async () => {
    if (!repository) {
      setChanges([]);
      return;
    }
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: activeConversation?.worktree ?? repository.selectedWorktree,
        }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch {
      setChanges([]);
    }
  };
  useEffect(() => { void refresh(); }, [activeConversation?.worktree, repository]);
  const repositoryFor = (conversation: ConversationSummary | null) => {
    if (!repository) return null;
    if (!conversation?.worktree) return repository;
    return {
      ...repository,
      selectedWorktree: conversation.worktree,
      name: conversation.projectName ?? repository.name,
    };
  };
  const openBeside = (id?: string) => {
    const candidate = id ?? conversations.find((conversation) => conversation.id !== primaryId)?.id ?? `new:${crypto.randomUUID()}`;
    secondaryIdReference.current = candidate;
    setSecondaryId(candidate);
    setActivePane("secondary");
  };
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
        onOpenConversation={(id) => {
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
          if (secondaryId === id) {
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
        }}
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
        onSearch={onSearch}
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
          if (!window.confirm(`Release managed worktree for "${conversation.title}"? The conversation is kept.`)) return;
          void postLifecycle("/api/state/conversations/release-worktree", { threadId: conversation.id, confirm: true })
            .catch((error: unknown) => setLifecycleError(
              error instanceof Error ? error.message : "Worktree release failed.",
            ));
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
        {lifecycleError && <div className="workspace-state error" role="alert">{lifecycleError}</div>}
        {incompleteDeletionIds.map((threadId) => (
          <div className="workspace-state error" role="alert" key={threadId}>
            <span>Conversation deletion {threadId} is incomplete.</span>
            <button onClick={() => {
              void postLifecycle("/api/state/conversations/delete", { threadId, confirm: true })
                .then(() => setIncompleteDeletionIds((ids) => ids.filter((id) => id !== threadId)))
                .catch((error: unknown) => setLifecycleError(
                  error instanceof Error ? error.message : "Conversation deletion retry failed.",
                ));
            }}>Retry deletion</button>
          </div>
        ))}
        {restoreState === "loading" && <div className="workspace-state" role="status">Restoring local conversations…</div>}
        {restoreState === "failed" && (
          <div className="workspace-state failed" role="alert">
            <span>Local conversation history could not be loaded.</span>
            <button onClick={() => setRestoreAttempt((value) => value + 1)}>Retry</button>
          </div>
        )}
        {(restoreState === "ready" || !repository) && <>
        {secondaryId && (
          <nav className="pane-switcher" aria-label="Visible conversation pane">
            <button className={activePane === "primary" ? "active" : ""} onClick={() => setActivePane("primary")}>
              Primary · {primary?.title ?? (primaryId ? "Replace conversation" : "New conversation")}
            </button>
            <button className={activePane === "secondary" ? "active" : ""} onClick={() => setActivePane("secondary")}>
              Secondary · {secondary?.title ?? (secondaryId.startsWith("new:") ? "New conversation" : "Replace conversation")}
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
              : <PaneConversation key={primaryId ?? `new-primary:${primaryNewKey}`} repository={repositoryFor(primary)} conversation={primary} pane="primary" active={activePane === "primary"} profiles={profiles} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} showChangesSignal={primaryChangesSignal} showFilesSignal={primaryFilesSignal} onConversationAvailable={(id) => {
                  if (primarySelectionReference.current === primarySelectionKey) {
                    primarySelectionReference.current = id;
                    setPrimaryId(id);
                  }
                  void loadConversationList(null).then(setConversations).catch(() => {});
                }} />}
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
                  : <PaneConversation key={secondaryId} repository={repositoryFor(secondary)} conversation={secondary} pane="secondary" active={activePane === "secondary"} profiles={profiles} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} onClosePane={() => {
                      secondaryIdReference.current = null;
                      setSecondaryId(null);
                      setActivePane("primary");
                    }} showChangesSignal={secondaryChangesSignal} showFilesSignal={secondaryFilesSignal} onConversationAvailable={(id) => {
                      if (secondaryIdReference.current !== secondaryId) return;
                      secondaryIdReference.current = id;
                      setSecondaryId(id);
                      void loadConversationList(null).then(setConversations).catch(() => {});
                    }} />}
              </div>
            </>
          )}
        </div>
        </>}
      </div>
      )}
      </main>
    </>
  );
}


