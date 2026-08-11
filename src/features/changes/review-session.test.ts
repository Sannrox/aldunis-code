import assert from "node:assert/strict";
import test from "node:test";
import type { ChangedFile, DiffAnnotation, FileDiff } from "../../types";
import {
  initialChangedFileReview,
  transitionChangedFileReview,
  type ChangedFileReviewState,
} from "./review-session";

const files = (paths: string[]): ChangedFile[] =>
  paths.map((path) => ({
    path,
    previousPath: null,
    state: "modified",
    additions: 1,
    deletions: 1,
  }));

const diff = (path: string): FileDiff =>
  ({
    path,
    previousPath: null,
    identity: `identity-${path}`,
    state: "modified",
    additions: 1,
    deletions: 1,
    message: null,
    patch: "",
    lines: [],
  }) as FileDiff;

const annotation = (id: string): DiffAnnotation => ({ id }) as DiffAnnotation;

test("review session repairs selection and suppresses stale diff completions", () => {
  let state = initialChangedFileReview(files(["a.ts", "b.ts"]));
  state = transitionChangedFileReview(state, { type: "select_file", path: "b.ts" });
  state = transitionChangedFileReview(state, { type: "repair_selection", files: files(["c.ts"]) });
  assert.equal(state.selected, "c.ts");
  state = transitionChangedFileReview(state, { type: "diff_loading", request: 2 });
  state = transitionChangedFileReview(state, {
    type: "diff_loaded",
    request: 1,
    diff: diff("old.ts"),
  });
  assert.equal(state.diff, null);
  state = transitionChangedFileReview(state, {
    type: "diff_loaded",
    request: 2,
    diff: diff("c.ts"),
  });
  assert.equal(state.diff?.path, "c.ts");
});

test("review session repairs annotation selection and ignores stale annotation loads", () => {
  let state: ChangedFileReviewState = {
    ...initialChangedFileReview(files(["a.ts"])),
    selectedAnnotationIds: ["keep", "drop"],
  };
  state = transitionChangedFileReview(state, { type: "annotations_loading", request: 4 });
  state = transitionChangedFileReview(state, {
    type: "annotations_loaded",
    request: 3,
    annotations: [annotation("drop")],
  });
  assert.deepEqual(state.selectedAnnotationIds, ["keep", "drop"]);
  state = transitionChangedFileReview(state, {
    type: "annotations_loaded",
    request: 4,
    annotations: [annotation("keep")],
  });
  assert.deepEqual(state.selectedAnnotationIds, ["keep"]);
});

test("review session dismisses revision before comment and resets read-only state", () => {
  let state = initialChangedFileReview(files(["a.ts"]));
  state = transitionChangedFileReview(state, { type: "open_comment", lineIndex: 3 });
  state = transitionChangedFileReview(state, { type: "set_comment_text", text: "Consider this" });
  state = transitionChangedFileReview(state, { type: "show_revision", prompt: "Apply comments" });
  state = transitionChangedFileReview(state, { type: "dismiss_nested" });
  assert.equal(state.revisionPreview, null);
  assert.equal(state.commentLineIndex, 3);
  state = transitionChangedFileReview(state, { type: "dismiss_nested" });
  assert.equal(state.commentLineIndex, undefined);
  assert.equal(state.commentText, "");
  state = transitionChangedFileReview(
    { ...state, annotations: [annotation("a")], selectedAnnotationIds: ["a"] },
    { type: "reset_read_only" },
  );
  assert.deepEqual(state.annotations, []);
  assert.deepEqual(state.selectedAnnotationIds, []);
});
