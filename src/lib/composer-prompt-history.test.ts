import assert from "node:assert/strict";
import test from "node:test";
import {
  draftForPromptHistoryIndex,
  isComposerHistoryBoundary,
  livePromptHistoryIndex,
  promptHistoryFromMessages,
  resetPromptHistoryBrowse,
  stepPromptHistoryDown,
  stepPromptHistoryUp,
} from "./composer-prompt-history";

test("promptHistoryFromMessages trims, skips empties, drops consecutive dupes, caps length", () => {
  assert.deepEqual(promptHistoryFromMessages([]), []);
  assert.deepEqual(
    promptHistoryFromMessages([
      { text: "  first  " },
      { text: "" },
      { text: "first" },
      { text: "second" },
      { text: "second" },
      { text: "third" },
    ]),
    ["first", "second", "third"],
  );
  const many = Array.from({ length: 60 }, (_, i) => ({ text: `p${i}` }));
  const capped = promptHistoryFromMessages(many, 50);
  assert.equal(capped.length, 50);
  assert.equal(capped[0], "p10");
  assert.equal(capped[49], "p59");
});

test("isComposerHistoryBoundary requires collapsed caret at position 0", () => {
  assert.equal(isComposerHistoryBoundary({ value: "", selectionStart: 0, selectionEnd: 0 }), true);
  assert.equal(isComposerHistoryBoundary({ value: "hello", selectionStart: 0, selectionEnd: 0 }), true);
  assert.equal(isComposerHistoryBoundary({ value: "hello", selectionStart: 2, selectionEnd: 2 }), false);
  assert.equal(isComposerHistoryBoundary({ value: "hello", selectionStart: 0, selectionEnd: 2 }), false);
  assert.equal(isComposerHistoryBoundary({ value: "ab\ncd", selectionStart: 3, selectionEnd: 3 }), false);
});

test("↑ from live draft loads newest; further ↑ walks older; ↓ restores draft", () => {
  const entries = promptHistoryFromMessages([
    { text: "oldest" },
    { text: "mid" },
    { text: "newest" },
  ]);
  let browse = resetPromptHistoryBrowse(entries);
  assert.equal(browse.index, livePromptHistoryIndex(entries));

  const up1 = stepPromptHistoryUp(entries, browse, "in progress");
  assert.ok(up1);
  assert.equal(up1.index, 2);
  assert.equal(up1.draftBeforeHistory, "in progress");
  assert.equal(draftForPromptHistoryIndex(entries, up1), "newest");
  browse = up1;

  const up2 = stepPromptHistoryUp(entries, browse, "newest");
  assert.ok(up2);
  assert.equal(draftForPromptHistoryIndex(entries, up2), "mid");
  browse = up2;

  const up3 = stepPromptHistoryUp(entries, browse, "mid");
  assert.ok(up3);
  assert.equal(draftForPromptHistoryIndex(entries, up3), "oldest");
  browse = up3;

  assert.equal(stepPromptHistoryUp(entries, browse, "oldest"), null);

  const down1 = stepPromptHistoryDown(entries, browse);
  assert.ok(down1);
  assert.equal(draftForPromptHistoryIndex(entries, down1), "mid");
  browse = down1;

  const down2 = stepPromptHistoryDown(entries, browse);
  assert.ok(down2);
  assert.equal(draftForPromptHistoryIndex(entries, down2), "newest");
  browse = down2;

  const down3 = stepPromptHistoryDown(entries, browse);
  assert.ok(down3);
  assert.equal(down3.index, 3);
  assert.equal(draftForPromptHistoryIndex(entries, down3), "in progress");

  assert.equal(stepPromptHistoryDown(entries, down3), null);
});

test("↑ with empty history is a no-op; empty live draft still captures draftBeforeHistory", () => {
  assert.equal(stepPromptHistoryUp([], resetPromptHistoryBrowse([]), "x"), null);
  const entries = ["only"];
  const stepped = stepPromptHistoryUp(entries, resetPromptHistoryBrowse(entries), "");
  assert.ok(stepped);
  assert.equal(stepped.draftBeforeHistory, "");
  assert.equal(draftForPromptHistoryIndex(entries, stepped), "only");
});
