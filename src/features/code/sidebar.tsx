import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  Product,
  RepositoryMetadata,
  ChangedFile,
  ConversationSummary,
  ManagedAccount,
} from "../../types";
import type { SavedProject } from "../dialogs/repository-dialog";
import { ThreadRow } from "./thread-row";
import { branchFromWorktree, groupSidebarConversations } from "./conversation-list";
import { providerListLabel } from "../../lib/provider-readiness";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  type ProductAvailability,
} from "../../lib/product-availability";
import { AldunisBrandMark } from "../../components/brand-mark";
import { ManagedAccountPanel } from "./managed-account-panel";
import { SIDEBAR_TOGGLE_SHORTCUT_LABEL } from "../../lib/sidebar-state";

export type ProjectFilter = "all" | string;

const PRODUCTS: Array<{ id: Product; label: string; detail: string; mark: string }> = [
  { id: "code", label: "Code", detail: "Local workbench", mark: "A" },
  { id: "sekai", label: "Sekai", detail: "Knowledge plane", mark: "S" },
  { id: "chisei", label: "Chisei", detail: "Governance plane", mark: "C" },
  { id: "tenkai", label: "Tenkai", detail: "Delivery plane", mark: "T" },
];

/**
 * 1:1 sidebar structure from workbench-mock.html, wired to live data.
 */
export function CodeSidebar({
  sidebarOpen = true,
  onToggleSidebar = () => undefined,
  onRequestClose,
  product,
  onProductChange,
  productAvailability = DEFAULT_PRODUCT_AVAILABILITY,
  repository,
  repositoryRestoring = false,
  projects,
  projectFilter,
  onProjectFilterChange,
  onAddProject,
  onSelectProject,
  changes,
  onShowChanges,
  onBrowseFiles,
  onOpenPalette,
  conversations,
  primaryConversationId,
  secondaryConversationId,
  onOpenConversation,
  onOpenBeside,
  onNewConversation,
  onSelectWorktree,
  onManageWorktrees,
  showingArchived,
  onToggleArchived,
  onConversationAction,
  onSettle,
  onUnsettle,
  onReleaseWorktree,
  worktreeLimit,
  managedWorktreeCount,
  managedAccount,
  onSettings,
}: {
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onRequestClose?: () => void;
  product: Product;
  onProductChange: (product: Product) => void;
  /** Which planes may be selected; unconfigured planes stay visible but disabled. */
  productAvailability?: ProductAvailability;
  repository: RepositoryMetadata | null;
  repositoryRestoring?: boolean;
  /** Registered projects (T3-style permanent registry). */
  projects: SavedProject[];
  /** "all" inbox or a single project id. */
  projectFilter: ProjectFilter;
  onProjectFilterChange: (filter: ProjectFilter) => void;
  /** Rare: open path picker to register a new project. */
  onAddProject: () => void;
  /** Switch active project by id without path browsing. */
  onSelectProject: (projectId: string) => void;
  changes: ChangedFile[];
  onShowChanges: () => void;
  onBrowseFiles: () => void;
  onOpenPalette: () => void;
  conversations: ConversationSummary[];
  primaryConversationId: string | null;
  secondaryConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onOpenBeside: (id: string) => void;
  onNewConversation: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
  showingArchived: boolean;
  onToggleArchived: () => void;
  onConversationAction: (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => void;
  onSettle: (conversation: ConversationSummary) => void;
  onUnsettle: (conversation: ConversationSummary) => void;
  onReleaseWorktree: (conversation: ConversationSummary) => void;
  worktreeLimit: number;
  managedWorktreeCount: number;
  managedAccount?: ManagedAccount | null;
  onSettings: () => void;
}) {
  const [productOpen, setProductOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const brandRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const settledShelfId = useId();
  const attentionHeadingId = useId();
  const activeHeadingId = useId();

  useEffect(() => {
    if (!sidebarOpen) {
      setProductOpen(false);
      setProjectMenuOpen(false);
    }
  }, [sidebarOpen]);

  const { attention, active, settled } = useMemo(
    () => groupSidebarConversations(conversations, showingArchived),
    [conversations, showingArchived],
  );

  const meterPct = worktreeLimit > 0
    ? Math.min(100, Math.round((managedWorktreeCount / worktreeLimit) * 100))
    : 0;
  const meterHot = worktreeLimit > 0 && managedWorktreeCount / worktreeLimit >= 0.75;

  useEffect(() => {
    if (!productOpen) return;
    const root = brandRef.current;
    if (!root) return;
    const items = () => [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')];
    const frame = window.requestAnimationFrame(() => {
      const list = items();
      const selected = list.find((item) => item.getAttribute("aria-checked") === "true") ?? list[0];
      selected?.focus();
    });
    const onDown = (event: MouseEvent) => {
      if (!root.contains(event.target as Node)) setProductOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProductOpen(false);
        root.querySelector<HTMLElement>(".brandbtn")?.focus();
        return;
      }
      const list = items();
      if (!list.length) return;
      // Skip disabled products when moving focus.
      const enabled = list.filter((item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true");
      const pool = enabled.length ? enabled : list;
      const currentIndex = pool.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = currentIndex < 0 ? 0 : Math.min(pool.length - 1, currentIndex + 1);
        pool[next]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = currentIndex < 0 ? pool.length - 1 : Math.max(0, currentIndex - 1);
        pool[next]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        pool[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        pool[pool.length - 1]?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [productOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const root = projectMenuRef.current;
    if (!root) return;
    const options = () => [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    // Move focus into the listbox so arrow keys work immediately.
    const focusSelected = () => {
      const opts = options();
      const selected = opts.find((option) => option.getAttribute("aria-selected") === "true") ?? opts[0];
      selected?.focus();
    };
    const frame = window.requestAnimationFrame(focusSelected);
    const onDown = (event: MouseEvent) => {
      if (!root.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setProjectMenuOpen(false);
        root.querySelector<HTMLElement>(".project-filter-trigger")?.focus();
        return;
      }
      const opts = options();
      if (!opts.length) return;
      const currentIndex = opts.indexOf(document.activeElement as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = currentIndex < 0 ? 0 : Math.min(opts.length - 1, currentIndex + 1);
        opts[next]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = currentIndex < 0 ? opts.length - 1 : Math.max(0, currentIndex - 1);
        opts[next]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        opts[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        opts[opts.length - 1]?.focus();
      }
      // Enter/Space activate the focused option via native button behavior.
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (!sidebarOpen || !onRequestClose) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      onRequestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRequestClose, sidebarOpen]);

  const selectedProject = useMemo(
    () => (projectFilter === "all" ? null : projects.find((project) => project.id === projectFilter) ?? null),
    [projectFilter, projects],
  );
  const projectFilterLabel = repositoryRestoring && projects.length === 0
    ? "Restoring projects…"
    : selectedProject?.name ?? "All projects";
  const projectFilterDetail = selectedProject?.root
    ?? (projects.length === 0
      ? "Add a project to start"
      : repository
        ? `Current: ${repository.name} · ${projects.length} project${projects.length === 1 ? "" : "s"}`
        : `${projects.length} project${projects.length === 1 ? "" : "s"}`);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      // mock uses ⌘1–4 without shift in UI label; we accept both
      const map: Record<string, Product> = {
        Digit1: "code", Digit2: "sekai", Digit3: "chisei", Digit4: "tenkai",
        "1": "code", "2": "sekai", "3": "chisei", "4": "tenkai",
      };
      const next = map[event.code] ?? map[event.key];
      if (!next || !isProductAvailable(next, productAvailability)) return;
      event.preventDefault();
      onProductChange(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onProductChange, productAvailability]);

  const current = PRODUCTS.find((item) => item.id === product) ?? PRODUCTS[0];
  // Match workbench-mock.html: Code → "Aldunis Code"; other products → "Aldunis {Name}".
  const brandName = product === "code" ? "Aldunis Code" : `Aldunis ${current.label}`;

  return (
    <aside
      id="code-sidebar"
      className="sb"
      data-sidebar-state={sidebarOpen ? "expanded" : "collapsed"}
      aria-hidden={!sidebarOpen}
      inert={!sidebarOpen}
      aria-label="Workbench sidebar"
    >
      <div className="sb-hd" ref={brandRef}>
        <button
          type="button"
          className="brandbtn"
          onClick={() => setProductOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={productOpen}
          aria-label={`Product: ${current.label}`}
        >
          <div className="logo" aria-hidden="true">
            {product === "code" ? <AldunisBrandMark className="aldunis-brand-mark--compact" /> : current.mark}
          </div>
          <div className="sb-name">{brandName}</div>
          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--muted-foreground)" }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {sidebarOpen && (
          <button
            type="button"
            className="sidebar-toggle sidebar-toggle--collapse"
            data-sidebar-collapse-toggle
            aria-controls="code-sidebar"
            aria-expanded={sidebarOpen}
            aria-keyshortcuts="Meta+B Control+B"
            aria-label="Collapse sidebar"
            title={`Collapse sidebar (${SIDEBAR_TOGGLE_SHORTCUT_LABEL})`}
            onClick={onToggleSidebar}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 6 9 12l6 6" />
              <path d="M5 5v14" />
            </svg>
          </button>
        )}
        {productOpen && (
          <div className="pswitch" role="menu" aria-label="Products">
            {PRODUCTS.map((item, index) => {
              const available = isProductAvailable(item.id, productAvailability);
              const detail = available ? item.detail : "Not configured yet";
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === product}
                  aria-disabled={!available}
                  aria-label={
                    available
                      ? `${item.label}: ${item.detail}`
                      : `${item.label}: not configured yet`
                  }
                  key={item.id}
                  disabled={!available}
                  className={`pi2 ${item.id === product ? "cur" : ""} ${available ? "" : "dis"}`.trim()}
                  onClick={() => {
                    if (!available) return;
                    onProductChange(item.id);
                    setProductOpen(false);
                  }}
                >
                  <span className="m2" aria-hidden="true">
                    {item.id === "code" ? <AldunisBrandMark className="aldunis-brand-mark--compact" /> : item.mark}
                  </span>
                  <span className="b2">
                    <span className="n2">{item.label}</span>
                    <span className="p2">{detail}</span>
                  </span>
                  <span className="k2" aria-hidden="true">⌘{index + 1}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {product === "code" && (
        <div className="code-nav" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div className="g1">
            <button type="button" className="search" onClick={onOpenPalette} aria-label="Search and commands">
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              Search
              <span className="kbd">⌘K</span>
            </button>
            <button
              type="button"
              className="newthr"
              title={repositoryRestoring ? "Restoring projects…" : "New conversation"}
              aria-label="New conversation"
              disabled={repositoryRestoring}
              onClick={onNewConversation}
            >
              <svg className="ic ic-lg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          </div>

          {/* Compact project filter dropdown (space-efficient vs chip row). */}
          <div className="g2 project-filter" ref={projectMenuRef}>
            <button
              type="button"
              className="proj project-filter-trigger"
              onClick={() => setProjectMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={projectMenuOpen}
              aria-label={`Project filter: ${projectFilterLabel}${
                projectFilter === "all" && repository
                  ? `, current project ${repository.name}`
                  : ""
              }${
                attention.length > 0
                  ? `, ${attention.length} conversation${attention.length === 1 ? "" : "s"} need attention`
                  : ""
              }`}
              title={selectedProject?.root ?? repository?.root}
            >
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span className="b">
                <span className="n">{projectFilterLabel}</span>
                <span className="p">{projectFilterDetail}</span>
              </span>
              <svg className="ic ic-sm project-filter-caret" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {projectMenuOpen && (
              <div className="project-filter-menu" role="listbox" aria-label="Filter by project">
                <button
                  type="button"
                  role="option"
                  aria-selected={projectFilter === "all"}
                  aria-label="All projects: Inbox across every registered project"
                  className={`project-filter-option ${projectFilter === "all" ? "active" : ""}`}
                  onClick={() => {
                    onProjectFilterChange("all");
                    setProjectMenuOpen(false);
                  }}
                >
                  <span className="n">All projects</span>
                  <span className="p">Inbox across every registered project</span>
                </button>
                {projects.map((project) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={projectFilter === project.id}
                    aria-label={`${project.name}: ${project.root}`}
                    key={project.id}
                    className={`project-filter-option ${projectFilter === project.id ? "active" : ""}`}
                    title={project.root}
                    onClick={() => {
                      onProjectFilterChange(project.id);
                      onSelectProject(project.id);
                      setProjectMenuOpen(false);
                    }}
                  >
                    <span className="n">{project.name}</span>
                    <span className="p">{project.root}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-label="Add project: Register a local repository once"
                  className="project-filter-option add"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    onAddProject();
                  }}
                >
                  <span className="n">Add project…</span>
                  <span className="p">Register a local repository once</span>
                </button>
              </div>
            )}
          </div>

          <div className="list" id="list" role="list">
            {attention.length > 0 && (
              <div className="attention-group" role="group" aria-labelledby={attentionHeadingId}>
                <div className="glabel attention-label" id={attentionHeadingId} aria-live="polite">
                  <span className="attention-label-copy">
                    <span>Needs attention</span>
                    <small>Approval, input, or failure</small>
                  </span>
                  <span className="n">{attention.length}</span>
                </div>
                {attention.map((conversation) => {
                  const openInPane = primaryConversationId === conversation.id
                    || secondaryConversationId === conversation.id;
                  return (
                    <ThreadRow
                      key={conversation.id}
                      conversation={conversation}
                      active={openInPane}
                      onOpen={() => onOpenConversation(conversation.id)}
                      onSettle={() => onSettle(conversation)}
                      showSettle
                      showBeside={!openInPane}
                      onOpenBeside={() => onOpenBeside(conversation.id)}
                      archivedView={false}
                      onAction={(action) => onConversationAction(conversation, action)}
                    />
                  );
                })}
              </div>
            )}
            <div className="glabel" id={activeHeadingId}>
              <span>{showingArchived ? "Archived" : "Active"}</span>
              <span className="n">{active.length}</span>
              <button
                type="button"
                className="glabel-action"
                onClick={onToggleArchived}
                aria-pressed={showingArchived}
              >
                {showingArchived ? "Show active" : "Show archived"}
              </button>
            </div>
            <div role="group" aria-labelledby={activeHeadingId}>
              {active.map((conversation) => {
                const openInPane = primaryConversationId === conversation.id
                  || secondaryConversationId === conversation.id;
                return (
                  <ThreadRow
                    key={conversation.id}
                    conversation={conversation}
                    active={openInPane}
                    onOpen={() => onOpenConversation(conversation.id)}
                    onSettle={showingArchived ? undefined : () => onSettle(conversation)}
                    showSettle={!showingArchived}
                    // Beside is for a second column — hide when this thread is already primary or secondary.
                    showBeside={!showingArchived && !openInPane}
                    onOpenBeside={() => onOpenBeside(conversation.id)}
                    archivedView={showingArchived}
                    onAction={(action) => onConversationAction(conversation, action)}
                  />
                );
              })}
            </div>
            {active.length === 0 && attention.length === 0 && projects.length > 0 && (
              <div className="empty-list">
                <span>
                  {showingArchived
                    ? "No archived conversations."
                    : "No open threads in this project."}
                </span>
                {!showingArchived && (
                  <button
                    type="button"
                    className="empty-list-action"
                    title={repositoryRestoring ? "Restoring projects…" : "New conversation"}
                    aria-label={repositoryRestoring ? "Restoring projects…" : "New conversation"}
                    disabled={repositoryRestoring}
                    onClick={repositoryRestoring ? undefined : onNewConversation}
                  >
                    {repositoryRestoring ? "Restoring projects…" : "New conversation"}
                  </button>
                )}
              </div>
            )}
          </div>

          {!showingArchived && (
            <div className="shelf">
              <button
                type="button"
                className={`shelf-h ${shelfOpen ? "open" : ""}`}
                onClick={() => setShelfOpen((v) => !v)}
                aria-expanded={shelfOpen}
                aria-controls={shelfOpen ? settledShelfId : undefined}
                aria-label={`Settled conversations (${settled.length})`}
              >
                <span className="cv" aria-hidden="true">▶</span>
                <span>Settled ({settled.length})</span>
              </button>
              {shelfOpen && (
                <div id={settledShelfId} role="region" aria-label="Settled conversations">
                  <div className="meter">
                    <span>Worktrees</span>
                    <span className="mbar">
                      <i className={meterHot ? "hot" : ""} style={{ width: `${meterPct}%` }} />
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {managedWorktreeCount} / {worktreeLimit}
                    </span>
                  </div>
                  {settled.map((conversation) => {
                    const holds = repository?.worktrees.some(
                      (wt) => wt.path === conversation.worktree && wt.ownership === "aldunis",
                    );
                    const provider = conversation.provider
                      ? providerListLabel(conversation.provider)
                      : null;
                    const branch = branchFromWorktree(conversation.worktree);
                    const meta = [provider, holds ? "managed worktree" : branch]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div className="srow" key={conversation.id} data-wt={holds ? "1" : "0"}>
                        <button
                          type="button"
                          className="srow-main"
                          onClick={() => onOpenConversation(conversation.id)}
                          aria-label={
                            meta
                              ? `Open settled conversation "${conversation.title}" · ${meta}`
                              : `Open settled conversation "${conversation.title}"`
                          }
                        >
                          <span className="t" title={conversation.title}>{conversation.title}</span>
                        </button>
                        {holds
                          ? (
                            <span className="wt" title={meta || undefined}>
                              <span className="dot" />
                              {provider ? `${provider} · worktree` : "worktree"}
                            </span>
                          )
                          : (
                            <span className="w" title={meta || undefined}>
                              {meta || branch}
                            </span>
                          )}
                        <div className="sacts">
                          {holds && (
                            <button
                              type="button"
                              className="sbtn rel"
                              aria-label={
                                conversation.provider
                                  ? `Release worktree for "${conversation.title}" · ${providerListLabel(conversation.provider)}`
                                  : `Release worktree for "${conversation.title}"`
                              }
                              onClick={() => onReleaseWorktree(conversation)}
                            >
                              Release
                            </button>
                          )}
                          <button
                            type="button"
                            className="sbtn"
                            aria-label={
                              conversation.provider
                                ? `Unsettle "${conversation.title}" · ${providerListLabel(conversation.provider)}`
                                : `Unsettle "${conversation.title}"`
                            }
                            onClick={() => onUnsettle(conversation)}
                          >
                            Unsettle
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="sb-ft">
        {managedAccount && <ManagedAccountPanel account={managedAccount} />}
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          style={{ marginLeft: "auto" }}
          onClick={onSettings}
          aria-label="Settings"
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
