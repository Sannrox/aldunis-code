import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ThreadWakeEvent } from "./wake.ts";
import { handleWakeStreamRoute } from "./wake-stream-routes.ts";

class FixtureRequest extends EventEmitter {
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

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
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
      heartbeatMs: 60_000,
    },
  );

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(response.chunks[0], ": connected\n\n");
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
