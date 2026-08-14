import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ThreadWakeEvent } from "./wake.ts";
import {
  handleWakeStreamRoute,
  MAX_CONCURRENT_WAKE_STREAMS,
  WakeStreamAdmission,
} from "./wake-stream-routes.ts";

class FixtureRequest extends EventEmitter {
  aborted = false;
  destroyed = false;

  off(event: string, listener: (...args: unknown[]) => void): this {
    super.off(event, listener);
    return this;
  }
}

class FixtureResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;
  ended = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
    this.writableEnded = true;
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    super.off(event, listener);
    return this;
  }
}

test("wake stream route ignores unrelated paths", async () => {
  const handled = await handleWakeStreamRoute(
    "/api/state/load",
    new FixtureRequest() as unknown as IncomingMessage,
    new FixtureResponse() as unknown as ServerResponse,
    {
      method: "GET",
      wake: { subscribe: () => () => undefined },
      loadProjection: async () => ({ threads: [] }) as never,
      admission: new WakeStreamAdmission(),
    },
  );
  assert.equal(handled, false);
});

test("local wake stream opens SSE, forwards events, and cleans up on close", async () => {
  const request = new FixtureRequest();
  const response = new FixtureResponse();
  let unsubscribeCount = 0;
  const subscription: { publish: ((event: ThreadWakeEvent) => void) | null } = {
    publish: null,
  };
  const handled = await handleWakeStreamRoute(
    "/api/state/events",
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      method: "GET",
      wake: {
        subscribe: (next) => {
          subscription.publish = next;
          return () => {
            unsubscribeCount += 1;
          };
        },
      },
      loadProjection: async () => ({ threads: [] }) as never,
      admission: new WakeStreamAdmission(),
      heartbeatMs: 60_000,
    },
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(response.chunks[0], "event: ready\ndata: ready\n\n");
  assert.equal(typeof subscription.publish, "function");
  subscription.publish!({ threadId: "thread-1", status: "running", at: "t1" });
  assert.match(response.chunks.join(""), /"threadId":"thread-1"/);

  request.emit("close");
  assert.equal(unsubscribeCount, 1);
  subscription.publish!({ threadId: "thread-2", status: "completed", at: "t2" });
  assert.doesNotMatch(response.chunks.join(""), /thread-2/);
});

test("managed wake stream filters unpublished threads before write", async () => {
  const request = new FixtureRequest();
  const response = new FixtureResponse();
  let handler: ((event: ThreadWakeEvent) => void) | null = null;
  await handleWakeStreamRoute(
    "/api/state/events",
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      method: "GET",
      wake: {
        subscribe: (next) => {
          handler = next;
          return () => undefined;
        },
      },
      loadProjection: async () =>
        ({
          schemaVersion: 2,
          sequence: 1,
          projects: [{ id: "project-1", root: "/allowed" }],
          threads: [{ id: "visible", projectId: "project-1" }],
          turns: [],
          messages: [],
          activities: [],
          plans: [],
          contextReceipts: [],
          usageReceipts: [],
          governanceCorrelations: [],
          providerSessions: [],
          checkpoints: [],
          annotations: [],
          fileReviews: [],
          conversationDeletions: [],
          forks: [],
          delegatedRelationships: [],
          inputRequests: [],
          inputReceipts: [],
          mailboxTransfers: [],
          automationFires: [],
          autonomyRuns: [],
          autonomyTasks: [],
          autonomyFlows: [],
          heartbeatMonitors: [],
          standingOrders: [],
          autonomyHooks: [],
        }) as never,
      managedHost: {
        repositoryForRoot: (root: string) => {
          if (root !== "/allowed") throw new Error("outside catalogue");
          return { root, id: "repo-1" };
        },
      },
      admission: new WakeStreamAdmission(),
      heartbeatMs: 60_000,
    },
  );

  assert.ok(handler);
  handler!({ threadId: "hidden", status: "running", at: "t-hidden" });
  await new Promise((resolve) => setImmediate(resolve));
  handler!({ threadId: "visible", status: "running", at: "t-visible" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const body = response.chunks.join("");
  assert.doesNotMatch(body, /"threadId":"hidden"/);
  assert.match(body, /"threadId":"visible"/);
  request.emit("close");
});

test("wake stream admission rejects overflow before subscription and recovers after close", async () => {
  const admission = new WakeStreamAdmission();
  const requests: FixtureRequest[] = [];
  const responses: FixtureResponse[] = [];
  let subscribers = 0;
  const context = {
    method: "GET",
    wake: {
      subscribe: () => {
        subscribers += 1;
        return () => {
          subscribers -= 1;
        };
      },
    },
    loadProjection: async () => ({ threads: [] }) as never,
    admission,
    heartbeatMs: 60_000,
  };

  for (let index = 0; index < MAX_CONCURRENT_WAKE_STREAMS; index += 1) {
    const request = new FixtureRequest();
    const response = new FixtureResponse();
    requests.push(request);
    responses.push(response);
    assert.equal(
      await handleWakeStreamRoute(
        "/api/state/events",
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
        context,
      ),
      true,
    );
    assert.equal(response.statusCode, 200);
  }

  const overflowRequest = new FixtureRequest();
  const overflowResponse = new FixtureResponse();
  await handleWakeStreamRoute(
    "/api/state/events",
    overflowRequest as unknown as IncomingMessage,
    overflowResponse as unknown as ServerResponse,
    context,
  );
  assert.equal(overflowResponse.statusCode, 200);
  assert.equal(overflowResponse.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(overflowResponse.chunks.join(""), "retry: 1000\nevent: capacity\ndata: retry\n\n");
  assert.equal(overflowResponse.ended, true);
  assert.equal(overflowRequest.listenerCount("close"), 0);
  assert.equal(overflowResponse.listenerCount("close"), 0);
  assert.equal(subscribers, MAX_CONCURRENT_WAKE_STREAMS);
  assert.equal(admission.activeCount, MAX_CONCURRENT_WAKE_STREAMS);

  requests[0]!.emit("close");
  assert.equal(subscribers, MAX_CONCURRENT_WAKE_STREAMS - 1);
  assert.equal(admission.activeCount, MAX_CONCURRENT_WAKE_STREAMS - 1);

  const recoveredRequest = new FixtureRequest();
  const recoveredResponse = new FixtureResponse();
  await handleWakeStreamRoute(
    "/api/state/events",
    recoveredRequest as unknown as IncomingMessage,
    recoveredResponse as unknown as ServerResponse,
    context,
  );
  assert.equal(recoveredResponse.statusCode, 200);
  assert.equal(subscribers, MAX_CONCURRENT_WAKE_STREAMS);
  assert.equal(admission.activeCount, MAX_CONCURRENT_WAKE_STREAMS);

  recoveredRequest.emit("close");
  for (const request of requests.slice(1)) request.emit("close");
  assert.equal(subscribers, 0);
  assert.equal(admission.activeCount, 0);
});

test("wake stream admission releases capacity when response setup fails", async () => {
  const admission = new WakeStreamAdmission(1);
  const request = new FixtureRequest();
  const response = new (class extends FixtureResponse {
    override writeHead(): this {
      throw new Error("fixture response failed");
    }
  })();

  await assert.rejects(
    handleWakeStreamRoute(
      "/api/state/events",
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      {
        method: "GET",
        wake: { subscribe: () => () => undefined },
        loadProjection: async () => ({ threads: [] }) as never,
        admission,
      },
    ),
    /fixture response failed/,
  );
  assert.equal(admission.activeCount, 0);
  assert.equal(request.listenerCount("close"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("wake stream admission releases requests closed before route setup", async () => {
  const admission = new WakeStreamAdmission(1);
  const request = new FixtureRequest();
  request.aborted = true;
  const response = new FixtureResponse();
  let subscriptions = 0;

  assert.equal(
    await handleWakeStreamRoute(
      "/api/state/events",
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
      {
        method: "GET",
        wake: {
          subscribe: () => {
            subscriptions += 1;
            return () => undefined;
          },
        },
        loadProjection: async () => ({ threads: [] }) as never,
        admission,
      },
    ),
    true,
  );
  assert.equal(response.statusCode, 0);
  assert.equal(subscriptions, 0);
  assert.equal(admission.activeCount, 0);
  assert.equal(request.listenerCount("close"), 0);
  assert.equal(response.listenerCount("close"), 0);
});

test("wake stream admission accepts a consumed authenticated request with a live response", async () => {
  const admission = new WakeStreamAdmission(1);
  const request = new FixtureRequest();
  request.destroyed = true;
  const response = new FixtureResponse();
  let subscriptions = 0;

  await handleWakeStreamRoute(
    "/api/state/events",
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      method: "GET",
      wake: {
        subscribe: () => {
          subscriptions += 1;
          return () => {
            subscriptions -= 1;
          };
        },
      },
      loadProjection: async () => ({ threads: [] }) as never,
      admission,
      heartbeatMs: 60_000,
    },
  );
  assert.equal(response.statusCode, 200);
  assert.equal(subscriptions, 1);
  assert.equal(admission.activeCount, 1);

  response.emit("close");
  assert.equal(subscriptions, 0);
  assert.equal(admission.activeCount, 0);
});
