import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createLocalHost, pipeStaticAsset, serveStatic, StaticAssetAdmission } from "./host.ts";
import { PreviewManager } from "./preview.ts";
import { LocalStateStore } from "./state.ts";

const STATIC_LIFECYCLE_TIMEOUT_MS = 10_000;

function assertFormerPositionalInterfaceDoesNotTypeCheck() {
  // @ts-expect-error The host seam accepts one named options object.
  createLocalHost("dist", new LocalStateStore());
}
void assertFormerPositionalInterfaceDoesNotTypeCheck;

class ObservableStaticAssetAdmission extends StaticAssetAdmission {
  readonly #waiters = new Set<(count: number) => void>();

  override tryAcquire(): (() => void) | null {
    const release = super.tryAcquire();
    if (!release) return null;
    this.#notify();
    return () => {
      release();
      this.#notify();
    };
  }

  waitForActive(expected: number, label: string): Promise<void> {
    if (this.activeCount === expected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(onCount);
        reject(
          new assert.AssertionError({
            actual: this.activeCount,
            expected,
            message: `timed out waiting for ${label}`,
            operator: "strictEqual",
          }),
        );
      }, STATIC_LIFECYCLE_TIMEOUT_MS);
      const onCount = (count: number) => {
        if (count !== expected) return;
        clearTimeout(timer);
        this.#waiters.delete(onCount);
        resolve();
      };
      this.#waiters.add(onCount);
    });
  }

  #notify(): void {
    const count = this.activeCount;
    for (const waiter of this.#waiters) waiter(count);
  }
}

type HeldStaticResponse = PassThrough & {
  statusCode: number;
  responseHeaders: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): HeldStaticResponse;
  headed: Promise<number>;
};

function createHeldStaticResponse(): HeldStaticResponse {
  let resolveHead!: (status: number) => void;
  const stream = new PassThrough({ highWaterMark: 1 }) as HeldStaticResponse;
  stream.statusCode = 0;
  stream.responseHeaders = {};
  stream.headed = new Promise((resolve) => {
    resolveHead = resolve;
  });
  stream.writeHead = (status, headers) => {
    stream.statusCode = status;
    stream.responseHeaders = headers;
    resolveHead(status);
    return stream;
  };
  return stream;
}

async function waitForHeaded(response: HeldStaticResponse, label: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}`));
    }, STATIC_LIFECYCLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([response.headed, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

test("static asset admission rejects overflow before opening files and recovers after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-static-admission-"));
  const asset = join(directory, "asset.js");
  await writeFile(asset, "x".repeat(1024 * 1024));
  const admission = new ObservableStaticAssetAdmission(2);
  const request = { url: "/asset.js" } as IncomingMessage;
  const first = createHeldStaticResponse();
  const second = createHeldStaticResponse();
  const recovered = createHeldStaticResponse();

  try {
    await serveStatic(request, first as unknown as ServerResponse, directory, admission);
    await serveStatic(request, second as unknown as ServerResponse, directory, admission);
    await admission.waitForActive(2, "two admitted static streams");
    assert.equal(await waitForHeaded(first, "first static stream headers"), 200);
    assert.equal(await waitForHeaded(second, "second static stream headers"), 200);

    const overflow = createHeldStaticResponse();
    await serveStatic(request, overflow as unknown as ServerResponse, directory, admission);
    assert.equal(overflow.statusCode, 503);
    assert.equal(overflow.responseHeaders["retry-after"], "1");
    assert.equal(overflow.writableEnded, true);
    assert.equal(admission.activeCount, 2);

    first.destroy();
    await first.closed;
    await admission.waitForActive(1, "release after the first stream closes");

    await serveStatic(request, recovered as unknown as ServerResponse, directory, admission);
    await admission.waitForActive(2, "recovered static stream admission");
    assert.equal(await waitForHeaded(recovered, "recovered static stream headers"), 200);

    second.destroy();
    recovered.destroy();
    await Promise.all([second.closed, recovered.closed]);
    await admission.waitForActive(0, "all static streams released");
  } finally {
    first.destroy();
    second.destroy();
    recovered.destroy();
    await rm(directory, { recursive: true, force: true });
  }
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

test("local host exposes idempotent cleanup that waits for preview termination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-host-cleanup-"));
  let releasePreviewCleanup!: () => void;
  let cleanupCalls = 0;
  const previews = new PreviewManager();
  previews.stopAll = async () => {
    cleanupCalls += 1;
    await new Promise<void>((resolve) => {
      releasePreviewCleanup = resolve;
    });
  };
  const server = createLocalHost({
    dist: directory,
    state: new LocalStateStore(join(directory, "state")),
    previews,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  let settled = false;
  const first = server.closeResources().then(() => {
    settled = true;
  });
  const second = server.closeResources();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(cleanupCalls, 1);
  releasePreviewCleanup();
  await Promise.all([first, second]);
  assert.equal(settled, true);
  assert.equal(cleanupCalls, 1);
  await rm(directory, { recursive: true, force: true });
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
