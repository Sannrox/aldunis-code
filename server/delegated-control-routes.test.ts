import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleDelegatedControlRoute } from "./delegated-control-routes.ts";
import { PermissionError } from "./permission.ts";
import { LocalStateError } from "./state.ts";

const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { inspect: unused },
    preferences: { load: unused },
    permissions: { approvals: () => [], decideAfter: unused },
    codex: { answerInput: () => false },
    managed: false,
    assertManagedThread: () => assert.fail("managed scope must not be checked"),
    withLock: unused,
    runChildFollowUp: unused,
    publishThreadStatusTransition: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("delegated-control module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleDelegatedControlRoute("/api/state/load", request(), response, context() as never),
    false,
  );
});

test("delegated-control module validates approval scope before resolving", async () => {
  await assert.rejects(
    handleDelegatedControlRoute(
      "/api/provider/approvals/00000000-0000-0000-0000-000000000000/decide",
      request(),
      response,
      context({ readJson: async () => ({ decision: "deny" }) }) as never,
    ),
    (error: unknown) => error instanceof PermissionError,
  );
});

test("delegated-control module beta-gates parent-routed approvals under its lock", async () => {
  let locked = 0;
  await assert.rejects(
    handleDelegatedControlRoute(
      "/api/provider/approvals/00000000-0000-0000-0000-000000000000/decide",
      request(),
      response,
      context({
        readJson: async () => ({
          runId: "run",
          conversationId: "child",
          repository: "/repo",
          worktree: "/repo/child",
          toolCallId: "tool",
          decision: "deny",
          parentThreadId: "parent",
        }),
        preferences: { load: async () => ({ preferences: { orchestrationThreadsBeta: false } }) },
        withLock: async (action: () => Promise<unknown>) => {
          locked += 1;
          return action();
        },
      }) as never,
    ),
    (error: unknown) => error instanceof PermissionError && error.status === 403,
  );
  assert.equal(locked, 1);
});

test("delegated-control module beta-gates parent-routed input before state mutation", async () => {
  await assert.rejects(
    handleDelegatedControlRoute(
      "/api/provider/input-requests/00000000-0000-0000-0000-000000000000/respond",
      request(),
      response,
      context({
        readJson: async () => ({
          childThreadId: "child",
          parentThreadId: "parent",
          answer: "Continue",
        }),
        state: { inspect: async () => ({}) },
        preferences: { load: async () => ({ preferences: { orchestrationThreadsBeta: false } }) },
        withLock: (action: () => Promise<unknown>) => action(),
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
});
