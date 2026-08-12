import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  handleConversationForkRoute,
  type ConversationForkRouteContext,
} from "./conversation-fork-routes.ts";
import { LocalStateError } from "./state.ts";

const request = new EventEmitter() as IncomingMessage;
const response = Object.assign(new EventEmitter(), { writableEnded: false }) as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Partial<ConversationForkRouteContext> = {}) {
  return {
    state: { inspect: unused, previewFork: unused, createFork: unused },
    worktrees: { list: unused },
    profiles: { runtime: unused },
    codex: { readiness: unused },
    shikigami: { readiness: unused },
    adapters: { version: unused, resolveExecutable: unused },
    managed: false,
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  } as unknown as ConversationForkRouteContext;
}

test("conversation fork route module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleConversationForkRoute("/api/state/load", request, response, context()),
    false,
  );
});

test("managed hosts reject fork preview before reading request data", async () => {
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/preview",
      request,
      response,
      context({ managed: true }),
    ),
    (error: unknown) =>
      error instanceof LocalStateError &&
      error.status === 403 &&
      error.message === "Conversation forks are unavailable in managed hosted mode.",
  );
});

test("fork preview rejects manifests over the reviewed size cap", async () => {
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

test("fork creation validates the provider and profile matrix before state access", async () => {
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/create",
      request,
      response,
      context({
        readJson: async () => ({
          sourceThreadId: "thread-1",
          provider: "codex-cli",
          profileId: "not-allowed",
          model: "default",
          expectedDigest: "digest",
        }),
      }),
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
});

test("managed-worktree forks reject a destination already bound to a conversation", async () => {
  await assert.rejects(
    handleConversationForkRoute(
      "/api/forks/create",
      request,
      response,
      context({
        readJson: async () => ({
          sourceThreadId: "source",
          provider: "claude-code",
          profileId: "default:claude-code",
          model: "default",
          expectedDigest: "digest",
          worktree: "/repo/fork",
          workspaceMode: "aldunis-managed",
        }),
        state: {
          previewFork: unused,
          createFork: unused,
          inspect: async () => ({
            projects: [{ id: "project", root: "/repo" }],
            threads: [
              {
                id: "source",
                projectId: "project",
                worktree: "/repo/source",
                workspaceMode: "aldunis-managed",
              },
              { id: "other", projectId: "project", worktree: "/repo/fork" },
            ],
          }),
        } as never,
        selectWorktree: async (root, worktree) => ({ root, worktree }),
        worktrees: {
          list: async () => [{ path: "/repo/fork", ownership: "aldunis", recovery: "available" }],
        } as never,
      }),
    ),
    (error: unknown) =>
      error instanceof LocalStateError &&
      error.status === 409 &&
      error.message === "The fork destination worktree is already bound to another conversation.",
  );
});

test("fork creation persists reviewed provider and workspace choices through one interface", async () => {
  const writes: Array<{ status: number; value: unknown }> = [];
  const created = { thread: { id: "fork" }, fork: { id: "manifest" } };
  let persisted: unknown;
  const handled = await handleConversationForkRoute(
    "/api/forks/create",
    request,
    response,
    context({
      readJson: async () => ({
        sourceThreadId: "source",
        provider: "claude-code",
        profileId: "default:claude-code",
        model: "default",
        expectedDigest: "digest",
      }),
      state: {
        previewFork: unused,
        inspect: async () => ({
          projects: [{ id: "project", root: "/repo" }],
          threads: [
            {
              id: "source",
              projectId: "project",
              worktree: "/repo/shared",
              workspaceMode: "shared",
            },
          ],
        }),
        createFork: async (input: unknown) => {
          persisted = input;
          return created;
        },
      } as never,
      profiles: {
        runtime: async () => ({
          profile: { provider: "claude-code" },
          executable: "claude",
          environment: {},
          configPath: "",
          continuationKey: "claude:default",
        }),
      } as never,
      selectWorktree: async (root, worktree) => ({ root, worktree }),
      sendJson: (_response, status, value) => writes.push({ status, value }),
    }),
  );

  assert.equal(handled, true);
  assert.deepEqual(persisted, {
    sourceThreadId: "source",
    provider: "claude-code",
    profileId: "default:claude-code",
    model: "default",
    worktree: "/repo/shared",
    destinationWorktree: "/repo/shared",
    workspaceMode: "shared",
    expectedDigest: "digest",
  });
  assert.deepEqual(writes, [{ status: 201, value: created }]);
});

test("native provider forks reuse their single model-readiness probe", async (t) => {
  for (const provider of ["codex-cli", "shikigami"] as const) {
    await t.test(provider, async () => {
      let readinessCalls = 0;
      let readinessInput: unknown;
      let persisted = false;
      const shikigamiRuntime = {
        profile: { provider: "shikigami" },
        executable: "/fixture/shikigami",
        environment: { SHIKIGAMI_MODEL_ADAPTER: "scripted" },
        configPath: "/fixture/shikigami.toml",
      };
      await handleConversationForkRoute(
        "/api/forks/create",
        request,
        response,
        context({
          readJson: async () => ({
            sourceThreadId: "source",
            provider,
            profileId: provider === "codex-cli" ? null : "profile:shikigami",
            model: "default",
            expectedDigest: "digest",
          }),
          state: {
            previewFork: unused,
            inspect: async () => ({
              projects: [{ id: "project", root: "/repo" }],
              threads: [
                {
                  id: "source",
                  projectId: "project",
                  worktree: "/repo/shared",
                  workspaceMode: "shared",
                },
              ],
            }),
            createFork: async () => {
              persisted = true;
              return { thread: { id: "fork" }, fork: { id: "manifest" } };
            },
          } as never,
          profiles: {
            runtime: async () => shikigamiRuntime,
          } as never,
          codex: {
            readiness: async () => {
              readinessCalls += 1;
              return {
                id: "codex-cli",
                installed: true,
                authenticated: true,
                version: "0.145.0",
                models: [
                  {
                    id: "codex-model",
                    displayName: "Codex model",
                    isDefault: true,
                    reasoningEfforts: ["medium"],
                    defaultReasoningEffort: "medium",
                  },
                ],
                detail: null,
              };
            },
          } as never,
          shikigami: {
            readiness: async (environment, options) => {
              readinessCalls += 1;
              readinessInput = { environment, options };
              return {
                id: "shikigami",
                installed: true,
                authenticated: true,
                version: "1.0.5",
                models: [{ id: "scripted", displayName: "Scripted", isDefault: true }],
                name: "Shikigami",
                detail: null,
              };
            },
          } as never,
          selectWorktree: async (root, worktree) => ({ root, worktree }),
          sendJson: () => {},
        }),
      );

      assert.equal(readinessCalls, 1);
      assert.equal(persisted, true);
      if (provider === "shikigami") {
        assert.deepEqual(readinessInput, {
          environment: shikigamiRuntime.environment,
          options: {
            executable: shikigamiRuntime.executable,
            configPath: shikigamiRuntime.configPath,
            cwd: "/repo/shared",
          },
        });
      }
    });
  }
});
