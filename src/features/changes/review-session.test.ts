import assert from "node:assert/strict";
import test from "node:test";
import type { ChangedFile, DiffAnnotation, FileDiff } from "../../types";
import {
  initialChangedFileReview,
  LatestReviewDiffCoordinator,
  transitionChangedFileReview,
  type ChangedFileReviewState,
} from "./review-session";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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

test("review diff coordinator runs one request and retains only the latest follow-up", async () => {
  const first = deferred<string>();
  const latest = deferred<string>();
  const started: string[] = [];
  const loaded: string[] = [];
  const coordinator = new LatestReviewDiffCoordinator(
    (input: string) => {
      started.push(input);
      return input === "first" ? first.promise : latest.promise;
    },
    (input, output) => loaded.push(`${input}:${output}`),
    () => assert.fail("request should not fail"),
  );

  coordinator.request("first");
  coordinator.request("superseded");
  coordinator.request("latest");
  assert.deepEqual(started, ["first"]);
  first.resolve("old");
  await settle();
  assert.deepEqual(started, ["first", "latest"]);
  assert.deepEqual(loaded, ["first:old"]);
  latest.resolve("new");
  await settle();
  assert.deepEqual(loaded, ["first:old", "latest:new"]);
});

test("review diff coordinator releases failures and suppresses disposed work", async () => {
  const first = deferred<string>();
  const latest = deferred<string>();
  const started: string[] = [];
  const failed: string[] = [];
  const loaded: string[] = [];
  const coordinator = new LatestReviewDiffCoordinator(
    (input: string) => {
      started.push(input);
      return input === "first" ? first.promise : latest.promise;
    },
    (input) => loaded.push(input),
    (input) => failed.push(input),
  );

  coordinator.request("first");
  coordinator.request("latest");
  first.reject(new Error("failed"));
  await settle();
  assert.deepEqual(failed, ["first"]);
  assert.deepEqual(started, ["first", "latest"]);
  coordinator.dispose();
  latest.resolve("ignored");
  await settle();
  assert.deepEqual(loaded, []);
  coordinator.request("after-dispose");
  assert.deepEqual(started, ["first", "latest"]);
});
