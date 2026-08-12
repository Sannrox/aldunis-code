import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { ChiseiClientError } from "./chisei-client.ts";
import { handleChiseiRoute } from "./chisei-routes.ts";
import { LocalStateError } from "./state.ts";

const response = Object.assign(new EventEmitter(), {
  writableEnded: false,
  destroyed: false,
}) as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    projects: [
      { id: "project-1", name: "Project", root: "/repo", chiseiNamespace: "team/project" },
    ],
    governanceCorrelations: [],
    threads: [],
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    state: { inspect: unused, bindProjectChiseiNamespace: unused },
    chisei: {
      listActions: unused,
      actionDetail: unused,
      sampleObservation: unused,
      operationReceipt: unused,
    },
    remoteRequest: false,
    managed: false,
    readJson: unused,
    sendJson: () => assert.fail("response must not be written"),
    ...overrides,
  };
}

test("Chisei module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleChiseiRoute("/api/state/load", request(), response, context() as never),
    false,
  );
});

test("Chisei module denies binding administration in remote and managed modes", async () => {
  for (const mode of [{ remoteRequest: true }, { managed: true }]) {
    await assert.rejects(
      handleChiseiRoute(
        "/api/integrations/chisei/bind",
        request(),
        response,
        context(mode) as never,
      ),
      (error: unknown) => error instanceof LocalStateError && error.status === 403,
    );
  }
});

test("Chisei module binds a validated local project namespace", async () => {
  const writes: unknown[] = [];
  const bindings: unknown[] = [];
  assert.equal(
    await handleChiseiRoute(
      "/api/integrations/chisei/bind",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "project-1", namespace: "team/project" }),
        state: {
          inspect: unused,
          bindProjectChiseiNamespace: async (projectId: string, namespace: string) => {
            bindings.push({ projectId, namespace });
            return { id: projectId, chiseiNamespace: namespace };
          },
        },
        sendJson: (_response: ServerResponse, status: number, value: unknown) =>
          writes.push({ status, value }),
      }) as never,
    ),
    true,
  );
  assert.deepEqual(bindings, [{ projectId: "project-1", namespace: "team/project" }]);
  assert.deepEqual(writes, [
    { status: 200, value: { projectId: "project-1", chiseiNamespace: "team/project" } },
  ]);
});

test("Chisei Action list derives namespace and bounds optional filters", async () => {
  const calls: unknown[] = [];
  const longType = "t".repeat(250);
  const longStatus = "s".repeat(70);
  await handleChiseiRoute(
    "/api/integrations/chisei/actions/list",
    request(),
    response,
    context({
      readJson: async () => ({
        projectId: "project-1",
        namespace: "attacker/override",
        typeId: ` ${longType} `,
        status: ` ${longStatus} `,
        limit: 25,
      }),
      state: { inspect: async () => projection(), bindProjectChiseiNamespace: unused },
      chisei: {
        listActions: async (...args: unknown[]) => {
          calls.push(args);
          return { actions: [] };
        },
      },
      sendJson: () => undefined,
    }) as never,
  );
  assert.equal(calls.length, 1);
  const [projectId, namespace, filters, signal] = calls[0] as unknown[];
  assert.equal(projectId, "project-1");
  assert.equal(namespace, "team/project");
  assert.deepEqual(filters, {
    typeId: longType.slice(0, 200),
    status: longStatus.slice(0, 50),
    limit: 25,
  });
  assert.ok(signal instanceof AbortSignal);
});

test("Chisei reads cancel disconnected SDK work and release lifecycle listeners", async () => {
  const currentRequest = new EventEmitter() as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
  let observedSignal: AbortSignal | undefined;

  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/actions/detail",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ projectId: "project-1", instanceId: "action-1" }),
        state: { inspect: async () => projection(), bindProjectChiseiNamespace: unused },
        chisei: {
          actionDetail: async (_namespace: string, _instanceId: string, signal: AbortSignal) => {
            observedSignal = signal;
            currentResponse.emit("close");
            signal.throwIfAborted();
          },
        },
      }) as never,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(observedSignal?.aborted, true);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});

test("Chisei reads reject a disconnect observed before lifecycle registration", async () => {
  const currentRequest = Object.assign(new EventEmitter(), {
    aborted: true,
  }) as IncomingMessage;
  const currentResponse = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
  }) as ServerResponse;
  let reads = 0;

  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/actions/list",
      currentRequest,
      currentResponse,
      context({
        readJson: async () => ({ projectId: "project-1" }),
        state: { inspect: async () => projection(), bindProjectChiseiNamespace: unused },
        chisei: {
          listActions: async () => {
            reads += 1;
          },
        },
      }) as never,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(reads, 0);
  assert.equal(currentRequest.listenerCount("aborted"), 0);
  assert.equal(currentResponse.listenerCount("close"), 0);
});

test("Chisei reads reject missing projects and unbound namespaces", async () => {
  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/actions/detail",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "missing", instanceId: "action-1" }),
        state: {
          inspect: async () => projection({ projects: [] }),
          bindProjectChiseiNamespace: unused,
        },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 404,
  );
  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/actions/detail",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "project-1", instanceId: "action-1" }),
        state: {
          inspect: async () => projection({ projects: [{ id: "project-1", root: "/repo" }] }),
          bindProjectChiseiNamespace: unused,
        },
      }) as never,
    ),
    (error: unknown) => error instanceof ChiseiClientError && error.status === 409,
  );
});

test("Chisei observation identity is bounded and missing projections fail visibly", async () => {
  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/observations/detail",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "project-1", requestId: "bad\0id" }),
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/observations/detail",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "project-1", requestId: "request-1" }),
        state: { inspect: async () => projection(), bindProjectChiseiNamespace: unused },
        chisei: { sampleObservation: async () => null },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 404,
  );
});

test("Chisei operation receipt derives authority from project correlation ownership", async () => {
  const writes: unknown[] = [];
  await handleChiseiRoute(
    "/api/integrations/chisei/operations/detail",
    request(),
    response,
    context({
      readJson: async () => ({ projectId: "project-1", correlationId: "correlation-1" }),
      state: {
        inspect: async () =>
          projection({
            governanceCorrelations: [
              { id: "correlation-1", threadId: "thread-1", operationId: "operation-1" },
            ],
            threads: [{ id: "thread-1", projectId: "project-1" }],
          }),
        bindProjectChiseiNamespace: unused,
      },
      chisei: {
        operationReceipt: async (operationId: string) => ({ operationId }),
      },
      sendJson: (_response: ServerResponse, status: number, value: unknown) =>
        writes.push({ status, value }),
    }) as never,
  );
  assert.deepEqual(writes, [{ status: 200, value: { operationId: "operation-1" } }]);

  await assert.rejects(
    handleChiseiRoute(
      "/api/integrations/chisei/operations/detail",
      request(),
      response,
      context({
        readJson: async () => ({ projectId: "project-2", correlationId: "correlation-1" }),
        state: {
          inspect: async () =>
            projection({
              governanceCorrelations: [
                { id: "correlation-1", threadId: "thread-1", operationId: "operation-1" },
              ],
              threads: [{ id: "thread-1", projectId: "project-1" }],
            }),
          bindProjectChiseiNamespace: unused,
        },
      }) as never,
    ),
    (error: unknown) => error instanceof LocalStateError && error.status === 404,
  );
});
