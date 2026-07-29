import assert from "node:assert/strict";
import test from "node:test";
import {
  activeThreadSearchResult,
  clampThreadSearchIndex,
  nextThreadSearchIndex,
  threadSearchActiveDescendant,
  threadSearchDetail,
} from "./thread-search-dialog";
import type { ThreadMetadata } from "../../types";

const thread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Repeated prompt",
  worktree: "/tmp/project",
  updatedAt: "2026-07-29T16:21:34.000Z",
  projectName: "aldunis-code",
  provider: "codex-cli",
  pinnedAt: null,
  archivedAt: null,
} satisfies ThreadMetadata;

test("conversation search detail includes exact updated recency", () => {
  assert.equal(
    threadSearchDetail(thread, (date) => date.toISOString()),
    "aldunis-code · Codex · Updated 2026-07-29T16:21:34.000Z · /tmp/project",
  );
});

test("conversation search detail exposes pinned and archived lifecycle state", () => {
  assert.match(
    threadSearchDetail({ ...thread, pinnedAt: "2026-07-29T16:00:00.000Z" }, () => "now"),
    /Codex · Pinned · Updated now/,
  );
  assert.match(
    threadSearchDetail({
      ...thread,
      pinnedAt: "2026-07-29T16:00:00.000Z",
      archivedAt: "2026-07-29T16:10:00.000Z",
    }, () => "now"),
    /Codex · Archived · Updated now/,
  );
});

test("conversation search detail survives malformed persisted update times", () => {
  assert.match(
    threadSearchDetail({ ...thread, updatedAt: "not-a-date" }),
    /Codex · Updated time unknown/,
  );
});

test("conversation search cycles its active result in both directions", () => {
  assert.equal(nextThreadSearchIndex(0, 3, "next"), 1);
  assert.equal(nextThreadSearchIndex(2, 3, "next"), 0);
  assert.equal(nextThreadSearchIndex(0, 3, "previous"), 2);
  assert.equal(nextThreadSearchIndex(2, 3, "previous"), 1);
});

test("conversation search safely clamps changing and empty result sets", () => {
  assert.equal(clampThreadSearchIndex(4, 2), 1);
  assert.equal(clampThreadSearchIndex(1, 2), 1);
  assert.equal(clampThreadSearchIndex(4, 0), 0);
  assert.equal(nextThreadSearchIndex(0, 0, "next"), 0);
  assert.equal(nextThreadSearchIndex(0, 0, "previous"), 0);
});

test("conversation search exposes only a real active result", () => {
  assert.equal(threadSearchActiveDescendant(0, 1), "thread-search-result-0");
  assert.equal(threadSearchActiveDescendant(2, 3), "thread-search-result-2");
  assert.equal(threadSearchActiveDescendant(0, 0), undefined);
});

test("conversation search cannot select stale results while filtering", () => {
  const results = [{ id: "old-result" }] as never[];
  assert.equal(activeThreadSearchResult(results, 0, true), undefined);
  assert.equal(activeThreadSearchResult(results, 0, false)?.id, "old-result");
});
