import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CommandPalette,
  commandPaletteThreadMatches,
  PROVIDER_MANAGEMENT_ACTION_COPY,
} from "./command-palette";
import type { ThreadMetadata } from "../../types";

test("command palette exposes one generic provider management action", () => {
  const html = renderToStaticMarkup(
    <CommandPalette
      open
      onClose={() => undefined}
      onOpenRepository={() => undefined}
      onSearch={() => undefined}
      onPreferences={() => undefined}
      onProviderManagement={() => undefined}
      onManageWorktrees={() => undefined}
      onAutomations={() => undefined}
      onAutonomy={() => undefined}
    />,
  );

  assert.match(html, /Provider management/);
  assert.match(html, /Profiles, adapter package trust, and readiness diagnostics/);
  assert.doesNotMatch(html, /Provider settings/);
  assert.doesNotMatch(html, /Provider adapters/);
  assert.deepEqual(PROVIDER_MANAGEMENT_ACTION_COPY, {
    label: "Provider management",
    detail: "Profiles, adapter package trust, and readiness diagnostics",
  });
});

const thread: ThreadMetadata = {
  id: "thread-1",
  projectId: "project-1",
  title: "Fix pairing flow",
  worktree: "/tmp/aldunis-code",
  updatedAt: "2026-08-04T12:00:00.000Z",
  projectName: "Aldunis Code",
  provider: "codex-cli",
  pinnedAt: null,
  archivedAt: null,
};

test("command palette matches bounded conversation metadata only when queried", () => {
  assert.equal(commandPaletteThreadMatches(thread, "pairing"), true);
  assert.equal(commandPaletteThreadMatches(thread, "aldunis-code"), true);
  assert.equal(commandPaletteThreadMatches(thread, "provider output"), false);
  assert.equal(commandPaletteThreadMatches(thread, ""), false);
});
