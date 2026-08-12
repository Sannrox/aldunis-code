import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleContextRoute, MAX_STAGE_IMAGE_BODY_BYTES } from "./context-routes.ts";
import { RepositoryError } from "./repository.ts";

const unused = async () => {
  throw new Error("dependency must not be called");
};

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function response(): ServerResponse {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    remote: false,
    managed: false,
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    operations: {},
    ...overrides,
  };
}

test("context module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleContextRoute(
      "/api/provider/capabilities",
      request(),
      response(),
      context() as never,
    ),
    false,
  );
});

test("context module searches through the selected worktree and propagates cancellation", async () => {
  const writes: unknown[] = [];
  const selections: unknown[] = [];
  const incoming = request();
  const outgoing = response();
  let signal: AbortSignal | undefined;
  assert.equal(
    await handleContextRoute(
      "/api/context/files",
      incoming,
      outgoing,
      context({
        readJson: async () => ({ root: "/repo", worktree: "/repo/wt", query: "route" }),
        selectWorktree: async (root: string, worktree: string) => {
          selections.push({ root, worktree });
          outgoing.emit("close");
          return { root: "/canonical", worktree: "/canonical/wt" };
        },
        operations: {
          searchRepositoryFiles: async (
            worktree: string,
            query: string,
            _limit?: number,
            receivedSignal?: AbortSignal,
          ) => {
            assert.equal(worktree, "/canonical/wt");
            assert.equal(query, "route");
            signal = receivedSignal;
            return ["server/context-routes.ts"];
          },
        },
        sendJson: (_response: ServerResponse, status: number, value: unknown) =>
          writes.push({ status, value }),
      }) as never,
    ),
    true,
  );
  assert.deepEqual(selections, [{ root: "/repo", worktree: "/repo/wt" }]);
  assert.deepEqual(writes, [{ status: 200, value: { files: ["server/context-routes.ts"] } }]);
  assert.equal(signal?.aborted, true);
});

test("context module propagates browse cancellation through its interface", async () => {
  const incoming = request();
  const outgoing = response();
  let signal: AbortSignal | undefined;
  await handleContextRoute(
    "/api/context/browse",
    incoming,
    outgoing,
    context({
      readJson: async () => ({ root: "/repo", worktree: "/repo/wt", query: "needle" }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      operations: {
        browseRepositoryFiles: async (
          _worktree: string,
          _query: string,
          receivedSignal?: AbortSignal,
        ) => {
          signal = receivedSignal;
          incoming.emit("aborted");
          return { files: [], truncated: false };
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.equal(signal?.aborted, true);
});

test("context module propagates unfinished package response cancellation", async () => {
  const incoming = request();
  const outgoing = response();
  let signal: AbortSignal | undefined;
  await handleContextRoute(
    "/api/context/package/preview",
    incoming,
    outgoing,
    context({
      readJson: async () => ({
        root: "/repo",
        worktree: "/repo/wt",
        pins: [{ path: "src", kind: "folder" }],
      }),
      selectWorktree: async () => {
        outgoing.emit("close");
        return { root: "/repo", worktree: "/repo/wt" };
      },
      operations: {
        assembleContextPackage: async (
          _worktree: string,
          pins: Array<{ path: string; kind: "file" | "folder" }>,
          options: { includeProviderInstructions?: boolean; signal?: AbortSignal },
        ) => {
          signal = options.signal;
          return {
            pins,
            entries: [],
            attachments: [],
            totalBytes: 0,
            estimatedTokens: 0,
            digest: "digest",
          };
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.equal(signal?.aborted, true);
});

test("context module denies remote absolute image paths before worktree or filesystem access", async () => {
  let maxBytes: number | undefined;
  await assert.rejects(
    handleContextRoute(
      "/api/context/stage-image",
      request(),
      response(),
      context({
        remote: true,
        readJson: async (_request: IncomingMessage, receivedMaxBytes?: number) => {
          maxBytes = receivedMaxBytes;
          return { root: "/repo", worktree: "/repo/wt", absolutePath: "/desktop/image.png" };
        },
      }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 403,
  );
  assert.equal(maxBytes, MAX_STAGE_IMAGE_BODY_BYTES);
});

test("context module denies remote folder pins before worktree selection", async () => {
  await assert.rejects(
    handleContextRoute(
      "/api/context/package/preview",
      request(),
      response(),
      context({
        remote: true,
        readJson: async () => ({
          root: "/repo",
          worktree: "/repo/wt",
          pins: [{ path: "src", kind: "folder" }],
        }),
      }) as never,
    ),
    (error: unknown) => error instanceof RepositoryError && error.status === 403,
  );
});

test("context module omits provider instructions for managed package previews", async () => {
  const writes: unknown[] = [];
  await handleContextRoute(
    "/api/context/package/preview",
    request(),
    response(),
    context({
      managed: true,
      readJson: async () => ({
        root: "/repo",
        worktree: "/repo/wt",
        pins: [{ path: "AGENTS.md", kind: "file" }],
      }),
      selectWorktree: async () => ({ root: "/repo", worktree: "/repo/wt" }),
      operations: {
        assembleContextPackage: async (
          _worktree: string,
          pins: Array<{ path: string; kind: "file" | "folder" }>,
          options: { includeProviderInstructions?: boolean; signal?: AbortSignal },
        ) => {
          assert.equal(options.includeProviderInstructions, false);
          assert.equal(options.signal?.aborted, false);
          return {
            pins,
            entries: [],
            attachments: [],
            totalBytes: 0,
            estimatedTokens: 0,
            digest: "digest",
          };
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(writes, [
    {
      status: 200,
      value: {
        package: {
          pins: [{ path: "AGENTS.md", kind: "file" }],
          entries: [],
          totalBytes: 0,
          estimatedTokens: 0,
          digest: "digest",
        },
      },
    },
  ]);
});
