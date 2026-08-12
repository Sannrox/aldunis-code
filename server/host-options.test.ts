import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createLocalHost, pipeStaticAsset } from "./host.ts";
import { LocalStateStore } from "./state.ts";

function assertFormerPositionalInterfaceDoesNotTypeCheck() {
  // @ts-expect-error The host seam accepts one named options object.
  createLocalHost("dist", new LocalStateStore());
}
void assertFormerPositionalInterfaceDoesNotTypeCheck;

test("static asset reads close with an aborted response", async () => {
  const source = new PassThrough();
  const response = new PassThrough();
  pipeStaticAsset(source, response as unknown as ServerResponse);

  const closed = new Promise<void>((resolve) => source.once("close", resolve));
  response.destroy();
  await closed;

  assert.equal(source.destroyed, true);
  assert.equal(response.listenerCount("close"), 0);
});

test("static asset reads never start for an already aborted response", async () => {
  const source = new PassThrough();
  const response = new PassThrough();
  response.destroy();

  const closed = new Promise<void>((resolve) => source.once("close", resolve));
  pipeStaticAsset(source, response as unknown as ServerResponse);
  await closed;

  assert.equal(source.destroyed, true);
  assert.equal(response.listenerCount("close"), 0);
});

test("local host options keep state and static content behind one named interface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-options-"));
  const dist = join(directory, "dist");
  const state = new LocalStateStore(join(directory, "state"));
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "named local host");

  const server = createLocalHost({ dist, state });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const api = await fetch(`${origin}/api/state/load`, { method: "POST" });
    assert.equal(api.status, 200);
    assert.deepEqual(((await api.json()) as { projects: unknown[] }).projects, []);

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "named local host");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing static assets return 404 without crashing the host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-static-missing-"));
  const dist = join(directory, "dist");
  const state = new LocalStateStore(join(directory, "state"));
  await mkdir(dist);

  const server = createLocalHost({ dist, state });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const missing = await fetch(origin);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not found");

    const api = await fetch(`${origin}/api/state/load`, { method: "POST" });
    assert.equal(api.status, 200);
    assert.deepEqual(((await api.json()) as { projects: unknown[] }).projects, []);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
});
