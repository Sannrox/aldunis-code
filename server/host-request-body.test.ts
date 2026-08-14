import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { DEFAULT_PREFERENCES } from "./preferences.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import { LocalStateStore } from "./state.ts";

async function sendFragmentedJson(port: number, route: string, body: Buffer, fragmentBytes = 1) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const response: Buffer[] = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => response.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(response).toString("utf8");
      const separator = raw.indexOf("\r\n\r\n");
      const head = separator === -1 ? raw : raw.slice(0, separator);
      const responseBody = separator === -1 ? "" : raw.slice(separator + 4);
      const status = Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1]);
      resolve({ status, body: responseBody });
    });
    socket.on("connect", () => {
      const request = [
        `POST ${route} HTTP/1.1\r\n`,
        `Host: 127.0.0.1:${port}\r\n`,
        "Content-Type: application/json\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Connection: close\r\n",
        "\r\n",
      ];
      for (let offset = 0; offset < body.byteLength; offset += fragmentBytes) {
        const chunk = body.subarray(offset, offset + fragmentBytes);
        request.push(`${chunk.byteLength.toString(16)}\r\n${chunk.toString("latin1")}\r\n`);
      }
      request.push("0\r\n\r\n");
      socket.write(request.join(""));
    });
  });
}

test("remote authentication and routing share exact compacted request bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-request-body-"));
  let authenticatedBody: Buffer | undefined;
  const remoteAuth = {
    verify: async (_request: unknown, body: Buffer) => {
      authenticatedBody = body;
      return {};
    },
  } as unknown as RemoteAuth;
  const server = createLocalHost({
    dist: directory,
    state: new LocalStateStore(join(directory, "state")),
    remoteAuth,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const body = Buffer.from(`${JSON.stringify(DEFAULT_PREFERENCES)}${" ".repeat(1_024)}`);

  try {
    const response = await sendFragmentedJson(port, "/api/preferences/save", body);
    assert.equal(response.status, 200);
    assert.deepEqual(authenticatedBody, body);
    assert.match(response.body, /schemaVersion/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fragmented bodies still fail with 413 above the route ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-request-overflow-"));
  const server = createLocalHost({
    dist: directory,
    state: new LocalStateStore(join(directory, "state")),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const body = Buffer.from(`{}${" ".repeat(128 * 1_024)}`);

  try {
    const response = await sendFragmentedJson(port, "/api/preferences/save", body, 512);
    assert.equal(response.status, 413, response.body);
    assert.match(response.body, /Request body is too large/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fragmented malformed JSON still fails as invalid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-request-invalid-"));
  const server = createLocalHost({
    dist: directory,
    state: new LocalStateStore(join(directory, "state")),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await sendFragmentedJson(
      port,
      "/api/preferences/save",
      Buffer.from("not-json"),
    );
    assert.equal(response.status, 400, response.body);
    assert.match(response.body, /Request body must be valid JSON/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
