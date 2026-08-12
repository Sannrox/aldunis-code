import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  listChangedFiles,
  MAX_DIFF_BYTES,
  readBoundedChangedFile,
  readFileDiff,
} from "./changes.ts";

const execFileAsync = promisify(execFile);

test("bounded changed-file reads accept the limit and reject overflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-change-read-"));
  const path = join(root, "untracked.txt");
  await writeFile(path, Buffer.alloc(MAX_DIFF_BYTES, 0x61));
  assert.equal((await readBoundedChangedFile(path))?.length, MAX_DIFF_BYTES);

  await truncate(path, MAX_DIFF_BYTES + 1);
  assert.equal(await readBoundedChangedFile(path), null);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-changes-"));
  const git = (...args: string[]) => execFileAsync("git", ["-C", root, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Aldunis Test");
  await Promise.all([
    writeFile(join(root, "modified.txt"), "before\n"),
    writeFile(join(root, "deleted.txt"), "deleted\n"),
    writeFile(join(root, "old-name.txt"), "renamed\n"),
    writeFile(join(root, "binary.dat"), "text\n"),
  ]);
  await git("add", ".");
  await git("commit", "-qm", "fixture");
  await writeFile(join(root, "modified.txt"), "after\n");
  await rm(join(root, "deleted.txt"));
  await rename(join(root, "old-name.txt"), join(root, "new-name.txt"));
  await writeFile(join(root, "added.txt"), "one\ntwo\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "large.txt"), "");
  await truncate(join(root, "large.txt"), MAX_DIFF_BYTES + 1);
  return root;
}

test("changed files expose added, modified, deleted, renamed, binary, and oversized states", async () => {
  const root = await fixture();
  const changes = await listChangedFiles(root);
  const states = new Map(changes.map((change) => [change.path, change]));
  assert.equal(states.get("added.txt")?.state, "added");
  assert.equal(states.get("modified.txt")?.state, "modified");
  assert.equal(states.get("deleted.txt")?.state, "deleted");
  assert.equal(states.get("new-name.txt")?.state, "renamed");
  assert.equal(states.get("new-name.txt")?.previousPath, "old-name.txt");
  assert.equal(states.get("binary.dat")?.state, "binary");
  assert.equal(states.get("large.txt")?.state, "oversized");
});

test("changed-file listing stops before and during abandoned work", async () => {
  const root = await fixture();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    listChangedFiles(root, alreadyAborted.signal),
    (error: unknown) => (error as Error).name === "AbortError",
  );

  const active = new AbortController();
  const listing = listChangedFiles(root, active.signal);
  setTimeout(() => active.abort(), 10);
  await assert.rejects(listing, (error: unknown) => (error as Error).name === "AbortError");
});

test("untracked-only listings skip rename snapshot candidate probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-code-untracked-changes-"));
  const traceRoot = await mkdtemp(join(tmpdir(), "aldunis-code-git-trace-"));
  const trace = join(traceRoot, "events.json");
  await execFileAsync("git", ["-C", root, "init", "-q"]);
  await writeFile(join(root, "untracked.txt"), "content\n");

  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    assert.deepEqual(await listChangedFiles(root), [
      {
        path: "untracked.txt",
        previousPath: null,
        state: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  const events = await readFile(trace, "utf8");
  const gitStarts = events
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
    .filter((event) => event.event === "start");
  assert.equal(gitStarts.filter((event) => event.argv?.includes("check-attr")).length, 0);
  assert.equal(gitStarts.filter((event) => event.argv?.includes("cat-file")).length, 0);
});

test("untracked local runtime state stays out of changed files", async () => {
  const root = await fixture();
  await mkdir(join(root, "data"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "data", "sekai.db"), Buffer.from([1, 2, 3])),
    writeFile(join(root, "data", "provider-registry-state.json"), "{}\n"),
    writeFile(join(root, "data", "sekai.sock.gateway-token"), "secret\n"),
    writeFile(join(root, "runtime.sqlite-wal"), Buffer.from([1, 2, 3])),
  ]);

  const beforeObjects = (
    await execFileAsync("git", ["-C", root, "count-objects", "-v"])
  ).stdout.match(/^count: (\d+)$/m)?.[1];
  const paths = (await listChangedFiles(root)).map((change) => change.path);
  const afterObjects = (
    await execFileAsync("git", ["-C", root, "count-objects", "-v"])
  ).stdout.match(/^count: (\d+)$/m)?.[1];
  assert.equal(paths.includes("data/sekai.db"), false);
  assert.equal(paths.includes("data/provider-registry-state.json"), false);
  assert.equal(paths.includes("data/sekai.sock.gateway-token"), false);
  assert.equal(paths.includes("runtime.sqlite-wal"), false);
  assert.equal(afterObjects, beforeObjects);
});

test("unstaged renames into runtime-looking paths remain reviewable", async () => {
  const root = await fixture();
  await writeFile(join(root, "tracked.db"), "tracked fixture\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.db"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "tracked database fixture"]);
  await mkdir(join(root, "data"), { recursive: true });
  await rename(join(root, "tracked.db"), join(root, "data", "renamed.db"));

  const renamed = (await listChangedFiles(root)).find(
    (change) => change.path === "data/renamed.db",
  );
  assert.equal(renamed?.state, "binary");
  assert.equal(renamed?.previousPath, "tracked.db");
  const diff = await readFileDiff(root, "data/renamed.db");
  assert.equal(diff.patch, null);
  assert.match(diff.message ?? "", /Binary content/);
});

test("edited unstaged renames remain reviewable", async () => {
  const root = await fixture();
  await writeFile(join(root, "tracked.db"), "one\ntwo\nthree\nfour\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.db"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "tracked database fixture"]);
  await execFileAsync("git", ["-C", root, "update-index", "--split-index"]);
  await rename(join(root, "tracked.db"), join(root, "edited-name.txt"));
  await writeFile(join(root, "edited-name.txt"), "one\ntwo\nchanged\nfour\n");

  const renamed = (await listChangedFiles(root)).find(
    (change) => change.path === "edited-name.txt",
  );
  assert.equal(renamed?.state, "renamed");
  assert.equal(renamed?.previousPath, "tracked.db");
  assert.equal(renamed?.additions, 1);
  assert.equal(renamed?.deletions, 1);
  const diff = await readFileDiff(root, "edited-name.txt");
  assert.match(diff.patch ?? "", /rename from tracked\.db/);
  assert.match(diff.patch ?? "", /^\+changed$/m);
});

test("edited renames into ignored runtime paths stay hidden", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), "/data/\n");
  await execFileAsync("git", ["-C", root, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "ignore local data"]);
  await writeFile(join(root, "tracked.db"), "one\ntwo\nthree\nfour\n");
  await execFileAsync("git", ["-C", root, "add", "tracked.db"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "tracked database fixture"]);
  await mkdir(join(root, "data"), { recursive: true });
  await rename(join(root, "tracked.db"), join(root, "data", "edited.db"));
  await writeFile(join(root, "data", "edited.db"), "one\ntwo\nchanged\nfour\n");

  const changes = await listChangedFiles(root);
  assert.equal(
    changes.some((change) => change.path === "data/edited.db"),
    false,
  );
  assert.equal(changes.find((change) => change.path === "tracked.db")?.state, "deleted");
});

test("oversized ignored renames remain visible without rendering content", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), "/data/\n");
  await execFileAsync("git", ["-C", root, "add", ".gitignore"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "ignore local data"]);
  await writeFile(join(root, "tracked.db"), Buffer.alloc(MAX_DIFF_BYTES + 1024, 65));
  await execFileAsync("git", ["-C", root, "add", "tracked.db"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "tracked database fixture"]);
  await mkdir(join(root, "data"), { recursive: true });
  await rename(join(root, "tracked.db"), join(root, "data", "renamed.db"));

  const renamed = (await listChangedFiles(root)).find(
    (change) => change.path === "data/renamed.db",
  );
  assert.equal(renamed?.state, "oversized");
  assert.equal(renamed?.previousPath, "tracked.db");
  assert.equal(renamed?.additions, null);
  assert.equal(renamed?.deletions, null);
  const diff = await readFileDiff(root, "data/renamed.db");
  assert.match(diff.message ?? "", /exceeds/);
});

test("oversized ordinary renames keep their previous path", async () => {
  const root = await fixture();
  await writeFile(join(root, "tracked-large.txt"), Buffer.alloc(MAX_DIFF_BYTES + 1024, 65));
  await execFileAsync("git", ["-C", root, "add", "tracked-large.txt"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "large text fixture"]);
  await rename(join(root, "tracked-large.txt"), join(root, "renamed-large.txt"));

  const renamed = (await listChangedFiles(root)).find(
    (change) => change.path === "renamed-large.txt",
  );
  assert.equal(renamed?.state, "oversized");
  assert.equal(renamed?.previousPath, "tracked-large.txt");
  assert.equal(renamed?.additions, null);
  assert.equal(renamed?.deletions, null);
});

test("symlink renames remain non-renderable", async () => {
  const root = await fixture();
  await writeFile(join(root, "symlink-target.txt"), "target\n");
  await symlink("symlink-target.txt", join(root, "tracked-link"));
  await execFileAsync("git", ["-C", root, "add", "symlink-target.txt", "tracked-link"]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "symlink fixture"]);
  await execFileAsync("git", ["-C", root, "mv", "tracked-link", "renamed-link"]);

  const renamed = (await listChangedFiles(root)).find((change) => change.path === "renamed-link");
  assert.equal(renamed?.state, "binary");
  assert.equal(renamed?.previousPath, "tracked-link");
  const diff = await readFileDiff(root, "renamed-link");
  assert.equal(diff.patch, null);
  assert.match(diff.message ?? "", /Binary content/);
});

test("text diffs are structured while binary and oversized content remain hidden", async () => {
  const root = await fixture();
  const modified = await readFileDiff(root, "modified.txt");
  assert.match(modified.patch ?? "", /^diff --git/m);
  assert.equal(modified.identity.length, 64);
  assert.deepEqual(
    modified.lines
      .filter((line) => line.side === "deletion" || line.side === "addition")
      .map((line) => [line.side, line.oldLine, line.newLine]),
    [
      ["deletion", 1, null],
      ["addition", null, 1],
    ],
  );
  assert.equal((await readFileDiff(root, "modified.txt")).identity, modified.identity);
  await writeFile(join(root, "modified.txt"), "changed again\n");
  assert.notEqual((await readFileDiff(root, "modified.txt")).identity, modified.identity);
  const added = await readFileDiff(root, "added.txt");
  assert.match(added.patch ?? "", /^\+one/m);
  // A file ending in a newline is two lines, not three: no phantom trailing addition.
  assert.match(added.patch ?? "", /^@@ -0,0 \+1,2 @@$/m);
  assert.deepEqual(
    added.lines
      .filter((line) => line.side === "addition")
      .map((line) => [line.newLine, line.content]),
    [
      [1, "+one"],
      [2, "+two"],
    ],
  );
  const addedStates = new Map(
    (await listChangedFiles(root)).map((change) => [change.path, change]),
  );
  assert.equal(addedStates.get("added.txt")?.additions, 2);
  assert.equal((await readFileDiff(root, "binary.dat")).patch, null);
  assert.equal((await readFileDiff(root, "large.txt")).patch, null);
  await assert.rejects(() => readFileDiff(root, "../outside"), /escapes/);
});
