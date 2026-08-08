import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

async function listen(remote = false) {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-autonomy-host-"));
  const state = new LocalStateStore(directory);
  const remoteAuth = remote ? ({ verify: async () => ({}) } as unknown as RemoteAuth) : undefined;
  const server = createLocalHost(directory, state, undefined, remoteAuth);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { directory, state, server, url: `http://127.0.0.1:${address.port}` };
}

async function close(current: Awaited<ReturnType<typeof listen>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    current.server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(current.directory, { recursive: true, force: true });
}

async function post(url: string, route: string, body: unknown) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("autonomy host routes expose the ledger and keep mutations loopback-local", async () => {
  const current = await listen();
  try {
    const loaded = await post(current.url, "/api/autonomy/load", {});
    assert.equal(loaded.status, 200);
    const initial = (await loaded.json()) as { flows: Array<{ id: string }> };
    assert.deepEqual(initial.flows.map((flow) => flow.id).sort(), [
      "heartbeat-awareness.v1",
      "maintenance-gardener.v1",
    ]);

    const order = await post(current.url, "/api/autonomy/standing-orders/create", {
      name: "Keep reports bounded",
      scope: "global",
      instruction: "Prefer concise, reviewable maintenance suggestions.",
    });
    assert.equal(order.status, 200);
    const heartbeat = await post(current.url, "/api/autonomy/heartbeats/create", {
      name: "Awareness",
      goal: "Record periodic awareness.",
      everySeconds: 60,
    });
    assert.equal(heartbeat.status, 200);
    const snapshot = await current.state.load();
    assert.equal(snapshot.standingOrders.length, 1);
    assert.equal(snapshot.heartbeatMonitors.length, 1);
  } finally {
    await close(current);
  }
});

test("remote autonomy clients can inspect but cannot mutate the local ledger", async () => {
  const current = await listen(true);
  try {
    const loaded = await post(current.url, "/api/autonomy/load", {});
    assert.equal(loaded.status, 200);
    const mutation = await post(current.url, "/api/autonomy/standing-orders/create", {
      name: "Remote attempt",
      scope: "global",
      instruction: "This must be rejected.",
    });
    assert.equal(mutation.status, 403);
  } finally {
    await close(current);
  }
});
