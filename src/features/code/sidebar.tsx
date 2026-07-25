import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { RepositoryMetadata, ChangedFile, ConversationSummary } from "../../types";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui";

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
}) {
  return (
    <aside className="context-sidebar">
      <header>
        <div>
          <strong>ALDUNIS CODE</strong>
          <span>Local workbench</span>
        </div>
        <button aria-label="New conversation" onClick={onNewConversation}><Icon name="plus" /></button>
      </header>
      <button className="project-switcher" onClick={onOpenRepository}>
        <span className="repo-glyph">{repository?.name.charAt(0).toUpperCase() ?? "+"}</span>
        <span>
          <strong>{repository?.name ?? "Open repository"}</strong>
          <small>{repository?.root ?? "Select an explicit local root"}</small>
        </span>
        <Icon name="chevron" />
      </button>
      <div className="sidebar-actions">
        <button onClick={onOpenPalette}><Icon name="spark" /> Commands <kbd>⌘ K</kbd></button>
        <button onClick={onSearch}><Icon name="search" /> Thread search</button>
        <button onClick={onBrowseFiles} disabled={!repository}><Icon name="search" /> Browse files</button>
        <button onClick={() => onManageWorktrees()} disabled={!repository}><Icon name="branch" /> Worktrees <span className="count">{repository?.worktrees.length ?? "—"}</span></button>
        <button onClick={onShowChanges} disabled={!repository}>
          <Icon name="diff" /> Changed files <span className="change-count">{repository ? changes.length : "—"}</span>
        </button>
      </div>
      {repository && (
        <div className="worktree-list" aria-label="Repository worktrees">
          {repository.worktrees.map((worktree) => (
            <div className={repository.selectedWorktree === worktree.path ? "selected" : ""} key={worktree.path}>
              <span className={`worktree-state ${worktree.state}`} aria-hidden="true" />
              <button
                className="worktree-select"
                onClick={() => onSelectWorktree(worktree.path)}
                disabled={worktree.state === "missing" || worktree.state === "inaccessible"}
                aria-current={repository.selectedWorktree === worktree.path ? "true" : undefined}
              >
                <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                <small>{worktree.path}</small>
              </button>
              <button
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
        <span>{showingArchived ? "Archived conversations" : "Conversations"}</span>
        <button onClick={onToggleArchived}>{showingArchived ? "Active" : "Archived"}</button>
      </div>
      <div className="session-list">
        {conversations.map((conversation) => (
          <div className="session-row" key={conversation.id}>
            <button
              className={primaryConversationId === conversation.id ? "active" : ""}
              onClick={() => onOpenConversation(conversation.id)}
              aria-label={`Open ${conversation.title}`}
            >
              <span className="session-icon"><Icon name="message" /></span>
              <span className="session-copy">
                <strong>{conversation.pinnedAt ? "◆ " : ""}{conversation.title}</strong>
                <small>{conversation.worktree}</small>
              </span>
              {(primaryConversationId === conversation.id || secondaryConversationId === conversation.id) && <i />}
            </button>
            <button
              className="open-beside"
              onClick={() => onOpenBeside(conversation.id)}
              disabled={primaryConversationId === conversation.id}
              aria-label={`Open ${conversation.title} beside current conversation`}
            >▥</button>
            <button
              className="conversation-actions"
              aria-label={`Manage ${conversation.title}`}
              onClick={() => {
                const options = showingArchived
                  ? "restore or delete"
                  : `rename, ${conversation.pinnedAt ? "unpin" : "pin"}, archive, or delete`;
                const selected = window.prompt(`Choose ${options}:`)?.trim().toLocaleLowerCase();
                if (selected === "rename" || selected === "pin" || selected === "archive"
                  || selected === "restore" || selected === "delete") {
                  onConversationAction(conversation, selected);
                } else if (selected === "unpin") {
                  onConversationAction(conversation, "pin");
                }
              }}
            >•••</button>
          </div>
        ))}
        {repository && conversations.length === 0 && (
          <p className="empty-conversations">
            {showingArchived ? "No archived conversations." : "Send a prompt to create the first conversation."}
          </p>
        )}
      </div>
      <footer><span className="provider-dot" /><span><strong>Claude Code</strong><small>Not connected</small></span><Button variant="secondary" size="sm">Connect</Button></footer>
    </aside>
  );
}



