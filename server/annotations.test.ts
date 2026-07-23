import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationView,
  captureAnnotationContext,
  formatRevisionContext,
  MAX_REVISION_ANNOTATIONS,
} from "./annotations.ts";
import type { FileDiff } from "./changes.ts";
import type { DiffAnnotation } from "./state.ts";

const diff: FileDiff = {
  path: "src/example.ts",
  previousPath: null,
  state: "modified",
  additions: 1,
  deletions: 1,
  identity: "identity-1",
  message: null,
  patch: "@@ -1,3 +1,3 @@\n one\n-two\n+three\n four",
  lines: [
    { index: 0, side: "metadata", oldLine: null, newLine: null, content: "@@ -1,3 +1,3 @@" },
    { index: 1, side: "context", oldLine: 1, newLine: 1, content: " one" },
    { index: 2, side: "deletion", oldLine: 2, newLine: null, content: "-two" },
    { index: 3, side: "addition", oldLine: null, newLine: 2, content: "+three" },
    { index: 4, side: "context", oldLine: 3, newLine: 3, content: " four" },
  ],
};

const annotation: DiffAnnotation = {
  schemaVersion: 1,
  id: "annotation-1",
  threadId: "thread-1",
  checkpointId: "checkpoint-1",
  diffIdentity: diff.identity,
  path: diff.path,
  previousPath: null,
  targetState: "modified",
  scope: "line",
  side: "addition",
  oldLine: null,
  newLine: 2,
  text: "Keep the old behavior configurable.",
  capturedContext: captureAnnotationContext(diff, 3),
  resolution: "unresolved",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

test("annotation context is bounded around the selected diff line", () => {
  assert.match(annotation.capturedContext, /-two\n\+three/);
  assert.equal(annotation.capturedContext.split("\n").length <= 7, true);
  assert.throws(() => captureAnnotationContext(diff, 0), /commentable diff line/);
});

test("annotations become explicitly stale instead of moving to another diff", () => {
  assert.equal(annotationView(annotation, diff).stale, false);
  const stale = annotationView(annotation, { ...diff, identity: "identity-2" });
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason ?? "", /diff changed/);
  assert.equal(annotationView(annotation, null).stale, true);
});

test("revision context is structured, exact, and bounded", () => {
  const prompt = formatRevisionContext([annotationView(annotation, diff)]);
  assert.match(prompt, /<review_comment/);
  assert.match(prompt, /path="src\/example.ts"/);
  assert.match(prompt, /target="new line 2"/);
  assert.match(prompt, /Keep the old behavior configurable/);
  assert.match(prompt, /```diff/);
  assert.throws(
    () => formatRevisionContext(Array.from(
      { length: MAX_REVISION_ANNOTATIONS + 1 },
      () => annotationView(annotation, diff),
    )),
    /Select between 1 and/,
  );
});
