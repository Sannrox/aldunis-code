import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { commandPaletteThreadMatches } from "./command-palette";
import type { ThreadMetadata } from "../../types";

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
