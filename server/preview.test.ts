import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { assertPreviewOrigin, PreviewError, PreviewManager } from "./preview.ts";

test("preview origins are loopback-only and credentials are rejected", () => {
  assert.equal(assertPreviewOrigin("http://localhost:4173/app"), "http://localhost:4173");
  assert.equal(assertPreviewOrigin("https://127.0.0.1:8443"), "https://127.0.0.1:8443");
  for (const value of [
    "https://example.com",
    "file:///tmp/index.html",
    "http://user:pass@localhost:4173",
  ]) {
    assert.throws(
      () => assertPreviewOrigin(value),
      (error: unknown) => error instanceof PreviewError && error.status === 403,
    );
  }
});

test("preview start approval is scoped, exact, and single-use", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({
      scripts: { dev: 'node -e "setTimeout(() => {}, 10000)"' },
    }),
  );
  const manager = new PreviewManager();
  const pending = await manager.requestStart("/repo", worktree, "http://localhost:4173");
  assert.equal(pending.command, "npm run dev");
  assert.equal(pending.state, "approval_pending");
  assert.throws(
    () => manager.decide(pending.id, { repository: "/repo", worktree: "/other" }, "allow_once"),
    (error: unknown) => error instanceof PreviewError && error.status === 403,
  );
  const denied = manager.decide(pending.id, { repository: "/repo", worktree }, "deny");
  assert.equal(denied.state, "stopped");
  // Terminal previews are released so the manager does not retain every past session.
  assert.throws(
    () => manager.decide(pending.id, { repository: "/repo", worktree }, "allow_once"),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
  assert.throws(
    () => manager.snapshot(pending.id),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});

test("missing development scripts fail visibly", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({ scripts: { test: "node test" } }),
  );
  await assert.rejects(
    () => new PreviewManager().requestStart("/repo", worktree, "http://localhost:4173"),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});

test("approved previews become available and stop explicitly", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-preview-"));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({
      scripts: {
        dev: `node -e "require('http').createServer((q,s)=>s.end('ready')).listen(${port},'127.0.0.1')"`,
      },
    }),
  );
  const manager = new PreviewManager();
  const pending = await manager.requestStart("/repo", worktree, `http://127.0.0.1:${port}`);
  manager.decide(pending.id, { repository: "/repo", worktree }, "allow_once");
  let snapshot = manager.snapshot(pending.id);
  for (let attempt = 0; attempt < 50 && snapshot.state === "starting"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = manager.snapshot(pending.id);
  }
  assert.equal(snapshot.state, "running");
  assert.equal(
    (await manager.stop(pending.id, { repository: "/repo", worktree })).state,
    "stopped",
  );
  assert.throws(
    () => manager.snapshot(pending.id),
    (error: unknown) => error instanceof PreviewError && error.status === 404,
  );
});
