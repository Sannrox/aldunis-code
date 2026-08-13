import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkpointDiff, RepositoryError, type CheckpointFile } from "./repository.ts";
import { isComposerAttachmentPath, isLocalRuntimePath } from "./local-runtime.ts";

function isHiddenReviewPath(path: string): boolean {
  return isLocalRuntimePath(path) || isComposerAttachmentPath(path);
}

const execFileAsync = promisify(execFile);
export const MAX_DIFF_BYTES = 256 * 1024;
const CHANGED_FILE_READ_BUFFER_BYTES = 64 * 1024;
const MAX_RENAME_CANDIDATES = 128;
// Exact identity checks may read a runtime-looking file, but never beyond this
// bound. Larger local runtime artifacts remain outside the review surface.
const MAX_EXACT_RENAME_BYTES = 64 * 1024 * 1024;
const IGNORED_RUNTIME_PATHS = [
  ":(glob)**/*.db*",
  ":(glob)**/*.sqlite*",
  ":(glob)**/*.sqlite3*",
  ":(glob)data/**/*-state.json*",
  ":(glob)data/**/*.state*",
  ":(glob)data/**/*.lock",
  ":(glob)data/**/*.sock*",
];

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
    .update(
      JSON.stringify({
        path: change.path,
        previousPath: change.previousPath,
        state: change.state,
        patch,
        message,
      }),
    )
    .digest("hex");
  return { ...change, identity, lines: parseDiffLines(patch), patch, message };
}

function git(worktree: string, args: string[], maxBuffer = 4 * 1024 * 1024, signal?: AbortSignal) {
  return execFileAsync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer,
    signal,
  });
}

function gitWithEnvironment(
  worktree: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  maxBuffer = 4 * 1024 * 1024,
  signal?: AbortSignal,
) {
  return execFileAsync("git", ["-C", worktree, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer,
    env: environment,
    signal,
  });
}

type WorktreeSnapshot = {
  temporary: string;
  environment: NodeJS.ProcessEnv;
};

async function createWorktreeSnapshot(
  worktree: string,
  removePaths: string[] = [],
  addPaths: string[] = [],
  signal?: AbortSignal,
): Promise<WorktreeSnapshot> {
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(tmpdir(), "aldunis-changes-"));
  const indexPath = join(temporary, "index");
  try {
    const realIndex = (
      await git(worktree, ["rev-parse", "--git-path", "index"], undefined, signal)
    ).stdout.trim();
    const realObjects = (
      await git(worktree, ["rev-parse", "--git-path", "objects"], undefined, signal)
    ).stdout.trim();
    const temporaryObjects = join(temporary, "objects");
    await mkdir(temporaryObjects);
    signal?.throwIfAborted();
    const environment = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: temporaryObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        isAbsolute(realObjects) ? realObjects : resolve(worktree, realObjects),
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(delimiter),
    };
    const sourceIndex = isAbsolute(realIndex) ? realIndex : resolve(worktree, realIndex);
    const sharedIndexDirectories = new Set([
      dirname(sourceIndex),
      resolve(
        worktree,
        (await git(worktree, ["rev-parse", "--git-common-dir"], undefined, signal)).stdout.trim(),
      ),
    ]);
    for (const directory of sharedIndexDirectories) {
      signal?.throwIfAborted();
      try {
        for (const name of await readdir(directory)) {
          signal?.throwIfAborted();
          if (name.startsWith("sharedindex.")) {
            await copyFile(join(directory, name), join(temporary, name));
            signal?.throwIfAborted();
          }
        }
      } catch {
        signal?.throwIfAborted();
        // Repositories without a split index have no shared files to copy.
      }
    }
    await copyFile(sourceIndex, indexPath);
    signal?.throwIfAborted();
    for (const path of removePaths) {
      signal?.throwIfAborted();
      await gitWithEnvironment(
        worktree,
        ["update-index", "--force-remove", "--", path],
        environment,
        undefined,
        signal,
      );
    }
    for (const path of addPaths) {
      signal?.throwIfAborted();
      const details = await lstat(resolve(worktree, path));
      signal?.throwIfAborted();
      if (!details.isFile() || details.size > MAX_DIFF_BYTES) continue;
      const object = await gitWithEnvironment(
        worktree,
        ["hash-object", "-w", "--no-filters", "--", path],
        environment,
        MAX_DIFF_BYTES * 2,
        signal,
      );
      signal?.throwIfAborted();
      const mode = details.mode & 0o111 ? "100755" : "100644";
      await gitWithEnvironment(
        worktree,
        ["update-index", "--add", "--cacheinfo", `${mode},${object.stdout.trim()},${path}`],
        environment,
        undefined,
        signal,
      );
    }
    return { temporary, environment };
  } catch {
    try {
      await rm(temporary, { recursive: true, force: true });
    } catch {
      // The snapshot is disposable; cleanup must not replace the review error.
    }
    signal?.throwIfAborted();
    throw new RepositoryError("The worktree could not be snapshotted for change review.", 409);
  }
}

async function disposeWorktreeSnapshot(snapshot: WorktreeSnapshot): Promise<void> {
  try {
    await rm(snapshot.temporary, { recursive: true, force: true });
  } catch {
    // The snapshot is disposable; cleanup must not replace the review result.
  }
}

async function withWorktreeSnapshot<T>(
  worktree: string,
  callback: (environment: NodeJS.ProcessEnv) => Promise<T>,
  removePaths: string[] = [],
  addPaths: string[] = [],
): Promise<T> {
  const snapshot = await createWorktreeSnapshot(worktree, removePaths, addPaths);
  try {
    return await callback(snapshot.environment);
  } finally {
    await disposeWorktreeSnapshot(snapshot);
  }
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

async function isOversized(
  worktree: string,
  path: string,
  deleted: boolean,
  previousPath: string | null,
  untracked: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let size = 0;
  if (!deleted) {
    try {
      size = (await stat(resolve(worktree, path))).size;
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      // The status may change between discovery and inspection.
    }
  }
  if (!untracked || previousPath) {
    try {
      const result = await git(
        worktree,
        ["cat-file", "-s", `HEAD:${previousPath ?? path}`],
        undefined,
        signal,
      );
      size = Math.max(size, Number(result.stdout.trim()) || 0);
    } catch {
      signal?.throwIfAborted();
      // The status may change between discovery and inspection.
    }
  }
  return size > MAX_DIFF_BYTES;
}

type ChangeEntry = {
  code: string;
  path: string;
  previousPath: string | null;
  initial: Exclude<ChangeState, "binary" | "oversized">;
  symlink?: boolean;
  nonRenderable?: boolean;
};

async function hasGitConversion(
  worktree: string,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const result = await git(
      worktree,
      ["check-attr", "-z", "filter", "working-tree-encoding", "--", path],
      undefined,
      signal,
    );
    const fields = result.stdout.split("\0");
    for (let index = 1; index < fields.length; index += 3) {
      const value = fields[index + 1];
      if (value && value !== "unspecified" && value !== "unset") return true;
    }
    return false;
  } catch {
    signal?.throwIfAborted();
    return true;
  }
}

async function listIgnoredRuntimePaths(worktree: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  try {
    const result = await execFileAsync(
      "git",
      [
        "-C",
        worktree,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ...IGNORED_RUNTIME_PATHS,
      ],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 512 * 1024, signal },
    );
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => safeRelativePath(worktree, path))
      .filter((path) => isLocalRuntimePath(path));
  } catch {
    signal?.throwIfAborted();
    // Ignored runtime state is intentionally best-effort and stays hidden if
    // a repository is too large or changes during candidate discovery.
    return [];
  }
}

async function boundedSnapshotPaths(
  worktree: string,
  paths: string[],
  limit = MAX_RENAME_CANDIDATES,
  signal?: AbortSignal,
): Promise<string[]> {
  const candidates: string[] = [];
  for (const path of [...new Set(paths)]) {
    signal?.throwIfAborted();
    if (candidates.length >= limit) break;
    try {
      const details = await lstat(resolve(worktree, path));
      signal?.throwIfAborted();
      if (
        details.isFile() &&
        details.size <= MAX_DIFF_BYTES &&
        !(await hasGitConversion(worktree, path, signal))
      ) {
        candidates.push(path);
      }
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and snapshot preparation.
    }
  }
  return candidates;
}

async function pairExactRenames(
  worktree: string,
  entries: ChangeEntry[],
  candidatePredicate: (entry: ChangeEntry) => boolean,
  mark: (entry: ChangeEntry) => void,
  signal?: AbortSignal,
): Promise<void> {
  const deleted = entries.filter((entry) => entry.initial === "deleted");
  if (deleted.length === 0) return;
  const candidates = entries
    .filter((entry) => entry.code === "??" && candidatePredicate(entry))
    .slice(0, MAX_RENAME_CANDIDATES);
  const sourceObjects = new Map<string, string>();
  for (const entry of deleted.slice(0, MAX_RENAME_CANDIDATES)) {
    signal?.throwIfAborted();
    try {
      const size = Number(
        (
          await git(worktree, ["cat-file", "-s", `HEAD:${entry.path}`], undefined, signal)
        ).stdout.trim(),
      );
      if (size > MAX_EXACT_RENAME_BYTES) continue;
      if (await hasGitConversion(worktree, entry.path, signal)) continue;
      const object = await git(worktree, ["rev-parse", `HEAD:${entry.path}`], undefined, signal);
      sourceObjects.set(entry.path, object.stdout.trim());
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and rename matching.
    }
  }
  for (const entry of candidates) {
    signal?.throwIfAborted();
    try {
      const details = await lstat(resolve(worktree, entry.path));
      signal?.throwIfAborted();
      if (!details.isFile() || details.size > MAX_EXACT_RENAME_BYTES) continue;
      if (await hasGitConversion(worktree, entry.path, signal)) continue;
      const object = await git(
        worktree,
        ["hash-object", "--no-filters", "--", entry.path],
        undefined,
        signal,
      );
      const previousPath = [...sourceObjects.entries()].find(
        ([, sourceObject]) => sourceObject === object.stdout.trim(),
      )?.[0];
      if (!previousPath) continue;
      entry.initial = "renamed";
      entry.previousPath = previousPath;
      mark(entry);
      const deletedEntry = entries.find(
        (candidate) => candidate.initial === "deleted" && candidate.path === previousPath,
      );
      if (deletedEntry) entries.splice(entries.indexOf(deletedEntry), 1);
      sourceObjects.delete(previousPath);
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and rename matching.
    }
  }
}

async function pairExactRuntimeRenames(
  worktree: string,
  entries: ChangeEntry[],
  signal?: AbortSignal,
): Promise<void> {
  await pairExactRenames(
    worktree,
    entries,
    (entry) => isLocalRuntimePath(entry.path),
    (entry) => {
      entry.nonRenderable = true;
    },
    signal,
  );
}

async function markSpecialRenames(
  worktree: string,
  entries: ChangeEntry[],
  signal?: AbortSignal,
): Promise<void> {
  for (const entry of [...entries]) {
    signal?.throwIfAborted();
    if (!entry.previousPath) continue;
    try {
      if ((await lstat(resolve(worktree, entry.path))).isSymbolicLink()) {
        signal?.throwIfAborted();
        entry.symlink = true;
        continue;
      }
      if (isLocalRuntimePath(entry.path)) {
        entry.nonRenderable = true;
        continue;
      }
      if (
        (await hasGitConversion(worktree, entry.previousPath, signal)) ||
        (await hasGitConversion(worktree, entry.path, signal))
      ) {
        entry.nonRenderable = true;
      }
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and rename matching.
    }
  }
}

async function pairWorktreeRenames(
  worktree: string,
  entries: ChangeEntry[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  if (
    !entries.some((entry) => entry.initial === "deleted") ||
    !entries.some((entry) => entry.code === "??")
  ) {
    return;
  }
  const result = await gitWithEnvironment(
    worktree,
    ["diff", "--cached", "--no-textconv", "--name-status", "-z", "--find-renames", "HEAD", "--"],
    environment,
    undefined,
    signal,
  );
  const fields = result.stdout.split("\0");
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    if (!code.startsWith("R") && !code.startsWith("C")) {
      index += 1;
      continue;
    }
    const previousPath = safeRelativePath(worktree, fields[index++] ?? "");
    const path = safeRelativePath(worktree, fields[index++] ?? "");
    const deleted = entries.find(
      (entry) => entry.initial === "deleted" && entry.path === previousPath,
    );
    const added = entries.find(
      (entry) => entry.code === "??" && !isHiddenReviewPath(entry.path) && entry.path === path,
    );
    if (!deleted || !added) continue;
    added.initial = "renamed";
    added.previousPath = previousPath;
    entries.splice(entries.indexOf(deleted), 1);
  }
}

async function isBinary(
  worktree: string,
  path: string,
  untracked: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (untracked) {
    try {
      if ((await lstat(resolve(worktree, path))).isSymbolicLink()) return true;
      const content = await readBoundedChangedFile(resolve(worktree, path), MAX_DIFF_BYTES, signal);
      return content?.subarray(0, 8_000).includes(0) ?? true;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }
  const result = await git(
    worktree,
    ["diff", "--no-textconv", "--numstat", "HEAD", "--", path],
    undefined,
    signal,
  );
  return result.stdout.split("\n").some((line) => line.startsWith("-\t-\t"));
}

// Split file content into lines the way git counts them: a trailing newline
// terminates the final line rather than introducing an extra empty one.
function contentLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sameChangedFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Read one stable regular file without retaining bytes beyond the review ceiling. */
export async function readBoundedChangedFile(
  path: string,
  maximum = MAX_DIFF_BYTES,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const admitted = await handle.stat();
    if (!admitted.isFile() || admitted.size > maximum) return null;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(CHANGED_FILE_READ_BUFFER_BYTES, maximum + 1));
    let position = 0;
    while (position <= maximum) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.length, maximum + 1 - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (position > maximum) return null;
    const [after, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      position !== admitted.size ||
      !sameChangedFile(admitted, after) ||
      !sameChangedFile(after, pathname)
    ) {
      return null;
    }
    return Buffer.concat(chunks, position);
  } finally {
    await handle.close();
  }
}

function parseNumstat(output: string): [number | null, number | null] {
  const lines = output.split("\n").filter(Boolean);
  if (lines.length === 0) return [0, 0];
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") return [null, null];
    const addedCount = Number(added);
    const deletedCount = Number(deleted);
    if (!Number.isFinite(addedCount) || !Number.isFinite(deletedCount)) return [null, null];
    additions += addedCount;
    deletions += deletedCount;
  }
  return [additions, deletions];
}

async function counts(
  worktree: string,
  path: string,
  untracked: boolean,
  previousPath: string | null,
  snapshotEnvironment: NodeJS.ProcessEnv | null,
  signal?: AbortSignal,
): Promise<[number | null, number | null]> {
  signal?.throwIfAborted();
  if (previousPath) {
    if (!snapshotEnvironment) {
      throw new RepositoryError("The rename snapshot is unavailable for change review.", 409);
    }
    const result = await gitWithEnvironment(
      worktree,
      [
        "diff",
        "--cached",
        "--no-textconv",
        "--numstat",
        "--find-renames",
        "HEAD",
        "--",
        previousPath,
        path,
      ],
      snapshotEnvironment,
      undefined,
      signal,
    );
    return parseNumstat(result.stdout);
  }
  if (untracked) {
    try {
      const content = await readBoundedChangedFile(resolve(worktree, path), MAX_DIFF_BYTES, signal);
      return content ? [contentLines(content.toString("utf8")).length, 0] : [null, null];
    } catch {
      signal?.throwIfAborted();
      return [null, null];
    }
  }
  const result = await git(
    worktree,
    ["diff", "--no-textconv", "--numstat", "HEAD", "--", path],
    undefined,
    signal,
  );
  return parseNumstat(result.stdout);
}

export async function listChangedFiles(
  worktree: string,
  signal?: AbortSignal,
): Promise<ChangedFile[]> {
  signal?.throwIfAborted();
  const result = await git(
    worktree,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--find-renames"],
    undefined,
    signal,
  );
  const fields = result.stdout.split("\0");
  const entries: ChangeEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    signal?.throwIfAborted();
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = safeRelativePath(worktree, field.slice(3));
    const renamed = code.includes("R") || code.includes("C");
    const previousPath = renamed ? safeRelativePath(worktree, fields[++index] ?? "") : null;
    entries.push({ code, path, previousPath, initial: baseState(code) });
  }

  const ignoredRuntimePaths = entries.some((entry) => entry.initial === "deleted")
    ? await listIgnoredRuntimePaths(worktree, signal)
    : [];
  for (const path of ignoredRuntimePaths) {
    if (entries.some((entry) => entry.path === path)) continue;
    entries.push({ code: "??", path, previousPath: null, initial: "added" });
  }
  await markSpecialRenames(worktree, entries, signal);
  await pairExactRuntimeRenames(worktree, entries, signal);
  await pairExactRenames(
    worktree,
    entries,
    (entry) => !isHiddenReviewPath(entry.path),
    () => {},
    signal,
  );

  // Git reports an unstaged move as one deletion and one untracked addition.
  // Ask Git's rename detector to pair those paths from a temporary snapshot so
  // a move followed by edits remains reviewable without touching the real index.
  const removePaths = [
    ...entries.filter((entry) => entry.initial === "deleted").map((entry) => entry.path),
    ...entries.flatMap((entry) => (entry.previousPath ? [entry.previousPath] : [])),
  ];
  const hasDeletedPath = entries.some((entry) => entry.initial === "deleted");
  const hasRenderableRename = entries.some(
    (entry) => entry.previousPath !== null && !entry.nonRenderable,
  );
  const addPaths =
    hasDeletedPath || hasRenderableRename
      ? await boundedSnapshotPaths(
          worktree,
          [
            ...entries
              .filter((entry) => entry.code === "??" && !isHiddenReviewPath(entry.path))
              .map((entry) => entry.path),
            ...entries.flatMap((entry) =>
              entry.previousPath && !isHiddenReviewPath(entry.path) ? [entry.path] : [],
            ),
          ],
          undefined,
          signal,
        )
      : [];
  const needsSnapshot = hasRenderableRename || (hasDeletedPath && addPaths.length > 0);
  const snapshot = needsSnapshot
    ? await createWorktreeSnapshot(worktree, removePaths, addPaths, signal)
    : null;
  try {
    if (snapshot && entries.some((entry) => entry.initial === "deleted")) {
      await pairWorktreeRenames(worktree, entries, snapshot.environment, signal);
    }

    // A user's checkout may predate Aldunis' own /data ignore rule. Keep
    // local databases, generated runtime state, and staged composer images
    // out of review even then, after preserving a genuine unstaged rename
    // into one of those paths.
    const changes: ChangedFile[] = [];
    for (const entry of entries) {
      signal?.throwIfAborted();
      const { code, path, previousPath, initial } = entry;
      if (code === "??" && initial === "added" && isHiddenReviewPath(path)) continue;
      let oversized = await isOversized(
        worktree,
        path,
        initial === "deleted",
        previousPath,
        code === "??",
        signal,
      );
      let untrackedContent: Buffer | null | undefined;
      if (!oversized && code === "??" && !entry.symlink && !entry.nonRenderable) {
        untrackedContent = await readBoundedChangedFile(
          resolve(worktree, path),
          MAX_DIFF_BYTES,
          signal,
        );
        if (untrackedContent === null) oversized = true;
      }
      const binary =
        !oversized &&
        (entry.symlink ||
          entry.nonRenderable ||
          (untrackedContent
            ? untrackedContent.subarray(0, 8_000).includes(0)
            : await isBinary(worktree, path, false, signal)));
      const [additions, deletions] =
        oversized || binary
          ? [null, null]
          : untrackedContent && !previousPath
            ? [contentLines(untrackedContent.toString("utf8")).length, 0]
            : await counts(
                worktree,
                path,
                code === "??",
                previousPath,
                snapshot?.environment ?? null,
                signal,
              );
      changes.push({
        path,
        previousPath,
        state: oversized ? "oversized" : binary ? "binary" : initial,
        additions,
        deletions,
      });
    }
    return changes.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    if (snapshot) await disposeWorktreeSnapshot(snapshot);
  }
}

export async function readFileDiff(
  worktree: string,
  requestedPath: string,
  changedFiles?: readonly ChangedFile[],
): Promise<FileDiff> {
  const path = safeRelativePath(worktree, requestedPath);
  const change = (changedFiles ?? (await listChangedFiles(worktree))).find(
    (item) => item.path === path,
  );
  if (!change) throw new RepositoryError("The selected file is no longer changed.", 404);
  if (change.state === "binary") {
    return finalizeDiff(change, null, "Binary content is not rendered.");
  }
  if (change.state === "oversized") {
    return finalizeDiff(
      change,
      null,
      `Diff exceeds the ${MAX_DIFF_BYTES / 1024} KiB review limit.`,
    );
  }
  if (change.state === "renamed" && change.previousPath) {
    const patch = await withWorktreeSnapshot(
      worktree,
      async (environment) => {
        const result = await gitWithEnvironment(
          worktree,
          [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--unified=3",
            "HEAD",
            "--",
            change.previousPath!,
            path,
          ],
          environment,
          MAX_DIFF_BYTES * 2,
        );
        return result.stdout || null;
      },
      [change.previousPath!],
      [path],
    );
    if (!patch) {
      throw new RepositoryError("The selected rename changed before its diff could be read.", 409);
    }
    return finalizeDiff(change, patch, null);
  }
  if (change.state === "added") {
    const bytes = await readBoundedChangedFile(resolve(worktree, path));
    if (!bytes) {
      throw new RepositoryError("The selected file changed before its diff could be read.", 409);
    }
    const content = bytes.toString("utf8");
    const lines = contentLines(content);
    const endsWithNewline = content.endsWith("\n");
    const patch = [
      `diff --git a/${path} b/${path}`,
      "new file",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      ...(lines.length > 0 && !endsWithNewline ? ["\\ No newline at end of file"] : []),
    ].join("\n");
    return finalizeDiff(change, patch, null);
  }
  const result = await git(
    worktree,
    ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "HEAD", "--", path],
    MAX_DIFF_BYTES * 2,
  );
  return finalizeDiff(
    change,
    result.stdout || null,
    result.stdout ? null : "No textual diff is available.",
  );
}

/**
 * Read a stable diff between two checkpoint trees. Unlike readFileDiff, this
 * never compares against the mutable current worktree, so historical turn
 * review remains meaningful after later turns or operator edits.
 */
export async function readCheckpointFileDiff(
  worktree: string,
  fromIdentity: string,
  toIdentity: string,
  requestedPath: string,
  summary?: CheckpointFile[],
): Promise<FileDiff> {
  const path = safeRelativePath(worktree, requestedPath);
  const files = summary ?? (await checkpointDiff(worktree, fromIdentity, toIdentity));
  const checkpointFile = files.find((file) => file.path === path);
  if (!checkpointFile)
    throw new RepositoryError("The selected file is not part of this turn.", 404);
  const change: ChangedFile = {
    path: checkpointFile.path,
    previousPath: checkpointFile.previousPath,
    state: checkpointFile.state,
    additions: checkpointFile.additions ?? null,
    deletions: checkpointFile.deletions ?? null,
  };
  if (change.state === "binary") {
    return finalizeDiff(change, null, "Binary content is not rendered.");
  }
  const result = await git(
    worktree,
    ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", fromIdentity, toIdentity, "--", path],
    MAX_DIFF_BYTES * 2,
  );
  return finalizeDiff(
    change,
    result.stdout || null,
    result.stdout ? null : "No textual diff is available.",
  );
}
