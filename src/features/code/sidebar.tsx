import React, { useEffect, useMemo, useRef, useState } from "react";
import type { Product, RepositoryMetadata, ChangedFile, ConversationSummary } from "../../types";
import type { SavedProject } from "../dialogs/repository-dialog";
import { ThreadRow } from "./thread-row";
import { branchFromWorktree } from "./conversation-list";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  type ProductAvailability,
} from "../../lib/product-availability";

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
  onSettle,
  onUnsettle,
  onReleaseWorktree,
  worktreeLimit,
  managedWorktreeCount,
  onSettings,
}: {
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
  onSettings: () => void;
}) {
  const [productOpen, setProductOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(false);
  const brandRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  const { active, settled } = useMemo(() => {
    const activeList: ConversationSummary[] = [];
    const settledList: ConversationSummary[] = [];
    for (const conversation of conversations) {
      if (conversation.settledAt) settledList.push(conversation);
      else activeList.push(conversation);
    }
    settledList.sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
    return { active: activeList, settled: settledList };
  }, [conversations]);

  const meterPct = worktreeLimit > 0
    ? Math.min(100, Math.round((managedWorktreeCount / worktreeLimit) * 100))
    : 0;
  const meterHot = worktreeLimit > 0 && managedWorktreeCount / worktreeLimit >= 0.75;

  useEffect(() => {
    if (!productOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!brandRef.current?.contains(event.target as Node)) setProductOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProductOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [productOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenuOpen]);

  const selectedProject = useMemo(
    () => (projectFilter === "all" ? null : projects.find((project) => project.id === projectFilter) ?? null),
    [projectFilter, projects],
  );
  const projectFilterLabel = repositoryRestoring && projects.length === 0
    ? "Restoring projects…"
    : selectedProject?.name ?? "All projects";
  const projectFilterDetail = selectedProject?.root
    ?? (projects.length === 0 ? "Add a project to start" : `${projects.length} project${projects.length === 1 ? "" : "s"}`);

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
    <aside className="sb">
      <div className="sb-hd" ref={brandRef}>
        <button
          type="button"
          className="brandbtn"
          onClick={() => setProductOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={productOpen}
          aria-label={`Product: ${current.label}`}
        >
          <div className="logo">{current.mark}</div>
          <div className="sb-name">{brandName}</div>
          <svg className="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--muted-foreground)" }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {productOpen && (
          <div className="pswitch" role="menu" aria-label="Products">
            {PRODUCTS.map((item, index) => {
              const available = isProductAvailable(item.id, productAvailability);
              const detail = available ? item.detail : "Not configured";
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === product}
                  aria-disabled={!available}
                  aria-label={
                    available
                      ? `${item.label}: ${item.detail}`
                      : `${item.label}: not configured`
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
                  <span className="m2" aria-hidden="true">{item.mark}</span>
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
            <button type="button" className="newthr" title="New thread" aria-label="New conversation" onClick={onNewConversation}>
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
              aria-label={`Project filter: ${projectFilterLabel}`}
              title={selectedProject?.root}
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
            <div className="glabel">
              Threads
              <span className="n">{active.length}</span>
            </div>
            {active.map((conversation) => (
              <ThreadRow
                key={conversation.id}
                conversation={conversation}
                active={
                  primaryConversationId === conversation.id
                  || secondaryConversationId === conversation.id
                }
                onOpen={() => onOpenConversation(conversation.id)}
                onSettle={showingArchived ? undefined : () => onSettle(conversation)}
                showSettle={!showingArchived}
                showBeside={!showingArchived}
                onOpenBeside={() => onOpenBeside(conversation.id)}
              />
            ))}
            {active.length === 0 && projects.length > 0 && (
              <p className="empty-list">
                {showingArchived
                  ? "No archived conversations."
                  : "No open threads. Start a new one — it stays in this project."}
              </p>
            )}
          </div>

          {!showingArchived && (
            <div className="shelf">
              <button
                type="button"
                className={`shelf-h ${shelfOpen ? "open" : ""}`}
                onClick={() => setShelfOpen((v) => !v)}
                aria-expanded={shelfOpen}
              >
                <span className="cv">▶</span>
                <span>Settled ({settled.length})</span>
              </button>
              {shelfOpen && (
                <div>
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
                    return (
                      <div className="srow" key={conversation.id} data-wt={holds ? "1" : "0"}>
                        <button type="button" className="srow-main" onClick={() => onOpenConversation(conversation.id)}>
                          <span className="t">{conversation.title}</span>
                        </button>
                        {holds
                          ? <span className="wt"><span className="dot" />worktree</span>
                          : <span className="w">{branchFromWorktree(conversation.worktree)}</span>}
                        <div className="sacts">
                          {holds && (
                            <button
                              type="button"
                              className="sbtn rel"
                              aria-label={`Release worktree for "${conversation.title}"`}
                              onClick={() => onReleaseWorktree(conversation)}
                            >
                              Release
                            </button>
                          )}
                          <button
                            type="button"
                            className="sbtn"
                            aria-label={`Unsettle "${conversation.title}"`}
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
        <button type="button" className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }} onClick={onSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}
