import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleAutomationRoute, type AutomationRouteContext } from "./automation-routes.ts";
import { AutomationError } from "./automations.ts";

const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function context(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ status: number; value: unknown }> = [];
  return {
    sent,
    automations: { list: unused, create: unused, update: unused, remove: unused },
    automationScheduler: { runNow: unused },
    state: { inspect: unused, latestAutomationFire: unused, getAutomationFireById: unused },
    remoteRequest: false,
    managed: false,
    readJson: unused,
    sendJson: (_response: ServerResponse, status: number, value: unknown) =>
      sent.push({ status, value }),
    ...overrides,
  };
}

test("automation module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleAutomationRoute(
      "/api/state/load",
      request(),
      response,
      context() as unknown as AutomationRouteContext,
    ),
    false,
  );
});

test("managed automation list is an empty projection", async () => {
  const module = context({ managed: true });
  assert.equal(
    await handleAutomationRoute(
      "/api/automations/list",
      request(),
      response,
      module as unknown as AutomationRouteContext,
    ),
    true,
  );
  assert.deepEqual(module.sent, [{ status: 200, value: { automations: [] } }]);
});

test("automation list enriches each item with its latest fire", async () => {
  const module = context({
    automations: { list: async () => [{ id: "automation-1", name: "Daily" }] },
    state: { latestAutomationFire: async (id: string) => ({ id: `fire-for-${id}` }) },
  });
  await handleAutomationRoute(
    "/api/automations/list",
    request(),
    response,
    module as unknown as AutomationRouteContext,
  );
  assert.deepEqual(module.sent[0], {
    status: 200,
    value: {
      automations: [
        { id: "automation-1", name: "Daily", lastFire: { id: "fire-for-automation-1" } },
      ],
    },
  });
});

test("remote automation mutations fail before reading request input", async () => {
  for (const route of [
    "/api/automations/create",
    "/api/automations/update",
    "/api/automations/delete",
    "/api/automations/run-now",
  ]) {
    await assert.rejects(
      handleAutomationRoute(
        route,
        request(),
        response,
        context({ remoteRequest: true }) as unknown as AutomationRouteContext,
      ),
      (error: unknown) => error instanceof AutomationError && error.status === 403,
    );
  }
});

test("automation creation requires an existing conversation", async () => {
  await assert.rejects(
    handleAutomationRoute(
      "/api/automations/create",
      request(),
      response,
      context({
        readJson: async () => ({
          name: "Daily",
          threadId: "missing",
          prompt: "Check status",
          schedule: { kind: "interval", seconds: 60 },
        }),
        state: { inspect: async () => ({ threads: [] }) },
      }) as unknown as AutomationRouteContext,
    ),
    (error: unknown) => error instanceof AutomationError && error.status === 404,
  );
});

test("run-now rejects retry identities that do not belong to an unknown fire", async () => {
  await assert.rejects(
    handleAutomationRoute(
      "/api/automations/run-now",
      request(),
      response,
      context({
        readJson: async () => ({
          id: "automation-1",
          retryOf: "00000000-0000-0000-0000-000000000000",
        }),
        state: {
          getAutomationFireById: async () => ({ automationId: "automation-2", status: "unknown" }),
        },
      }) as unknown as AutomationRouteContext,
    ),
    (error: unknown) => error instanceof AutomationError && error.status === 409,
  );
});

test("run-now forwards bounded identity and returns latest fire", async () => {
  const runNowCalls: unknown[][] = [];
  const module = context({
    readJson: async () => ({
      id: "automation-1",
      idempotencyKey: "manual:1",
      retryOf: "00000000-0000-0000-0000-000000000000",
    }),
    state: {
      getAutomationFireById: async () => ({ automationId: "automation-1", status: "unknown" }),
      latestAutomationFire: async () => ({ id: "latest-fire" }),
    },
    automationScheduler: {
      runNow: async (...args: unknown[]) => {
        runNowCalls.push(args);
        return { id: "automation-1", accepted: true };
      },
    },
  });
  await handleAutomationRoute(
    "/api/automations/run-now",
    request(),
    response,
    module as unknown as AutomationRouteContext,
  );
  assert.deepEqual(runNowCalls, [
    ["automation-1", "manual:1", "00000000-0000-0000-0000-000000000000"],
  ]);
  assert.deepEqual(module.sent[0], {
    status: 200,
    value: { id: "automation-1", accepted: true, lastFire: { id: "latest-fire" } },
  });
});
