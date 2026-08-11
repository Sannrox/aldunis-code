import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  handleConversationForkRoute,
  type ConversationForkRouteContext,
} from "./conversation-fork-routes.ts";
import { LocalStateError, type StateProjection } from "./state.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(
  overrides: Partial<ConversationForkRouteContext> = {},
): ConversationForkRouteContext {
  return {
    state: { inspect: unused, previewFork: unused, createFork: unused } as never,
    worktrees: { list: unused } as never,
    profiles: { runtime: unused } as never,
    codex: { readiness: unused, models: unused } as never,
    shikigami: { readiness: unused, models: unused } as never,
    adapters: { get: unused } as never,
    managed: false,
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("conversation fork module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleConversationForkRoute("/api/state/search", request, response, context()),
    false,
  );
});

test("conversation fork module rejects managed hosts before reading request data", async () => {
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/preview",
      request,
      response,
      context({ managed: true }),
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
});

test("conversation fork preview enforces the reviewed context limit", async () => {
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/preview",
      request,
      response,
      context({
        readJson: async () => ({ sourceThreadId: "thread-1" }),
        state: {
          inspect: unused,
          createFork: unused,
          previewFork: async () => ({ byteCount: 64 * 1024 + 1 }),
        } as never,
      }),
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 413,
  );
});

test("conversation fork creation requires a distinct managed worktree", async () => {
  const projection = {
    projects: [{ id: "project-1", root: "/repo" }],
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        worktree: "/repo/source",
        workspaceMode: "aldunis-managed",
      },
    ],
  } as unknown as StateProjection;
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/create",
      request,
      response,
      context({
        readJson: async () => ({
          sourceThreadId: "thread-1",
          provider: "claude-code",
          profileId: "profile-1",
          model: "default",
          expectedDigest: "digest",
        }),
        state: {
          inspect: async () => projection,
          previewFork: unused,
          createFork: unused,
        } as never,
        selectWorktree: async (root, worktree) => ({ root, worktree }),
      }),
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
});

test("conversation fork creation validates and persists through one interface", async () => {
  const writes: Array<{ status: number; value: unknown }> = [];
  const created = { thread: { id: "thread-2" }, fork: { id: "fork-1" } };
  const projection = {
    projects: [{ id: "project-1", root: "/repo" }],
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        worktree: "/repo/worktree",
        workspaceMode: "shared",
      },
    ],
  } as unknown as StateProjection;
  let persisted: unknown;

  const handled = await handleConversationForkRoute(
    "/api/forks/create",
    request,
    response,
    context({
      readJson: async () => ({
        sourceThreadId: "thread-1",
        provider: "claude-code",
        profileId: "profile-1",
        model: "default",
        expectedDigest: "digest",
      }),
      state: {
        inspect: async () => projection,
        previewFork: unused,
        createFork: async (input: unknown) => {
          persisted = input;
          return created;
        },
      } as never,
      profiles: {
        runtime: async () => ({ profile: { provider: "claude-code" } }),
      } as never,
      selectWorktree: async (root, worktree) => ({ root, worktree }),
      sendJson: (_response, status, value) => writes.push({ status, value }),
    }),
  );

  assert.equal(handled, true);
  assert.deepEqual(persisted, {
    sourceThreadId: "thread-1",
    provider: "claude-code",
    profileId: "profile-1",
    model: "default",
    worktree: "/repo/worktree",
    destinationWorktree: "/repo/worktree",
    workspaceMode: "shared",
    expectedDigest: "digest",
  });
  assert.deepEqual(writes, [{ status: 201, value: created }]);
});
