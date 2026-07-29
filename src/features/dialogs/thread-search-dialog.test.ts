import assert from "node:assert/strict";
import test from "node:test";
import {
  activeThreadSearchResult,
  clampThreadSearchIndex,
  nextThreadSearchIndex,
  threadSearchActiveDescendant,
} from "./thread-search-dialog";

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
