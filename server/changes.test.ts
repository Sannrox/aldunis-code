import assert from "node:assert/strict";
import { mkdtemp, rename, rm, truncate, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { listChangedFiles, MAX_DIFF_BYTES, readFileDiff } from "./changes.ts";

const execFileAsync = promisify(execFile);

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

test("text diffs are structured while binary and oversized content remain hidden", async () => {
  const root = await fixture();
  assert.match((await readFileDiff(root, "modified.txt")).patch ?? "", /^diff --git/m);
  assert.match((await readFileDiff(root, "added.txt")).patch ?? "", /^\+one/m);
  assert.equal((await readFileDiff(root, "binary.dat")).patch, null);
  assert.equal((await readFileDiff(root, "large.txt")).patch, null);
  await assert.rejects(() => readFileDiff(root, "../outside"), /escapes/);
});
