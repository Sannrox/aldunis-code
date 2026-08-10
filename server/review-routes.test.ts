import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleReviewRoute } from "./review-routes.ts";
import { RepositoryError } from "./repository.ts";
import type { LocalStateStore, StateProjection } from "./state.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      inspect: unused,
      saveAnnotation: unused,
      setAnnotationResolution: unused,
      setFileReview: unused,
    } as unknown as Pick<
      LocalStateStore,
      "inspect" | "saveAnnotation" | "setAnnotationResolution" | "setFileReview"
    >,
    changes: { listChangedFiles: unused, readFileDiff: unused },
    managed: false,
    assertManagedThread: () => assert.fail("managed thread must not be checked"),
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("review route module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleReviewRoute("/api/delivery/inspect", request, response, context()),
    false,
  );
});

test("review route module lists changes through the selected worktree", async () => {
  const writes: Array<{ status: number; value: unknown }> = [];
  const files = [
    {
      path: "src/main.ts",
      previousPath: null,
      state: "modified" as const,
      additions: 2,
      deletions: 1,
    },
  ];
  const handled = await handleReviewRoute(
    "/api/changes",
    request,
    response,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/canonical/wt" }),
      changes: {
        listChangedFiles: async (worktree: string) => {
          assert.equal(worktree, "/canonical/wt");
          return files;
        },
        readFileDiff: unused,
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }),
  );

  assert.equal(handled, true);
  assert.deepEqual(writes, [{ status: 200, value: { files } }]);
});

test("review route module rejects annotation creation after the diff identity changes", async () => {
  const projection = {
    projects: [{ id: "project-1", root: "/repo" }],
    threads: [{ id: "thread-1", projectId: "project-1", worktree: "/repo/wt" }],
    annotations: [],
    checkpoints: [],
  } as unknown as StateProjection;

  await assert.rejects(
    handleReviewRoute(
      "/api/annotations/create",
      request,
      response,
      context({
        readJson: async () => ({
          root: "/repo",
          worktree: "/repo/wt",
          threadId: "thread-1",
          path: "src/main.ts",
          diffIdentity: "stale",
          scope: "file",
          text: "Check this.",
        }),
        selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
        state: {
          inspect: async () => projection,
          saveAnnotation: unused,
          setAnnotationResolution: unused,
          setFileReview: unused,
        },
        changes: {
          listChangedFiles: unused,
          readFileDiff: async () => ({
            path: "src/main.ts",
            previousPath: null,
            state: "modified" as const,
            additions: 1,
            deletions: 0,
            identity: "current",
            lines: [],
            patch: "+changed",
            message: null,
          }),
        },
      }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 409 &&
      error.message ===
        "The diff changed before the annotation was saved. Refresh and select it again.",
  );
});
