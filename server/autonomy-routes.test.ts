import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleAutonomyRoute, type AutonomyRouteContext } from "./autonomy-routes.ts";

function request(body: unknown = {}): IncomingMessage {
  return { body } as unknown as IncomingMessage;
}

function response() {
  return {} as ServerResponse;
}

function context(
  overrides: Partial<AutonomyRouteContext> = {},
): AutonomyRouteContext & { sent: Array<{ status: number; value: unknown }> } {
  const sent: Array<{ status: number; value: unknown }> = [];
  return {
    autonomy: {} as AutonomyRouteContext["autonomy"],
    state: {} as AutonomyRouteContext["state"],
    remoteRequest: false,
    managed: false,
    visibleProjectIds: async () => new Set(),
    readJson: async (input) => (input as unknown as { body: unknown }).body,
    sendJson: (_output, status, value) => sent.push({ status, value }),
    sent,
    ...overrides,
  };
}

test("ignores routes outside the Autonomy seam", async () => {
  const module = context();
  assert.equal(await handleAutonomyRoute("/api/state/load", request(), response(), module), false);
  assert.deepEqual(module.sent, []);
});

test("creates a standing order through the route interface", async () => {
  const created = { id: "order-1", name: "Bound reports" };
  const module = context({
    autonomy: {
      addStandingOrder: async () => created,
    } as unknown as AutonomyRouteContext["autonomy"],
  });
  assert.equal(
    await handleAutonomyRoute(
      "/api/autonomy/standing-orders/create",
      request({ name: "Bound reports", scope: "global", instruction: "Stay concise." }),
      response(),
      module,
    ),
    true,
  );
  assert.deepEqual(module.sent, [{ status: 200, value: created }]);
});

test("denies remote Autonomy mutations before calling an adapter", async () => {
  const module = context({ remoteRequest: true });
  await assert.rejects(
    handleAutonomyRoute(
      "/api/autonomy/standing-orders/create",
      request({ name: "Remote", scope: "global", instruction: "Denied." }),
      response(),
      module,
    ),
    { message: "Remote clients cannot create standing orders.", status: 403 },
  );
});

test("filters managed snapshots to visible projects and their tasks", async () => {
  const snapshot = {
    flows: [],
    runs: [
      { id: "visible-run", projectId: "visible" },
      { id: "hidden-run", projectId: "hidden" },
      { id: "global-run", projectId: null },
    ],
    tasks: [
      { id: "visible-task", runId: "visible-run" },
      { id: "hidden-task", runId: "hidden-run" },
      { id: "global-task", runId: "global-run" },
    ],
    heartbeatMonitors: [
      { id: "visible-heartbeat", projectId: "visible" },
      { id: "hidden-heartbeat", projectId: "hidden" },
    ],
    standingOrders: [
      { id: "global-order", projectId: null },
      { id: "hidden-order", projectId: "hidden" },
    ],
    hooks: [
      { id: "visible-hook", projectId: "visible" },
      { id: "hidden-hook", projectId: "hidden" },
    ],
  };
  const module = context({
    managed: true,
    visibleProjectIds: async () => new Set(["visible"]),
    autonomy: {
      snapshot: async () => snapshot,
    } as unknown as AutonomyRouteContext["autonomy"],
  });
  await handleAutonomyRoute("/api/autonomy/load", request(), response(), module);
  const value = module.sent[0]?.value as typeof snapshot;
  assert.deepEqual(
    value.runs.map((item) => item.id),
    ["visible-run", "global-run"],
  );
  assert.deepEqual(
    value.tasks.map((item) => item.id),
    ["visible-task", "global-task"],
  );
  assert.deepEqual(
    value.heartbeatMonitors.map((item) => item.id),
    ["visible-heartbeat"],
  );
  assert.deepEqual(
    value.standingOrders.map((item) => item.id),
    ["global-order"],
  );
  assert.deepEqual(
    value.hooks.map((item) => item.id),
    ["visible-hook"],
  );
});
