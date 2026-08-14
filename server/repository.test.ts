import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertCheckpointable,
  captureCheckpoint,
  checkpointDiff,
  checkpointReference,
  classifyWorktree,
  collapseProjectsByRepository,
  constrainPath,
  copyIndexIntoLock,
  deleteCheckpointReferences,
  rewindCheckpoint,
} from "./repository.ts";
import { readCheckpointFileDiff } from "./changes.ts";
import { assertLoopbackHost } from "./host.ts";

const execFileAsync = promisify(execFile);

test("checkpoint index copies stream exact bytes through partial writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-index-copy-"));
  const source = join(root, "source-index");
  const destinationPath = join(root, "index.lock");
  const content = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  await writeFile(source, content);
  const destination = await open(destinationPath, "w");
  try {
    const copied = await copyIndexIntoLock(source, {
      write: (buffer, offset, length, position) =>
        destination.write(buffer, offset, Math.min(length, 31), position),
    });
    assert.equal(copied, content.length);
  } finally {
    await destination.close();
  }
  assert.deepEqual(await readFile(destinationPath), content);
});

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-checkpoint-"));
  await execFileAsync("git", ["init", "-q", root]);
  await writeFile(join(root, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "baseline",
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

test("collapsed projects retain the project record that owns each worktree root", async () => {
  const root = await gitFixture();
  const sibling = join(await mkdtemp(join(tmpdir(), "aldunis-code-member-roots-")), "worktree");
  await execFileAsync("git", [
    "-C",
    root,
    "worktree",
    "add",
    "-q",
    "-b",
    "fixture-worktree",
    sibling,
  ]);

  const [project] = await collapseProjectsByRepository([
    {
      id: "main-project",
      name: "fixture",
      root,
      openedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "worktree-project",
      name: "fixture",
      root: sibling,
      openedAt: "2026-01-02T00:00:00.000Z",
    },
  ]);

  assert.equal(project?.memberRoots["main-project"], root);
  assert.equal(project?.memberRoots["worktree-project"], sibling);
});

test("stable checkpoint identities produce diffs and rewind only the exact workspace", async () => {
  const root = await gitFixture();
  const baseline = await captureCheckpoint(root, false, checkpointReference("abc-123", "baseline"));
  await writeFile(join(root, "tracked.txt"), "completed\n");
  await writeFile(join(root, "created.txt"), "agent output\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
  const completed = await captureCheckpoint(
    root,
    true,
    checkpointReference("abc-123", "completed"),
  );

  assert.notEqual(completed.identity, baseline.identity);
  assert.equal((await captureCheckpoint(root, true)).identity, completed.identity);
  assert.deepEqual(
    (await checkpointDiff(root, baseline.identity, completed.identity)).map((file) => [
      file.path,
      file.state,
    ]),
    [
      ["created.txt", "added"],
      ["tracked.txt", "modified"],
    ],
  );

  assert.equal(
    (
      await execFileAsync("git", [
        "-C",
        root,
        "cat-file",
        "-t",
        checkpointReference("abc-123", "completed"),
      ])
    ).stdout.trim(),
    "tree",
  );
  assert.equal(
    (
      await execFileAsync("git", [
        "-C",
        root,
        "cat-file",
        "-t",
        `${checkpointReference("abc-123", "completed")}-index`,
      ])
    ).stdout.trim(),
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
  assert.equal(
    (await execFileAsync("git", ["-C", root, "diff", "--cached", "--name-only"])).stdout,
    "",
  );
  await deleteCheckpointReferences(completed.gitDirectory, "abc-123");
  await assert.rejects(() =>
    execFileAsync("git", [
      "--git-dir",
      completed.gitDirectory,
      "show-ref",
      checkpointReference("abc-123", "completed"),
    ]),
  );
});

test("checkpoint file diffs stay bound to the completed turn after later workspace edits", async () => {
  const root = await gitFixture();
  const baseline = await captureCheckpoint(root, false);
  await writeFile(join(root, "tracked.txt"), "completed\n");
  const completed = await captureCheckpoint(root, true);
  await writeFile(join(root, "tracked.txt"), "later operator edit\n");

  const diff = await readCheckpointFileDiff(
    root,
    baseline.identity,
    completed.identity,
    "tracked.txt",
  );
  assert.equal(diff.state, "modified");
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.match(diff.patch ?? "", /\+completed/);
  assert.doesNotMatch(diff.patch ?? "", /later operator edit/);
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
    () =>
      rewindCheckpoint(
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

test("clean checkpoint capture streams inventories larger than the Git buffer ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-large-checkpoint-"));
  try {
    await execFileAsync("git", ["init", "-q", root]);
    const directory = join(
      root,
      ...Array.from({ length: 4 }, (_, index) => `${index}-${"x".repeat(198)}`),
    );
    await mkdir(directory, { recursive: true });
    const paths = Array.from({ length: 5_200 }, (_, index) =>
      join(directory, `${index.toString().padStart(5, "0")}.txt`),
    );
    for (let index = 0; index < paths.length; index += 64) {
      await Promise.all(paths.slice(index, index + 64).map((path) => writeFile(path, "")));
    }
    await execFileAsync("git", ["-C", root, "add", "."], { maxBuffer: 16 * 1024 * 1024 });
    await execFileAsync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "large clean fixture",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );

    const checkpoint = await captureCheckpoint(root, false);
    const headTree = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD^{tree}"]);
    assert.equal(checkpoint.identity, headTree.stdout.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dirty checkpoint capture bounds compatibility scans below the status ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-dirty-checkpoint-"));
  try {
    await execFileAsync("git", ["init", "-q", root]);
    const empty = join(root, "empty");
    await writeFile(empty, "");
    const blob = await execFileAsync("git", ["-C", root, "hash-object", "-w", "empty"]);
    await rm(empty);
    const update = spawn("git", ["-C", root, "update-index", "--index-info"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    update.stderr.setEncoding("utf8");
    update.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    for (let index = 0; index < 40_000; index += 1) {
      const record = `100644 ${blob.stdout.trim()}\tf/${index.toString().padStart(6, "0")}\n`;
      if (!update.stdin.write(record)) {
        await new Promise<void>((resolve) => update.stdin.once("drain", resolve));
      }
    }
    update.stdin.end();
    const updateCode = await new Promise<number | null>((resolve, reject) => {
      update.once("error", reject);
      update.once("close", resolve);
    });
    assert.equal(updateCode, 0, stderr);
    const tree = await execFileAsync("git", ["-C", root, "write-tree"]);
    const commit = await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      tree.stdout.trim(),
      "-m",
      "dirty fixture",
    ]);
    await execFileAsync("git", ["-C", root, "update-ref", "HEAD", commit.stdout.trim()]);
    const status = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    assert.ok(Buffer.byteLength(status.stdout) < 4 * 1024 * 1024);

    await assertCheckpointable(root, true);
    const retainedTree = await execFileAsync("git", ["-C", root, "write-tree"]);
    assert.equal(retainedTree.stdout.trim(), tree.stdout.trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint capture ignores gitignored paths and refuses filtered/embedded content", async () => {
  const ignored = await gitFixture();
  await writeFile(join(ignored, ".gitignore"), "private.env\nnode_modules/\n");
  await writeFile(join(ignored, "private.env"), "local value\n");
  await mkdir(join(ignored, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(ignored, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  await execFileAsync("git", ["-C", ignored, "add", ".gitignore"]);
  await execFileAsync("git", [
    "-C",
    ignored,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "ignore local file",
  ]);
  // Ordinary ignored trees must not block checkpoints; they stay out of the snapshot.
  const baseline = await captureCheckpoint(ignored, false);
  assert.match(baseline.identity, /^[0-9a-f]{40}$/);
  const tree = await execFileAsync("git", [
    "-C",
    ignored,
    "ls-tree",
    "-r",
    "--name-only",
    baseline.identity,
  ]);
  assert.equal(tree.stdout.includes("private.env"), false);
  assert.equal(tree.stdout.includes("node_modules"), false);

  const filtered = await gitFixture();
  await writeFile(join(filtered, ".gitattributes"), "generated.bin filter=fixture\n");
  await execFileAsync("git", ["-C", filtered, "add", ".gitattributes"]);
  await execFileAsync("git", [
    "-C",
    filtered,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "mark filtered path",
  ]);
  await writeFile(join(filtered, "generated.bin"), "untracked generated content\n");
  await assert.rejects(() => captureCheckpoint(filtered, true), /Git filters/);

  const trackedFiltered = await gitFixture();
  await writeFile(join(trackedFiltered, ".gitattributes"), "generated.bin filter=fixture\n");
  await writeFile(join(trackedFiltered, "generated.bin"), "tracked generated content\n");
  await execFileAsync("git", ["-C", trackedFiltered, "add", ".gitattributes", "generated.bin"]);
  await execFileAsync("git", [
    "-C",
    trackedFiltered,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "track filtered path",
  ]);
  await assert.rejects(() => captureCheckpoint(trackedFiltered, false), /Git filters/);

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
    await assert.rejects(() =>
      rewindCheckpoint(
        root,
        completed.identity,
        completed.indexIdentity,
        completed.head,
        baseline.identity,
        baseline.indexIdentity,
      ),
    );
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
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "add legacy text",
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
