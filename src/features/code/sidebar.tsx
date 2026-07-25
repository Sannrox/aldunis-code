import React, { useMemo, useState } from "react";
import type { RepositoryMetadata, ChangedFile, ConversationSummary } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";
import { ThreadRow } from "./thread-row";
import { branchFromWorktree } from "./conversation-list";

export function CodeSidebar({
  repository,
  onOpenRepository,
  changes,
  onShowChanges,
  onBrowseFiles,
  onSearch,
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
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  changes: ChangedFile[];
  onShowChanges: () => void;
  onBrowseFiles: () => void;
  onSearch: () => void;
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
}) {
  const [shelfOpen, setShelfOpen] = useState(false);
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

  const meterHot = worktreeLimit > 0 && managedWorktreeCount / worktreeLimit >= 0.8;
  const meterPct = worktreeLimit > 0
    ? Math.min(100, Math.round((managedWorktreeCount / worktreeLimit) * 100))
    : 0;

  return (
    <aside className="context-sidebar">
      <header className="sb-header">
        <div>
          <strong>ALDUNIS CODE</strong>
          <span>Local workbench</span>
        </div>
        <Button
          variant="primary"
          size="icon-sm"
          aria-label="New conversation"
          onClick={onNewConversation}
        >
          <Icon name="plus" />
        </Button>
      </header>
      <button type="button" className="project-switcher" onClick={onOpenRepository}>
        <span className="repo-glyph">{repository?.name.charAt(0).toUpperCase() ?? "+"}</span>
        <span>
          <strong>{repository?.name ?? "Open repository"}</strong>
          <small>{repository?.root ?? "Select an explicit local root"}</small>
        </span>
        <Icon name="chevron" />
      </button>
      <div className="sidebar-actions">
        <button type="button" onClick={onOpenPalette}><Icon name="spark" /> Commands <kbd>⌘ K</kbd></button>
        <button type="button" onClick={onSearch}><Icon name="search" /> Thread search</button>
        <button type="button" onClick={onBrowseFiles} disabled={!repository}><Icon name="search" /> Browse files</button>
        <button type="button" onClick={() => onManageWorktrees()} disabled={!repository}>
          <Icon name="branch" /> Worktrees <span className="count">{repository?.worktrees.length ?? "—"}</span>
        </button>
        <button type="button" onClick={onShowChanges} disabled={!repository}>
          <Icon name="diff" /> Changed files <span className="change-count">{repository ? changes.length : "—"}</span>
        </button>
      </div>
      {repository && (
        <div className="worktree-list" aria-label="Repository worktrees">
          {repository.worktrees.map((worktree) => (
            <div className={repository.selectedWorktree === worktree.path ? "selected" : ""} key={worktree.path}>
              <span className={`worktree-state ${worktree.state}`} aria-hidden="true" />
              <button
                type="button"
                className="worktree-select"
                onClick={() => onSelectWorktree(worktree.path)}
                disabled={worktree.state === "missing" || worktree.state === "inaccessible"}
                aria-current={repository.selectedWorktree === worktree.path ? "true" : undefined}
              >
                <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                <small>{worktree.path}</small>
              </button>
              <button
                type="button"
                className="worktree-manage"
                onClick={() => onManageWorktrees(worktree.path)}
                aria-label={`Manage ${worktree.branch ?? worktree.path}`}
              >
                {worktree.ownership === "aldunis" ? worktree.recovery : "user"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="section-label">
        <span>{showingArchived ? "Archived" : "Threads"}</span>
        <button type="button" onClick={onToggleArchived}>{showingArchived ? "Active" : "Archived"}</button>
      </div>
      <div className="thread-list" role="list">
        {active.map((conversation) => (
          <ThreadRow
            key={conversation.id}
            conversation={conversation}
            active={primaryConversationId === conversation.id || secondaryConversationId === conversation.id}
            onOpen={() => onOpenConversation(conversation.id)}
            onSettle={showingArchived ? undefined : () => onSettle(conversation)}
            showSettle={!showingArchived}
            onOpenBeside={() => onOpenBeside(conversation.id)}
            canOpenBeside={primaryConversationId !== conversation.id}
          />
        ))}
        {repository && active.length === 0 && (
          <p className="empty-conversations">
            {showingArchived ? "No archived conversations." : "Send a prompt to create the first conversation."}
          </p>
        )}
      </div>
      {!showingArchived && settled.length > 0 && (
        <div className="settled-shelf">
          <button
            type="button"
            className={`settled-shelf__toggle ${shelfOpen ? "open" : ""}`}
            onClick={() => setShelfOpen((value) => !value)}
            aria-expanded={shelfOpen}
          >
            <span className="settled-shelf__chevron" aria-hidden="true">▸</span>
            Settled ({settled.length})
          </button>
          {shelfOpen && (
            <>
              <div className="worktree-meter" aria-label={`Managed worktrees ${managedWorktreeCount} of ${worktreeLimit}`}>
                <span>Worktrees {managedWorktreeCount} / {worktreeLimit}</span>
                <span className="worktree-meter__bar" aria-hidden="true">
                  <i style={{ width: `${meterPct}%` }} className={meterHot ? "hot" : ""} />
                </span>
              </div>
              <div className="settled-list">
                {settled.map((conversation) => {
                  const holdsWorktree = repository?.worktrees.some(
                    (wt) => wt.path === conversation.worktree && wt.ownership === "aldunis",
                  );
                  return (
                    <div className="settled-row" key={conversation.id}>
                      <button
                        type="button"
                        className="settled-row__main"
                        onClick={() => onOpenConversation(conversation.id)}
                      >
                        <span className="settled-row__title">{conversation.title}</span>
                        {holdsWorktree
                          ? <span className="settled-row__wt" title="Still holds a managed worktree"><span className="dot" />wt</span>
                          : <span className="settled-row__branch">{branchFromWorktree(conversation.worktree)}</span>}
                      </button>
                      <div className="settled-row__actions">
                        <button type="button" onClick={() => onUnsettle(conversation)}>Unsettle</button>
                        {holdsWorktree && (
                          <button
                            type="button"
                            className="release"
                            onClick={() => onReleaseWorktree(conversation)}
                          >
                            Release
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
