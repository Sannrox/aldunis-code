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
});
