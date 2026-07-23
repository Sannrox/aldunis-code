import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { RepositoryError } from "./repository.ts";

const execFileAsync = promisify(execFile);
export const MAX_DIFF_BYTES = 256 * 1024;

export type ChangeState = "added" | "modified" | "deleted" | "renamed" | "binary" | "oversized";

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  state: ChangeState;
  additions: number | null;
  deletions: number | null;
}

export interface FileDiff extends ChangedFile {
  identity: string;
  lines: DiffLine[];
  patch: string | null;
  message: string | null;
}

export interface DiffLine {
  index: number;
  side: "context" | "addition" | "deletion" | "metadata";
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

function parseDiffLines(patch: string | null): DiffLine[] {
  if (!patch) return [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return patch.split("\n").map((content, index): DiffLine => {
    const hunk = content.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { index, side: "metadata", oldLine: null, newLine: null, content };
    }
    if (oldLine === null || newLine === null || content.startsWith("\\ No newline")) {
      return { index, side: "metadata", oldLine: null, newLine: null, content };
    }
    if (content.startsWith("+") && !content.startsWith("+++")) {
      const line = { index, side: "addition" as const, oldLine: null, newLine, content };
      newLine += 1;
      return line;
    }
    if (content.startsWith("-") && !content.startsWith("---")) {
      const line = { index, side: "deletion" as const, oldLine, newLine: null, content };
      oldLine += 1;
      return line;
    }
    const line = { index, side: "context" as const, oldLine, newLine, content };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function finalizeDiff(change: ChangedFile, patch: string | null, message: string | null): FileDiff {
  const identity = createHash("sha256")
    .update(JSON.stringify({
      path: change.path,
      previousPath: change.previousPath,
      state: change.state,
      patch,
      message,
    }))
    .digest("hex");
  return { ...change, identity, lines: parseDiffLines(patch), patch, message };
}

function git(worktree: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  return execFileAsync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer,
  });
}

function safeRelativePath(worktree: string, candidate: string): string {
  if (!candidate || isAbsolute(candidate) || candidate.includes("\0")) {
    throw new RepositoryError("Select a changed file inside the active worktree.");
  }
  const resolved = resolve(worktree, candidate);
  const fromRoot = relative(worktree, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new RepositoryError("The requested path escapes the active worktree.", 403);
  }
  return fromRoot;
}

function baseState(code: string): Exclude<ChangeState, "binary" | "oversized"> {
  if (code === "??" || code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R") || code.includes("C")) return "renamed";
  return "modified";
}

async function isOversized(worktree: string, path: string, deleted: boolean): Promise<boolean> {
  let size = 0;
  if (!deleted) {
    try {
      size = (await stat(resolve(worktree, path))).size;
    } catch {
      // The status may change between discovery and inspection.
    }
  }
  try {
    const result = await git(worktree, ["cat-file", "-s", `HEAD:${path}`]);
    size = Math.max(size, Number(result.stdout.trim()) || 0);
  } catch {
    // Added files do not have a HEAD object.
  }
  return size > MAX_DIFF_BYTES;
}

async function isBinary(worktree: string, path: string, untracked: boolean): Promise<boolean> {
  if (untracked) {
    try {
      return (await readFile(resolve(worktree, path))).subarray(0, 8_000).includes(0);
    } catch {
      return false;
    }
  }
  const result = await git(worktree, ["diff", "--numstat", "HEAD", "--", path]);
  return result.stdout.split("\n").some((line) => line.startsWith("-\t-\t"));
}

async function counts(worktree: string, path: string, untracked: boolean): Promise<[number | null, number | null]> {
  if (untracked) {
    try {
      const content = await readFile(resolve(worktree, path), "utf8");
      return [content.length ? content.split(/\r?\n/).length : 0, 0];
    } catch {
      return [null, null];
    }
  }
  const result = await git(worktree, ["diff", "--numstat", "HEAD", "--", path]);
  const line = result.stdout.split("\n").find(Boolean);
  if (!line) return [0, 0];
  const [added, deleted] = line.split("\t");
  return [Number.isFinite(Number(added)) ? Number(added) : null, Number.isFinite(Number(deleted)) ? Number(deleted) : null];
}

export async function listChangedFiles(worktree: string): Promise<ChangedFile[]> {
  const result = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--find-renames"]);
  const fields = result.stdout.split("\0");
  const entries: Array<{
    code: string;
    path: string;
    previousPath: string | null;
    initial: Exclude<ChangeState, "binary" | "oversized">;
  }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = safeRelativePath(worktree, field.slice(3));
    const renamed = code.includes("R") || code.includes("C");
    const previousPath = renamed ? safeRelativePath(worktree, fields[++index] ?? "") : null;
    entries.push({ code, path, previousPath, initial: baseState(code) });
  }

  // Git reports an unstaged move as one deletion and one untracked addition.
  // Pair exact object matches without staging or otherwise changing user work.
  const deletedByHash = new Map<string, typeof entries[number]>();
  for (const entry of entries.filter((item) => item.initial === "deleted")) {
    try {
      const object = await git(worktree, ["rev-parse", `HEAD:${entry.path}`]);
      deletedByHash.set(object.stdout.trim(), entry);
    } catch {
      // A concurrently changed index can make the old object unavailable.
    }
  }
  for (const entry of entries.filter((item) => item.code === "??")) {
    try {
      const object = await git(worktree, ["hash-object", "--", entry.path]);
      const deleted = deletedByHash.get(object.stdout.trim());
      if (deleted) {
        entry.initial = "renamed";
        entry.previousPath = deleted.path;
        entries.splice(entries.indexOf(deleted), 1);
        deletedByHash.delete(object.stdout.trim());
      }
    } catch {
      // The file may disappear between status and hashing.
    }
  }

  const changes: ChangedFile[] = [];
  for (const entry of entries) {
    const { code, path, previousPath, initial } = entry;
    const oversized = await isOversized(worktree, path, initial === "deleted");
    const binary = !oversized && await isBinary(worktree, path, code === "??");
    const [additions, deletions] = await counts(worktree, path, code === "??");
    changes.push({
      path,
      previousPath,
      state: oversized ? "oversized" : binary ? "binary" : initial,
      additions,
      deletions,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readFileDiff(worktree: string, requestedPath: string): Promise<FileDiff> {
  const path = safeRelativePath(worktree, requestedPath);
  const change = (await listChangedFiles(worktree)).find((item) => item.path === path);
  if (!change) throw new RepositoryError("The selected file is no longer changed.", 404);
  if (change.state === "binary") {
    return finalizeDiff(change, null, "Binary content is not rendered.");
  }
  if (change.state === "oversized") {
    return finalizeDiff(change, null, `Diff exceeds the ${MAX_DIFF_BYTES / 1024} KiB review limit.`);
  }
  if (change.state === "renamed" && change.previousPath) {
    return finalizeDiff(
      change,
      [
        `diff --git a/${change.previousPath} b/${path}`,
        "similarity index 100%",
        `rename from ${change.previousPath}`,
        `rename to ${path}`,
      ].join("\n"),
      null,
    );
  }
  if (change.state === "added") {
    const content = await readFile(resolve(worktree, path), "utf8");
    const lines = content.split(/\r?\n/);
    const patch = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    return finalizeDiff(change, patch, null);
  }
  const result = await git(worktree, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path], MAX_DIFF_BYTES * 2);
  return finalizeDiff(
    change,
    result.stdout || null,
    result.stdout ? null : "No textual diff is available.",
  );
}
