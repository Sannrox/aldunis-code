import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  commandPaletteThreadMatches,
  MAX_COMMAND_PALETTE_THREAD_RESULTS,
  PROVIDER_MANAGEMENT_ACTION_COPY,
  selectCommandPaletteThreads,
} from "./command-palette";
import type { ThreadMetadata } from "../../types";

test("command palette keeps one generic provider management action copy", () => {
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

test("command palette retains only the first bounded thread quick actions", () => {
  const threads = Array.from({ length: 100 }, (_, index) => ({
    ...thread,
    id: `thread-${index}`,
    title: `Matching conversation ${index}`,
  }));
  const inventory = new Proxy(threads, {
    get(target, property, receiver) {
      if (
        property === "filter" ||
        property === "map" ||
        property === "slice" ||
        property === "sort"
      ) {
        throw new Error(`thread inventory must not call ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const selected = selectCommandPaletteThreads(inventory, "matching");

  assert.equal(selected.length, MAX_COMMAND_PALETTE_THREAD_RESULTS);
  assert.deepEqual(
    selected.map((item) => item.id),
    Array.from({ length: MAX_COMMAND_PALETTE_THREAD_RESULTS }, (_, index) => `thread-${index}`),
  );
  assert.deepEqual(selectCommandPaletteThreads(inventory, "matching", 0), []);
  assert.deepEqual(selectCommandPaletteThreads(inventory, "does-not-exist"), []);
});

test("command palette empty status stays outside the action listbox", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "command-palette.tsx"),
    "utf8",
  );
  assert.match(source, /id="command-palette-empty"/);
  assert.match(source, /className="quick-results-empty"/);
  assert.match(source, /role="status"/);
  const listboxIndex = source.indexOf('role="listbox"');
  const emptyIndex = source.indexOf("No matching actions.");
  assert.notEqual(listboxIndex, -1);
  assert.notEqual(emptyIndex, -1);
  assert.ok(emptyIndex < listboxIndex, "empty status must render before the listbox");
  assert.doesNotMatch(
    source.slice(listboxIndex),
    /No matching actions/,
    "listbox must not contain the empty-status paragraph",
  );
});
