import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { DeliveryBroker } from "./delivery.ts";
import { handleDeliveryRoute, type DeliveryRouteContext } from "./delivery-routes.ts";
import type { ReleaseDeliveryBroker } from "./release-delivery-workflow.ts";
import { RepositoryError } from "./repository.ts";
import type { LocalStateStore } from "./state.ts";

const request = new EventEmitter() as IncomingMessage;
const response = Object.assign(new EventEmitter(), { writableEnded: false }) as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Partial<DeliveryRouteContext> = {}): DeliveryRouteContext {
  return {
    delivery: { plan: unused, execute: unused } as unknown as DeliveryBroker,
    releaseDelivery: {
      inspect: unused,
      plan: unused,
      execute: unused,
      receipt: unused,
    } as unknown as ReleaseDeliveryBroker,
    state: { inspect: unused } as unknown as LocalStateStore,
    remote: false,
    managed: false,
    selectWorktree: unused,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("delivery route module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleDeliveryRoute("/api/previews/request", request, response, context()),
    false,
  );
});

test("delivery plans use the canonical selected worktree through one interface", async () => {
  const writes: Array<{ status: number; value: unknown }> = [];
  const planned = { id: "plan-1" };
  const handled = await handleDeliveryRoute(
    "/api/delivery/plans",
    request,
    response,
    context({
      readJson: async () => ({
        root: "/requested/repo",
        worktree: "/requested/worktree",
        action: "commit",
        input: { message: "refactor delivery" },
      }),
      selectWorktree: async (root, worktree) => {
        assert.equal(root, "/requested/repo");
        assert.equal(worktree, "/requested/worktree");
        return { root: "/canonical/repo", worktree: "/canonical/worktree" };
      },
      delivery: {
        plan: async (root, worktree, action, input) => {
          assert.deepEqual(
            { root, worktree, action, input },
            {
              root: "/canonical/repo",
              worktree: "/canonical/worktree",
              action: "commit",
              input: { message: "refactor delivery" },
            },
          );
          return planned;
        },
        execute: unused,
      } as unknown as DeliveryBroker,
      sendJson: (_response, status, value) => writes.push({ status, value }),
    }),
  );

  assert.equal(handled, true);
  assert.deepEqual(writes, [{ status: 200, value: planned }]);
});

test("managed hosts reject delivery plans before reading request data", async () => {
  await assert.rejects(
    handleDeliveryRoute("/api/delivery/plans", request, response, context({ managed: true })),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 403 &&
      error.message === "Delivery authority is unavailable in managed hosted mode.",
  );
});

test("remote hosts reject release delivery before reading request data", async () => {
  await assert.rejects(
    handleDeliveryRoute(
      "/api/release-delivery/inspect",
      request,
      response,
      context({ remote: true }),
    ),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.status === 403 &&
      error.message === "Release delivery is available only on the loopback workbench.",
  );
});

test("release execution propagates request cancellation through the dispatch interface", async () => {
  const currentRequest = new EventEmitter() as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
  }) as ServerResponse;
  let observedAbort = false;
  const root = process.cwd();

  await handleDeliveryRoute(
    "/api/release-delivery/plans/12345678-abcd/execute",
    currentRequest,
    currentResponse,
    context({
      readJson: async () => ({ root, worktree: root, projectId: "project-1" }),
      selectWorktree: async () => ({ root, worktree: root }),
      state: {
        inspect: async () => ({ projects: [{ id: "project-1", root }] }),
      } as unknown as LocalStateStore,
      releaseDelivery: {
        inspect: unused,
        plan: unused,
        receipt: unused,
        execute: async (_plan, _project, _root, _worktree, _namespace, signal) => {
          currentRequest.emit("aborted");
          observedAbort = signal.aborted;
          return { id: "session-1" };
        },
      } as unknown as ReleaseDeliveryBroker,
      sendJson: () => undefined,
    }),
  );

  assert.equal(observedAbort, true);
});

test("release inspection cancels disconnected work and releases lifecycle listeners", async () => {
  const currentRequest = new EventEmitter() as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
  const root = process.cwd();
  let observedSignal: AbortSignal | undefined;

  await assert.rejects(
    handleDeliveryRoute(
      "/api/release-delivery/inspect",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ root, worktree: root, projectId: "project-1" }),
        selectWorktree: async () => ({ root, worktree: root }),
        state: {
          inspect: async () => ({ projects: [{ id: "project-1", root }] }),
        } as unknown as LocalStateStore,
        releaseDelivery: {
          inspect: async (_project, _root, _worktree, signal) => {
            observedSignal = signal;
            currentResponse.emit("close");
            signal?.throwIfAborted();
            return {};
          },
          plan: unused,
          execute: unused,
          receipt: unused,
        } as unknown as ReleaseDeliveryBroker,
      }),
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(observedSignal?.aborted, true);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});

test("release inspection stops project validation after request cancellation", async () => {
  const currentRequest = new EventEmitter() as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
  const root = process.cwd();
  let inspections = 0;

  await assert.rejects(
    handleDeliveryRoute(
      "/api/release-delivery/inspect",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ root, worktree: root, projectId: "project-1" }),
        selectWorktree: async () => ({ root, worktree: root }),
        state: {
          inspect: async () => {
            currentRequest.emit("aborted");
            return { projects: [{ id: "project-1", root }] };
          },
        } as unknown as LocalStateStore,
        releaseDelivery: {
          inspect: async () => {
            inspections += 1;
            return {};
          },
          plan: unused,
          execute: unused,
          receipt: unused,
        } as unknown as ReleaseDeliveryBroker,
      }),
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(inspections, 0);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});

test("PR status batch cancels disconnected work and releases lifecycle listeners", async () => {
  const currentRequest = new EventEmitter() as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
  }) as ServerResponse;
  let observedAbort = false;

  await assert.rejects(
    handleDeliveryRoute(
      "/api/delivery/pr-status/batch",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ items: [{ root: "/repo", worktree: "/worktree" }] }),
        selectWorktree: async () => ({ root: "/repo", worktree: "/worktree" }),
        inspectBranchPrBatch: async (_worktrees, signal) => {
          currentResponse.emit("close");
          observedAbort = Boolean(signal?.aborted);
          signal?.throwIfAborted();
          return [];
        },
      }),
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(observedAbort, true);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});

test("PR status batch rejects a disconnect that predates lifecycle listeners", async () => {
  const currentRequest = Object.assign(new EventEmitter(), {
    aborted: true,
  }) as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
  let inspections = 0;

  await assert.rejects(
    handleDeliveryRoute(
      "/api/delivery/pr-status/batch",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ items: [{ root: "/repo", worktree: "/worktree" }] }),
        selectWorktree: async () => ({ root: "/repo", worktree: "/worktree" }),
        inspectBranchPrBatch: async () => {
          inspections += 1;
          return [];
        },
      }),
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(inspections, 0);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});
