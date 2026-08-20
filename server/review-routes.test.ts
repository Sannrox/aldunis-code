import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleReviewRoute } from "./review-routes.ts";
import { RepositoryError } from "./repository.ts";
import type { LocalStateStore, StateProjection } from "./state.ts";

const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as IncomingMessage;
const response = Object.assign(new EventEmitter(), {
  destroyed: false,
  writableEnded: false,
}) as unknown as ServerResponse;
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
    changes: { listChangedFiles: unused, listChangedFilesPage: unused, readFileDiff: unused },
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
        listChangedFiles: unused,
        listChangedFilesPage: async (worktree: string) => {
          assert.equal(worktree, "/canonical/wt");
          return { files, truncated: false };
        },
        readFileDiff: unused,
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }),
  );

  assert.equal(handled, true);
  assert.deepEqual(writes, [{ status: 200, value: { files, truncated: false } }]);
});

test("changed-file listing cancels disconnected requests and releases listeners", async () => {
  const input = Object.assign(new EventEmitter(), {
    aborted: false,
  }) as unknown as IncomingMessage;
  const output = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as ServerResponse;
  let started = false;
  const handling = handleReviewRoute(
    "/api/changes",
    input,
    output,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      changes: {
        listChangedFiles: unused,
        listChangedFilesPage: async (_worktree: string, signal: AbortSignal) => {
          started = true;
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { files: [], truncated: false };
        },
        readFileDiff: unused,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  output.emit("close");
  await assert.rejects(handling, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(input.listenerCount("aborted"), 0);
  assert.equal(output.listenerCount("close"), 0);
});

test("single-file diff inspection cancels disconnected requests and releases listeners", async () => {
  const input = Object.assign(new EventEmitter(), {
    aborted: false,
  }) as unknown as IncomingMessage;
  const output = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as ServerResponse;
  let started = false;
  const handling = handleReviewRoute(
    "/api/changes/diff",
    input,
    output,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/wt", path: "src/main.ts" }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      changes: {
        listChangedFiles: unused,
        listChangedFilesPage: unused,
        readFileDiff: async (
          _worktree: string,
          _path: string,
          _inventory: unknown,
          signal: AbortSignal,
        ) => {
          started = true;
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          throw new Error("unreachable");
        },
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  output.emit("close");
  await assert.rejects(handling, (error: unknown) => (error as Error).name === "AbortError");
  assert.equal(input.listenerCount("aborted"), 0);
  assert.equal(output.listenerCount("close"), 0);
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

test("annotation routes reuse one changed-file inventory per multi-diff request", async () => {
  const changedFiles = [
    {
      path: "src/first.ts",
      previousPath: null,
      state: "modified" as const,
      additions: 1,
      deletions: 0,
    },
    {
      path: "src/second.ts",
      previousPath: null,
      state: "modified" as const,
      additions: 2,
      deletions: 1,
    },
  ];
  const annotation = (id: string, path: string) => ({
    schemaVersion: 2 as const,
    id,
    threadId: "thread-1",
    checkpointId: null,
    diffIdentity: `identity-${id}`,
    path,
    previousPath: null,
    targetState: "modified" as const,
    scope: "file" as const,
    side: null,
    oldLine: null,
    newLine: null,
    text: `Review ${path}`,
    capturedContext: "+changed",
    resolution: "unresolved" as const,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  const projection = {
    projects: [{ id: "project-1", root: "/repo" }],
    threads: [{ id: "thread-1", projectId: "project-1", worktree: "/repo/wt" }],
    annotations: [annotation("first", "src/first.ts"), annotation("second", "src/second.ts")],
    checkpoints: [],
  } as unknown as StateProjection;
  let inventoryReads = 0;
  const diffReads: string[] = [];
  const writes: Array<{ status: number; value: unknown }> = [];

  await handleReviewRoute(
    "/api/annotations/list",
    request,
    response,
    context({
      readJson: async () => ({
        root: "/repo",
        worktree: "/repo/wt",
        threadId: "thread-1",
        annotationIds: ["first", "second"],
      }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      state: {
        inspect: async () => projection,
        saveAnnotation: unused,
        setAnnotationResolution: unused,
        setFileReview: unused,
      },
      changes: {
        listChangedFiles: async () => {
          inventoryReads += 1;
          return changedFiles;
        },
        readFileDiff: async (_worktree: string, path: string, inventory: unknown) => {
          assert.equal(inventory, changedFiles);
          diffReads.push(path);
          const change = changedFiles.find((item) => item.path === path)!;
          return {
            ...change,
            identity: `identity-${path.includes("first") ? "first" : "second"}`,
            lines: [],
            patch: "+changed",
            message: null,
          };
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }),
  );

  assert.equal(inventoryReads, 1);
  assert.deepEqual(diffReads, ["src/first.ts", "src/second.ts"]);
  assert.equal(writes[0]?.status, 200);
  assert.deepEqual(
    (writes[0]?.value as { annotations: Array<{ stale: boolean }> }).annotations.map(
      (item) => item.stale,
    ),
    [false, false],
  );

  await handleReviewRoute(
    "/api/annotations/preview",
    request,
    response,
    context({
      readJson: async () => ({
        root: "/repo",
        worktree: "/repo/wt",
        threadId: "thread-1",
        annotationIds: ["first", "second"],
      }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      state: {
        inspect: async () => projection,
        saveAnnotation: unused,
        setAnnotationResolution: unused,
        setFileReview: unused,
      },
      changes: {
        listChangedFiles: async () => {
          inventoryReads += 1;
          return changedFiles;
        },
        readFileDiff: async (_worktree: string, path: string, inventory: unknown) => {
          assert.equal(inventory, changedFiles);
          diffReads.push(path);
          const change = changedFiles.find((item) => item.path === path)!;
          return {
            ...change,
            identity: `identity-${path.includes("first") ? "first" : "second"}`,
            lines: [],
            patch: "+changed",
            message: null,
          };
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }),
  );

  assert.equal(inventoryReads, 2);
  assert.deepEqual(diffReads, ["src/first.ts", "src/second.ts", "src/first.ts", "src/second.ts"]);
  assert.equal(writes[1]?.status, 200);
});
