import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  captureCheckpoint,
  checkpointDiff,
  checkpointReference,
  classifyWorktree,
  constrainPath,
  deleteCheckpointReferences,
  rewindCheckpoint,
} from "./repository.ts";
import { assertLoopbackHost } from "./host.ts";

const execFileAsync = promisify(execFile);

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-checkpoint-"));
  await execFileAsync("git", ["init", "-q", root]);
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C", root,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "baseline",
  ]);
  return root;
}

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

test("stable checkpoint identities produce diffs and rewind only the exact workspace", async () => {
  const root = await gitFixture();
  const baseline = await captureCheckpoint(root, false, checkpointReference("abc-123", "baseline"));
  await writeFile(join(root, "tracked.txt"), "completed\n");
  await writeFile(join(root, "created.txt"), "agent output\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  const completed = await captureCheckpoint(root, true, checkpointReference("abc-123", "completed"));

  assert.notEqual(completed.identity, baseline.identity);
  assert.equal((await captureCheckpoint(root, true)).identity, completed.identity);
  assert.deepEqual(
    (await checkpointDiff(root, baseline.identity, completed.identity)).map((file) => [file.path, file.state]),
    [["created.txt", "added"], ["tracked.txt", "modified"]],
  );

  assert.equal(
    (await execFileAsync("git", ["-C", root, "cat-file", "-t", checkpointReference("abc-123", "completed")])).stdout.trim(),
    "tree",
  );
  assert.equal(
    (await execFileAsync("git", ["-C", root, "cat-file", "-t", `${checkpointReference("abc-123", "completed")}-index`])).stdout.trim(),
    "tree",
  );
  await rewindCheckpoint(
    root,
    completed.identity,
    completed.indexIdentity,
    completed.head,
    baseline.identity,
    baseline.indexIdentity,
  );
  assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "baseline\n");
  await assert.rejects(() => readFile(join(root, "created.txt"), "utf8"), /ENOENT/);
  assert.equal((await execFileAsync("git", ["-C", root, "diff", "--cached", "--name-only"])).stdout, "");
  await deleteCheckpointReferences(completed.gitDirectory, "abc-123");
  await assert.rejects(() => execFileAsync("git", [
    "--git-dir",
    completed.gitDirectory,
    "show-ref",
    checkpointReference("abc-123", "completed"),
  ]));
});

test("checkpoint capture and rewind fail safely for unrelated or concurrent work", async () => {
  const dirty = await gitFixture();
  await writeFile(join(dirty, "unrelated.txt"), "user work\n");
  await assert.rejects(() => captureCheckpoint(dirty, false), /untracked files/);

  const concurrent = await gitFixture();
  const baseline = await captureCheckpoint(concurrent, false);
  await writeFile(join(concurrent, "tracked.txt"), "completed\n");
  const completed = await captureCheckpoint(concurrent, true);
  await writeFile(join(concurrent, "tracked.txt"), "changed concurrently\n");
  await assert.rejects(
    () => rewindCheckpoint(
      concurrent,
      completed.identity,
      completed.indexIdentity,
      completed.head,
      baseline.identity,
      baseline.indexIdentity,
    ),
    /changed after this rewind/,
  );

  const linked = await gitFixture();
  await symlink("tracked.txt", join(linked, "new-link"));
  await assert.rejects(() => captureCheckpoint(linked, true), /symlink/);
});

test("checkpoint capture ignores gitignored paths and refuses filtered/embedded content", async () => {
  const ignored = await gitFixture();
  await writeFile(join(ignored, ".gitignore"), "private.env\nnode_modules/\n");
  await writeFile(join(ignored, "private.env"), "local value\n");
  await mkdir(join(ignored, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(ignored, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  await execFileAsync("git", ["-C", ignored, "add", ".gitignore"]);
  await execFileAsync("git", [
    "-C", ignored,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "ignore local file",
  ]);
  // Ordinary ignored trees must not block checkpoints; they stay out of the snapshot.
  const baseline = await captureCheckpoint(ignored, false);
  assert.match(baseline.identity, /^[0-9a-f]{40}$/);
  const tree = await execFileAsync("git", ["-C", ignored, "ls-tree", "-r", "--name-only", baseline.identity]);
  assert.equal(tree.stdout.includes("private.env"), false);
  assert.equal(tree.stdout.includes("node_modules"), false);

  const filtered = await gitFixture();
  await writeFile(join(filtered, ".gitattributes"), "generated.bin filter=fixture\n");
  await execFileAsync("git", ["-C", filtered, "add", ".gitattributes"]);
  await execFileAsync("git", [
    "-C", filtered,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "mark filtered path",
  ]);
  await writeFile(join(filtered, "generated.bin"), "untracked generated content\n");
  await assert.rejects(() => captureCheckpoint(filtered, true), /Git filters/);

  const embedded = await gitFixture();
  const nested = join(embedded, "nested");
  await execFileAsync("git", ["init", "-q", nested]);
  await writeFile(join(nested, "file.txt"), "nested repository content\n");
  await assert.rejects(() => captureCheckpoint(embedded, true), /embedded Git repository/);
});

test("rewind refuses a locked Git index before changing workspace files", async () => {
  const root = await gitFixture();
  const baseline = await captureCheckpoint(root, false);
  await writeFile(join(root, "tracked.txt"), "completed\n");
  const completed = await captureCheckpoint(root, true);
  await writeFile(join(root, ".git", "index.lock"), "concurrent git operation\n", { flag: "wx" });
  try {
    await assert.rejects(() => rewindCheckpoint(
      root,
      completed.identity,
      completed.indexIdentity,
      completed.head,
      baseline.identity,
      baseline.indexIdentity,
    ));
    assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "completed\n");
  } finally {
    await rm(join(root, ".git", "index.lock"), { force: true });
  }
});

test("rewind preserves non-UTF-8 tracked file bytes", async () => {
  const root = await gitFixture();
  const binaryLikePath = join(root, "legacy.txt");
  const baselineBytes = Buffer.from([0xff, 0xfe, 0x41, 0x0a]);
  const completedBytes = Buffer.from([0xff, 0xfe, 0x42, 0x0a]);
  await writeFile(binaryLikePath, baselineBytes);
  await execFileAsync("git", ["-C", root, "add", "legacy.txt"]);
  await execFileAsync("git", [
    "-C", root,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-qm", "add legacy text",
  ]);
  const baseline = await captureCheckpoint(root, false);
  await writeFile(binaryLikePath, completedBytes);
  const completed = await captureCheckpoint(root, true);

  await rewindCheckpoint(
    root,
    completed.identity,
    completed.indexIdentity,
    completed.head,
    baseline.identity,
    baseline.indexIdentity,
  );
  assert.deepEqual(await readFile(binaryLikePath), baselineBytes);
});
