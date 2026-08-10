import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleConversationLifecycleRoute } from "./conversation-lifecycle-routes.ts";
import { LocalStateError, type StateProjection } from "./state.ts";

const request = {} as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      inspect: unused,
      renameConversation: unused,
      setConversationPinned: unused,
      archiveConversation: unused,
      restoreConversation: unused,
      settleConversation: unused,
      unsettleConversation: unused,
      snoozeConversation: unused,
      unsnoozeConversation: unused,
      markConversationVisited: unused,
      previewConversationDeletion: unused,
      deleteConversation: unused,
      linkDelegatedConversation: unused,
      unlinkDelegatedConversation: unused,
    },
    preferences: { load: unused },
    worktrees: { releaseManagedPath: unused },
    managed: false,
    assertManagedThread: () => assert.fail("managed thread must not be checked"),
    selectManagedWorktree: unused,
    withDelegatedControlLock: async (action: () => Promise<unknown>) => action(),
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("conversation lifecycle module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleConversationLifecycleRoute(
      "/api/preferences/load",
      request,
      response,
      context() as never,
    ),
    false,
  );
});

test("conversation lifecycle module handles simple transitions through one interface", async () => {
  const writes: unknown[] = [];
  const calls: string[] = [];
  const handled = await handleConversationLifecycleRoute(
    "/api/state/conversations/settle",
    request,
    response,
    context({
      readJson: async () => ({ threadId: "thread-1" }),
      state: {
        ...context().state,
        settleConversation: async (threadId: string) => {
          calls.push(threadId);
          return { id: threadId, settled: true };
        },
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, ["thread-1"]);
  assert.deepEqual(writes, [{ status: 200, value: { id: "thread-1", settled: true } }]);
});

test("conversation lifecycle module rejects worktree release while provider work is active", async () => {
  const projection = {
    projects: [{ id: "project-1", root: "/repo" }],
    threads: [{ id: "thread-1", projectId: "project-1", worktree: "/repo/wt" }],
    turns: [{ id: "turn-1", threadId: "thread-1", status: "waiting_for_approval" }],
  } as unknown as StateProjection;

  await assert.rejects(
    handleConversationLifecycleRoute(
      "/api/state/conversations/release-worktree",
      request,
      response,
      context({
        readJson: async () => ({ threadId: "thread-1", confirm: true }),
        state: { ...context().state, inspect: async () => projection },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
});

test("conversation lifecycle module keeps deletion separate from worktree release", async () => {
  const writes: unknown[] = [];
  let lockCalls = 0;
  const handled = await handleConversationLifecycleRoute(
    "/api/state/conversations/delete",
    request,
    response,
    context({
      readJson: async () => ({ threadId: "thread-1", confirm: true }),
      state: {
        ...context().state,
        deleteConversation: async (threadId: string) => ({ threadId, status: "completed" }),
      },
      withDelegatedControlLock: async (action: () => Promise<unknown>) => {
        lockCalls += 1;
        return action();
      },
      worktrees: {
        releaseManagedPath: () => assert.fail("deletion must not release a worktree"),
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );

  assert.equal(handled, true);
  assert.equal(lockCalls, 1);
  assert.deepEqual(writes, [{ status: 200, value: { threadId: "thread-1", status: "completed" } }]);
});

test("conversation lifecycle module gates delegated links on the beta preference", async () => {
  await assert.rejects(
    handleConversationLifecycleRoute(
      "/api/state/delegated-conversations/link",
      request,
      response,
      context({
        readJson: async () => ({ parentThreadId: "parent", childThreadId: "child" }),
        preferences: { load: async () => ({ preferences: { orchestrationThreadsBeta: false } }) },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
});
