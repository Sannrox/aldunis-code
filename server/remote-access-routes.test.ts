import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleRemoteAccessRoute } from "./remote-access-routes.ts";
import { RemoteAuthError } from "./remote-auth.ts";

const request = { headers: { host: "localhost:4177" }, socket: {} } as IncomingMessage;
const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    managed: false,
    localControlRequest: true,
    readJson: unused,
    sendJson: () => assert.fail("must not respond"),
    ...overrides,
  };
}

test("remote access module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleRemoteAccessRoute("/api/state/load", request, response, context() as never),
    false,
  );
});

test("remote administration fails closed outside local control and in managed mode", async () => {
  for (const overrides of [{ localControlRequest: false }, { managed: true }]) {
    await assert.rejects(
      handleRemoteAccessRoute(
        "/api/remote/admin/status",
        request,
        response,
        context(overrides) as never,
      ),
      (error: unknown) => error instanceof RemoteAuthError && error.status === 403,
    );
  }
});

test("remote administration projects disabled and enabled status", async () => {
  const bodies: unknown[] = [];
  const sendJson = (_response: ServerResponse, status: number, body: unknown) => {
    assert.equal(status, 200);
    bodies.push(body);
  };
  await handleRemoteAccessRoute(
    "/api/remote/admin/status",
    request,
    response,
    context({ sendJson }) as never,
  );
  await handleRemoteAccessRoute(
    "/api/remote/admin/status",
    request,
    response,
    context({
      remoteAuth: {
        descriptor: async () => ({ hostId: "host-1" }),
        listSessions: async () => [{ id: "session-1" }],
      },
      sendJson,
    }) as never,
  );
  assert.deepEqual(bodies, [
    { remoteEnabled: false, descriptor: null, sessions: [] },
    { remoteEnabled: true, descriptor: { hostId: "host-1" }, sessions: [{ id: "session-1" }] },
  ]);
});

test("remote administration issues pairing links from the configured origin", async () => {
  await handleRemoteAccessRoute(
    "/api/remote/admin/pair",
    request,
    response,
    context({
      publicOrigin: "https://code.example.test/path",
      remoteAuth: {
        issuePairing: async () => ({ id: "pair-1", credential: "secret", expiresAt: "later" }),
      },
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, {
          id: "pair-1",
          credential: "secret",
          expiresAt: "later",
          pairingUrl: "https://code.example.test/#pair=secret",
        });
      },
    }) as never,
  );
});

test("remote administration rejects an unready configured origin", async () => {
  let issueCalls = 0;
  await assert.rejects(
    handleRemoteAccessRoute(
      "/api/remote/admin/pair",
      request,
      response,
      context({
        publicOrigin: () => undefined,
        remoteAuth: {
          issuePairing: async () => {
            issueCalls += 1;
            return { credential: "secret" };
          },
        },
      }) as never,
    ),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 503,
  );
  assert.equal(issueCalls, 0);
});

test("remote administration validates and revokes one session", async () => {
  await assert.rejects(
    handleRemoteAccessRoute(
      "/api/remote/admin/revoke",
      request,
      response,
      context({ remoteAuth: {}, readJson: async () => ({ sessionId: " " }) }) as never,
    ),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 400,
  );
  await handleRemoteAccessRoute(
    "/api/remote/admin/revoke",
    request,
    response,
    context({
      remoteAuth: { revoke: async (id: string) => id === "session-1" },
      readJson: async () => ({ sessionId: "session-1" }),
      sendJson: (_response: ServerResponse, status: number, body: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(body, { revoked: true });
      },
    }) as never,
  );
});

test("device pairing preserves managed and disabled admission", async () => {
  await assert.rejects(
    handleRemoteAccessRoute(
      "/api/remote/pair",
      request,
      response,
      context({ managed: true }) as never,
    ),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 404,
  );
  await assert.rejects(
    handleRemoteAccessRoute("/api/remote/pair", request, response, context() as never),
    (error: unknown) => error instanceof RemoteAuthError && error.status === 404,
  );
});

test("device pairing delegates the untouched request to RemoteAuth", async () => {
  const body = { credential: "secret", label: "Browser", publicKey: { kty: "EC" } };
  await handleRemoteAccessRoute(
    "/api/remote/pair",
    request,
    response,
    context({
      readJson: async () => body,
      remoteAuth: {
        pair: async (input: unknown) => {
          assert.equal(input, body);
          return { sessionId: "session-1" };
        },
      },
      sendJson: (_response: ServerResponse, status: number, result: unknown) => {
        assert.equal(status, 200);
        assert.deepEqual(result, { sessionId: "session-1" });
      },
    }) as never,
  );
});

test("remote descriptor distinguishes local, remote, and managed modes", async () => {
  const bodies: unknown[] = [];
  const sendJson = (_response: ServerResponse, _status: number, body: unknown) => bodies.push(body);
  await handleRemoteAccessRoute(
    "/api/remote/descriptor",
    request,
    response,
    context({ sendJson }) as never,
  );
  await handleRemoteAccessRoute(
    "/api/remote/descriptor",
    request,
    response,
    context({ remoteAuth: { descriptor: async () => ({ hostId: "host-1" }) }, sendJson }) as never,
  );
  await handleRemoteAccessRoute(
    "/api/remote/descriptor",
    request,
    response,
    context({ managed: true, sendJson }) as never,
  );
  assert.deepEqual(bodies, [
    { remoteEnabled: false },
    { remoteEnabled: true, hostId: "host-1" },
    { remoteEnabled: false, hostedMode: true },
  ]);
});
