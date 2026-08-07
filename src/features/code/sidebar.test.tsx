import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeSidebar } from "./sidebar";

test("new conversations wait for registered projects to restore", () => {
  const html = renderToStaticMarkup(
    <CodeSidebar
      product="code"
      onProductChange={() => undefined}
      repository={null}
      repositoryRestoring
      projects={[
        {
          id: "project-1",
          name: "Aldunis Code",
          root: "/workspace/aldunis-code",
          openedAt: "2026-08-04T00:00:00.000Z",
        },
      ]}
      projectFilter="all"
      onProjectFilterChange={() => undefined}
      onAddProject={() => undefined}
      onSelectProject={() => undefined}
      changes={[]}
      onShowChanges={() => undefined}
      onBrowseFiles={() => undefined}
      onOpenPalette={() => undefined}
      conversations={[]}
      primaryConversationId={null}
      secondaryConversationId={null}
      onOpenConversation={() => undefined}
      onOpenBeside={() => undefined}
      onNewConversation={() => undefined}
      onSelectWorktree={() => undefined}
      onManageWorktrees={() => undefined}
      showingArchived={false}
      onToggleArchived={() => undefined}
      onConversationAction={() => undefined}
      onSettle={() => undefined}
      onSnooze={() => undefined}
      onUnsettle={() => undefined}
      onUnsnooze={() => undefined}
      onReleaseWorktree={() => undefined}
      worktreeLimit={4}
      managedWorktreeCount={0}
      onSettings={() => undefined}
    />,
  );

  assert.match(html, /title="Restoring projects…" aria-label="New conversation" disabled=""/);
  assert.match(
    html,
    /class="empty-list-action" title="Restoring projects…" aria-label="Restoring projects…" disabled="">Restoring projects…<\/button>/,
  );
  assert.match(html, /data-sidebar-state="expanded"/);
  assert.match(html, /aldunis-brand-mark--compact/);
  assert.match(
    html,
    /data-sidebar-collapse-toggle[^>]*aria-keyshortcuts="Meta\+B Control\+B"[^>]*title="Collapse sidebar \(⌘B \/ Ctrl\+B\)"/,
  );
});

test("collapsed sidebar exposes a hidden state for the shared shell", () => {
  const html = renderToStaticMarkup(
    <CodeSidebar
      sidebarOpen={false}
      product="code"
      onProductChange={() => undefined}
      repository={null}
      projects={[]}
      projectFilter="all"
      onProjectFilterChange={() => undefined}
      onAddProject={() => undefined}
      onSelectProject={() => undefined}
      changes={[]}
      onShowChanges={() => undefined}
      onBrowseFiles={() => undefined}
      onOpenPalette={() => undefined}
      conversations={[]}
      primaryConversationId={null}
      secondaryConversationId={null}
      onOpenConversation={() => undefined}
      onOpenBeside={() => undefined}
      onNewConversation={() => undefined}
      onSelectWorktree={() => undefined}
      onManageWorktrees={() => undefined}
      showingArchived={false}
      onToggleArchived={() => undefined}
      onConversationAction={() => undefined}
      onSettle={() => undefined}
      onSnooze={() => undefined}
      onUnsettle={() => undefined}
      onUnsnooze={() => undefined}
      onReleaseWorktree={() => undefined}
      worktreeLimit={4}
      managedWorktreeCount={0}
      onSettings={() => undefined}
    />,
  );

  assert.match(html, /data-sidebar-state="collapsed"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /inert=""/);
  assert.doesNotMatch(html, /data-sidebar-collapse-toggle/);
});

test("empty project inbox offers a discoverable new conversation action", () => {
  const html = renderToStaticMarkup(
    <CodeSidebar
      product="code"
      onProductChange={() => undefined}
      repository={null}
      projects={[
        {
          id: "project-1",
          name: "Aldunis Code",
          root: "/workspace/aldunis-code",
          openedAt: "2026-08-04T00:00:00.000Z",
        },
      ]}
      projectFilter="all"
      onProjectFilterChange={() => undefined}
      onAddProject={() => undefined}
      onSelectProject={() => undefined}
      changes={[]}
      onShowChanges={() => undefined}
      onBrowseFiles={() => undefined}
      onOpenPalette={() => undefined}
      conversations={[]}
      primaryConversationId={null}
      secondaryConversationId={null}
      onOpenConversation={() => undefined}
      onOpenBeside={() => undefined}
      onNewConversation={() => undefined}
      onSelectWorktree={() => undefined}
      onManageWorktrees={() => undefined}
      showingArchived={false}
      onToggleArchived={() => undefined}
      onConversationAction={() => undefined}
      onSettle={() => undefined}
      onSnooze={() => undefined}
      onUnsettle={() => undefined}
      onUnsnooze={() => undefined}
      onReleaseWorktree={() => undefined}
      worktreeLimit={4}
      managedWorktreeCount={0}
      onSettings={() => undefined}
    />,
  );

  assert.match(html, /class="empty-list-action"/);
  assert.match(html, />New conversation<\/button>/);
});
