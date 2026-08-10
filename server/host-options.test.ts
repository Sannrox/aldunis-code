import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { LocalStateStore } from "./state.ts";

function assertFormerPositionalInterfaceDoesNotTypeCheck() {
  // @ts-expect-error The host seam accepts one named options object.
  createLocalHost("dist", new LocalStateStore());
}
void assertFormerPositionalInterfaceDoesNotTypeCheck;

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
