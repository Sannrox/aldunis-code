import assert from "node:assert/strict";
import test from "node:test";
import {
  clearComposerDraft,
  composerDraftKey,
  COMPOSER_DRAFT_MAX_CHARS,
  COMPOSER_DRAFT_STORAGE_KEY,
  loadComposerDraft,
  saveComposerDraft,
  type StorageLike,
} from "./composer-draft-stash";

function memoryStorage(
  seed: Record<string, string> = {},
): StorageLike & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem(key) {
      return key in data ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

test("composerDraftKey separates threads from new-chat panes", () => {
  assert.equal(
    composerDraftKey({ conversationId: "t1", projectId: "p1", pane: "primary" }),
    "thread:t1",
  );
  assert.equal(
    composerDraftKey({ conversationId: null, projectId: "p1", pane: "secondary" }),
    "new:p1:secondary",
  );
});

test("save/load/clear drafts with empty text removal", () => {
  const storage = memoryStorage();
  saveComposerDraft(storage, "thread:a", "hello");
  assert.equal(loadComposerDraft(storage, "thread:a")?.text, "hello");
  saveComposerDraft(storage, "thread:a", "   ");
  assert.equal(loadComposerDraft(storage, "thread:a"), null);
  assert.equal(storage.getItem(COMPOSER_DRAFT_STORAGE_KEY), null);
  saveComposerDraft(storage, "thread:a", "again");
  clearComposerDraft(storage, "thread:a");
  assert.equal(loadComposerDraft(storage, "thread:a"), null);
});

test("draft text is capped and corrupt storage is ignored", () => {
  const storage = memoryStorage();
  saveComposerDraft(storage, "thread:big", "x".repeat(COMPOSER_DRAFT_MAX_CHARS + 50));
  assert.equal(loadComposerDraft(storage, "thread:big")?.text.length, COMPOSER_DRAFT_MAX_CHARS);
  storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, "{not-json");
  assert.deepEqual(loadComposerDraft(storage, "thread:big"), null);
});
