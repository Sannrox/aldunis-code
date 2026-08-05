import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost, isLocalControlRequest } from "./host.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

async function listen(remote = false, publicOrigin?: string, allowLocalControl = true) {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-remote-admin-"));
  let verifyCalls = 0;
  const remoteAuth = remote
    ? {
        verify: async () => {
          verifyCalls += 1;
          return {};
        },
        descriptor: async () => ({ hostId: "host-test", protocolVersion: 1 as const }),
        listSessions: async () => [{
          id: "session-test",
          label: "Test browser",
          createdAt: "2026-08-04T12:00:00.000Z",
          expiresAt: "2099-08-04T12:00:00.000Z",
          revokedAt: null,
        }],
        issuePairing: async () => ({
          id: "pairing-test",
          credential: "one-time-credential",
          expiresAt: "2099-08-04T12:10:00.000Z",
        }),
        revoke: async (sessionId: string) => sessionId === "session-test",
      } as unknown as RemoteAuth
    : undefined;
  const server = createLocalHost(
    directory,
    new LocalStateStore(directory),
    undefined,
    remoteAuth,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publicOrigin,
    undefined,
    allowLocalControl,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get verifyCalls() { return verifyCalls; },
  };
}

async function post(
  url: string,
  route: string,
  body: unknown = {},
  headers: Record<string, string> = {},
) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function close(server: ReturnType<typeof createLocalHost>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("LAN same-host administration matches the configured private bind only", () => {
  const local = {
    headers: { host: "192.0.2.10:4174" },
    socket: { remoteAddress: "192.0.2.10" },
  } as unknown as IncomingMessage;
  const otherClient = {
    headers: { host: "192.0.2.10:4174" },
    socket: { remoteAddress: "192.0.2.11" },
  } as unknown as IncomingMessage;
  const publicOrigin = {
    headers: { host: "code.example.test:4174" },
    socket: { remoteAddress: "192.0.2.10" },
  } as unknown as IncomingMessage;
  assert.equal(isLocalControlRequest(local, "192.0.2.10"), true);
  assert.equal(isLocalControlRequest(otherClient, "192.0.2.10"), false);
  assert.equal(
    isLocalControlRequest(publicOrigin, "192.0.2.10", "https://code.example.test"),
    true,
  );
});

test("local Connections controls can inspect, pair, and revoke sessions", async () => {
  const fixture = await listen(true);
  try {
    const status = await post(fixture.url, "/api/remote/admin/status");
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      remoteEnabled: true,
      descriptor: { hostId: "host-test", protocolVersion: 1 },
      sessions: [{
        id: "session-test",
        label: "Test browser",
        createdAt: "2026-08-04T12:00:00.000Z",
        expiresAt: "2099-08-04T12:00:00.000Z",
        revokedAt: null,
      }],
    });
    const ipv6Host = await post(fixture.url, "/api/remote/admin/status", {}, { host: "[::1]:4174" });
    assert.equal(ipv6Host.status, 200);
    const pairing = await post(fixture.url, "/api/remote/admin/pair");
    assert.equal(pairing.status, 200);
    assert.match((await pairing.json()).pairingUrl, /#pair=one-time-credential$/);
    const revoked = await post(fixture.url, "/api/remote/admin/revoke", { sessionId: "session-test" });
    assert.deepEqual(await revoked.json(), { revoked: true });
    assert.equal(fixture.verifyCalls, 0);
  } finally {
    await close(fixture.server);
  }
});

test("pairing links use the configured public origin", async () => {
  const fixture = await listen(true, "https://code.example.test");
  try {
    const pairing = await post(fixture.url, "/api/remote/admin/pair");
    assert.equal(pairing.status, 200);
    assert.equal(
      (await pairing.json()).pairingUrl,
      "https://code.example.test/#pair=one-time-credential",
    );
  } finally {
    await close(fixture.server);
  }
});

test("Connections administration fails closed for forwarded requests", async () => {
  const fixture = await listen(true);
  try {
    const forwarded = await post(fixture.url, "/api/remote/admin/status", {}, {
      "x-forwarded-for": "192.0.2.10",
      "x-forwarded-host": "remote.example",
    });
    assert.equal(forwarded.status, 403);
    assert.equal(fixture.verifyCalls, 1);
  } finally {
    await close(fixture.server);
  }
});

test("SSH remote mode does not expose local Connections administration through its forward", async () => {
  const fixture = await listen(true, undefined, false);
  try {
    const status = await post(fixture.url, "/api/remote/admin/status");
    assert.equal(status.status, 403);
    assert.equal(fixture.verifyCalls, 1);
  } finally {
    await close(fixture.server);
  }
});

test("local Connections status reports disabled remote access", async () => {
  const fixture = await listen(false);
  try {
    const status = await post(fixture.url, "/api/remote/admin/status");
    assert.deepEqual(await status.json(), {
      remoteEnabled: false,
      descriptor: null,
      sessions: [],
    });
    assert.equal((await post(fixture.url, "/api/remote/admin/pair")).status, 404);
  } finally {
    await close(fixture.server);
  }
});
