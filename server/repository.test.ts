import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyWorktree, constrainPath } from "./repository.ts";
import { assertLoopbackHost } from "./host.ts";

test("loopback host accepts local addresses and rejects network binds", () => {
  assert.doesNotThrow(() => assertLoopbackHost("127.0.0.1"));
  assert.doesNotThrow(() => assertLoopbackHost("::1"));
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /Refusing non-loopback bind/);
  assert.throws(() => assertLoopbackHost("192.168.1.10"), /Refusing non-loopback bind/);
});

test("constrained paths cannot escape the selected root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-code-path-"));
  const root = join(parent, "repository");
  const child = join(root, "src");
  const outside = join(parent, "outside");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(outside)]);

  assert.equal(await constrainPath(root, child), await realpath(child));
  await assert.rejects(() => constrainPath(root, outside), /escapes/);
});

test("symlinks are evaluated by canonical target", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-code-link-"));
  const root = join(parent, "repository");
  const outside = join(parent, "outside");
  const link = join(root, "linked");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await symlink(outside, link);

  await assert.rejects(() => constrainPath(root, link), /escapes/);
});

test("worktree state covers available, detached, missing, and inaccessible paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "aldunis-code-state-"));
  const available = join(parent, "available");
  const inaccessible = join(parent, "inaccessible");
  await Promise.all([mkdir(available), mkdir(inaccessible)]);

  assert.equal(await classifyWorktree(available, false), "available");
  assert.equal(await classifyWorktree(available, true), "detached");
  assert.equal(await classifyWorktree(join(parent, "missing"), false), "missing");

  await chmod(inaccessible, 0o000);
  try {
    assert.equal(await classifyWorktree(inaccessible, false), "inaccessible");
  } finally {
    await chmod(inaccessible, 0o700);
  }
});
