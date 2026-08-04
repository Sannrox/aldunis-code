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
      onUnsettle={() => undefined}
      onReleaseWorktree={() => undefined}
      worktreeLimit={4}
      managedWorktreeCount={0}
      onSettings={() => undefined}
    />,
  );

  assert.match(
    html,
    /title="Restoring projects…" aria-label="New conversation" disabled=""/,
  );
  assert.match(html, /data-sidebar-state="expanded"/);
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
      onUnsettle={() => undefined}
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
