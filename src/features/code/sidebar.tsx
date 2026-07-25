import React, { useMemo, useState } from "react";
import type { RepositoryMetadata, ChangedFile, ConversationSummary } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";
import { ThreadRow } from "./thread-row";
import { branchFromWorktree } from "./conversation-list";

/**
 * Sidebar layout matching workbench-mock.html:
 * brand · search + new · project · thread list · settled shelf
 */
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
  const [shelfOpen, setShelfOpen] = useState(true);
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
    <aside className="context-sidebar mock-sb">
      <div className="mock-sb-hd">
        <div className="mock-logo" aria-hidden="true">A</div>
        <div className="mock-sb-name">Aldunis Code</div>
      </div>

      <div className="mock-g1">
        <button type="button" className="mock-search" onClick={onSearch}>
          <Icon name="search" />
          <span>Search threads</span>
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className="mock-newthr"
          aria-label="New conversation"
          onClick={onNewConversation}
        >
          +
        </button>
      </div>

      <div className="mock-g2">
        <button type="button" className="mock-proj" onClick={onOpenRepository}>
          <span className="mock-fav">{repository?.name.charAt(0).toUpperCase() ?? "+"}</span>
          <span className="mock-proj-b">
            <span className="mock-proj-n">{repository?.name ?? "Open repository"}</span>
            <span className="mock-proj-p">{repository?.root ?? "Select an explicit local root"}</span>
          </span>
          <Icon name="chevron" />
        </button>
      </div>

      <div className="mock-tools">
        <button type="button" onClick={onOpenPalette}>Commands</button>
        <button type="button" onClick={onBrowseFiles} disabled={!repository}>Files</button>
        <button type="button" onClick={() => onManageWorktrees()} disabled={!repository}>
          Worktrees {repository ? `(${repository.worktrees.length})` : ""}
        </button>
        <button type="button" onClick={onShowChanges} disabled={!repository}>
          Changes {repository ? `(${changes.length})` : ""}
        </button>
      </div>

      {repository && repository.worktrees.length > 0 && (
        <div className="worktree-list compact" aria-label="Repository worktrees">
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

      <div className="mock-glabel">
        <span>{showingArchived ? "Archived" : "Threads"}</span>
        <span className="n">{active.length}</span>
        <button type="button" className="mock-glabel-action" onClick={onToggleArchived}>
          {showingArchived ? "Active" : "Archived"}
        </button>
      </div>

      <div className="mock-list thread-list" role="list">
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
        {active.length === 0 && (
          <p className="empty-conversations">
            {!repository
              ? "Open a repository to list threads."
              : showingArchived
                ? "No archived conversations."
                : "No open threads. Use + to start — first send binds a managed worktree."}
          </p>
        )}
      </div>

      {!showingArchived && (
        <div className="settled-shelf mock-shelf">
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
                <span>{managedWorktreeCount} / {worktreeLimit} worktrees</span>
                <span className="worktree-meter__bar" aria-hidden="true">
                  <i style={{ width: `${meterPct}%` }} className={meterHot ? "hot" : ""} />
                </span>
              </div>
              {settled.length === 0 ? (
                <p className="empty-conversations settled-empty">
                  Settled threads land here. Settling keeps the worktree until released.
                </p>
              ) : (
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
                            ? <span className="settled-row__wt"><span className="dot" />wt</span>
                            : <span className="settled-row__branch">{branchFromWorktree(conversation.worktree)}</span>}
                        </button>
                        <div className="settled-row__actions">
                          <button type="button" onClick={() => onUnsettle(conversation)}>Unsettle</button>
                          {holdsWorktree && (
                            <button type="button" className="release" onClick={() => onReleaseWorktree(conversation)}>
                              Release
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
