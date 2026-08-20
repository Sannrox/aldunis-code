import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { checkpointDiff, RepositoryError, type CheckpointFile } from "./repository.ts";
import { isComposerAttachmentPath, isLocalRuntimePath } from "./local-runtime.ts";

function isHiddenReviewPath(path: string): boolean {
  return isLocalRuntimePath(path) || isComposerAttachmentPath(path);
}

const execFileAsync = promisify(execFile);
export const MAX_DIFF_BYTES = 256 * 1024;
export const MAX_CHANGED_FILES = 256;
const CHANGED_FILE_READ_BUFFER_BYTES = 64 * 1024;
const MAX_RENAME_CANDIDATES = 128;
const MAX_NUMSTAT_PATHS_PER_BATCH = 128;
const MAX_STATUS_RECORD_BYTES = 64 * 1024;
const MAX_STATUS_STDERR_BYTES = 64 * 1024;
const MAX_SNAPSHOT_GIT_STDOUT_BYTES = 64 * 1024;
const MAX_SNAPSHOT_GIT_STDERR_BYTES = 64 * 1024;
const MAX_SNAPSHOT_ATTRIBUTE_BYTES = MAX_RENAME_CANDIDATES * 2 * (MAX_STATUS_RECORD_BYTES + 64);
const SNAPSHOT_GIT_TIMEOUT_MS = 10_000;
const HIDDEN_REVIEW_PATHSPECS = [
  ":(glob)aldunis-code-composer-images/**",
  ":(icase,glob)**/*.db",
  ":(icase,glob)**/*.db-journal",
  ":(icase,glob)**/*.db-shm",
  ":(icase,glob)**/*.db-wal",
  ":(icase,glob)**/*.sqlite",
  ":(icase,glob)**/*.sqlite-journal",
  ":(icase,glob)**/*.sqlite-shm",
  ":(icase,glob)**/*.sqlite-wal",
  ":(icase,glob)**/*.sqlite3",
  ":(icase,glob)**/*.sqlite3-journal",
  ":(icase,glob)**/*.sqlite3-shm",
  ":(icase,glob)**/*.sqlite3-wal",
  ":(icase,glob)**/data/*-state.json*",
  ":(icase,glob)**/data/*.state*",
  ":(icase,glob)**/data/*.lock",
  ":(icase,glob)**/data/*.sock*",
];
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

type SnapshotGitResult = {
  stdout: Buffer;
};

async function snapshotGitInput(
  worktree: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  input: Buffer,
  signal?: AbortSignal,
  command = "git",
  timeoutMs = SNAPSHOT_GIT_TIMEOUT_MS,
  maximumStdout = MAX_SNAPSHOT_GIT_STDOUT_BYTES,
): Promise<SnapshotGitResult> {
  signal?.throwIfAborted();
  const child = spawn(command, ["-C", worktree, ...args], {
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let timedOut = false;
  let aborted = false;
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timer.unref();
  const abort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const exit = new Promise<{ code: number | null; error: Error | null }>((resolveExit) => {
    child.once("error", (error) => resolveExit({ code: null, error }));
    child.once("close", (code) => resolveExit({ code, error: null }));
  });
  const collect = async (stream: NodeJS.ReadableStream, maximum: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let retained = 0;
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (retained + chunk.length > maximum) throw new Error("Git output exceeds its limit.");
      chunks.push(chunk);
      retained += chunk.length;
    }
    return Buffer.concat(chunks, retained);
  };
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ value, error: null }),
      (error: unknown) => {
        terminate();
        return {
          value: null,
          error: error instanceof Error ? error : new Error("Git stream failed."),
        };
      },
    );
  const stdout = settle(collect(child.stdout, maximumStdout));
  const stderr = settle(collect(child.stderr, MAX_SNAPSHOT_GIT_STDERR_BYTES));
  const write = settle(
    (async () => {
      child.stdin.end(input);
      await finished(child.stdin);
    })(),
  );
  try {
    const [outcome, stdoutOutcome, stderrOutcome, writeOutcome] = await Promise.all([
      exit,
      stdout,
      stderr,
      write,
    ]);
    if (aborted) signal?.throwIfAborted();
    if (
      timedOut ||
      outcome.error ||
      stdoutOutcome.error ||
      stderrOutcome.error ||
      writeOutcome.error ||
      outcome.code !== 0
    ) {
      throw new Error(
        stderrOutcome.value?.toString("utf8").trim() ||
          outcome.error?.message ||
          stdoutOutcome.error?.message ||
          stderrOutcome.error?.message ||
          writeOutcome.error?.message ||
          "Git snapshot process failed.",
      );
    }
    return { stdout: stdoutOutcome.value ?? Buffer.alloc(0) };
  } catch {
    terminate();
    await exit;
    signal?.throwIfAborted();
    throw new RepositoryError("The worktree could not be snapshotted for change review.", 409);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
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
    if (removePaths.length > 0) {
      await snapshotGitInput(
        worktree,
        ["update-index", "--force-remove", "-z", "--stdin"],
        environment,
        Buffer.from(`${removePaths.join("\0")}\0`),
        signal,
      );
    }
    const additions: Array<{ mode: "100644" | "100755"; path: string; temporaryPath: string }> = [];
    for (const [index, path] of addPaths.entries()) {
      signal?.throwIfAborted();
      const content = await readBoundedChangedFile(resolve(worktree, path), MAX_DIFF_BYTES, signal);
      signal?.throwIfAborted();
      if (!content) continue;
      const details = await lstat(resolve(worktree, path));
      signal?.throwIfAborted();
      if (!details.isFile() || details.size > MAX_DIFF_BYTES) continue;
      const temporaryPath = join(temporary, `snapshot-blob-${index.toString().padStart(3, "0")}`);
      await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
      additions.push({
        mode: details.mode & 0o111 ? "100755" : "100644",
        path,
        temporaryPath,
      });
    }
    if (additions.length > 0) {
      const objects = await snapshotGitInput(
        worktree,
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        environment,
        Buffer.from(`${additions.map((entry) => entry.temporaryPath).join("\n")}\n`),
        signal,
      );
      const objectIds = objects.stdout.toString("ascii").trimEnd().split("\n");
      if (
        objectIds.length !== additions.length ||
        objectIds.some((objectId) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId))
      ) {
        throw new RepositoryError("The worktree could not be snapshotted for change review.", 409);
      }
      const indexRecords = Buffer.from(
        additions
          .map((entry, index) => `${entry.mode} ${objectIds[index]}\t${entry.path}\0`)
          .join(""),
      );
      await snapshotGitInput(
        worktree,
        ["update-index", "--add", "-z", "--index-info"],
        environment,
        indexRecords,
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
  committedSizes: ReadonlyMap<string, number>,
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
    size = Math.max(size, committedSizes.get(previousPath ?? path) ?? 0);
  }
  return size > MAX_DIFF_BYTES;
}

type CommittedObjectMetadata = { objectId: string; size: number };

async function committedObjectMetadata(
  worktree: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, CommittedObjectMetadata>> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return new Map();
  try {
    const result = await snapshotGitInput(
      worktree,
      ["cat-file", "--batch-check", "-Z"],
      process.env,
      Buffer.from(`${unique.map((path) => `HEAD:${path}`).join("\0")}\0`),
      signal,
      "git",
      SNAPSHOT_GIT_TIMEOUT_MS,
      unique.reduce((maximum, path) => maximum + Buffer.byteLength(`HEAD:${path}`) + 96, 0),
    );
    const records = result.stdout.toString("ascii").split("\0");
    if (records.at(-1) === "") records.pop();
    if (records.length !== unique.length) throw new Error("Git returned incomplete metadata.");
    const metadata = new Map<string, CommittedObjectMetadata>();
    for (const [index, record] of records.entries()) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d+)$/.exec(record);
      if (!match) continue;
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0) continue;
      metadata.set(unique[index]!, { objectId: match[1]!, size });
    }
    return metadata;
  } catch {
    signal?.throwIfAborted();
    // Git before 2.41 does not support NUL-delimited batch output. Preserve
    // exact path handling and prior best-effort behavior on those installations.
    const metadata = new Map<string, CommittedObjectMetadata>();
    for (const path of unique) {
      signal?.throwIfAborted();
      try {
        const object = (
          await git(worktree, ["rev-parse", `HEAD:${path}`], undefined, signal)
        ).stdout.trim();
        const size = Number(
          (await git(worktree, ["cat-file", "-s", object], undefined, signal)).stdout.trim(),
        );
        if (
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object) &&
          Number.isSafeInteger(size) &&
          size >= 0
        ) {
          metadata.set(path, { objectId: object, size });
        }
      } catch {
        signal?.throwIfAborted();
        // The worktree may change between status and metadata inspection.
      }
    }
    return metadata;
  }
}

type ChangeEntry = {
  code: string;
  path: string;
  previousPath: string | null;
  initial: Exclude<ChangeState, "binary" | "oversized">;
  symlink?: boolean;
  nonRenderable?: boolean;
};

async function pathsWithoutGitConversion(
  worktree: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  signal?.throwIfAborted();
  try {
    const result = await snapshotGitInput(
      worktree,
      ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"],
      process.env,
      Buffer.from(`${paths.join("\0")}\0`),
      signal,
      "git",
      SNAPSHOT_GIT_TIMEOUT_MS,
      MAX_SNAPSHOT_ATTRIBUTE_BYTES,
    );
    const fields = result.stdout.toString("utf8").split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== paths.length * 6) return new Set();
    const accepted = new Set<string>();
    for (let index = 0; index < paths.length; index += 1) {
      const offset = index * 6;
      const path = paths[index];
      const filter = fields.slice(offset, offset + 3);
      const encoding = fields.slice(offset + 3, offset + 6);
      if (
        filter[0] !== path ||
        filter[1] !== "filter" ||
        encoding[0] !== path ||
        encoding[1] !== "working-tree-encoding"
      ) {
        return new Set();
      }
      if ([filter[2], encoding[2]].every((value) => value === "unspecified" || value === "unset")) {
        accepted.add(path);
      }
    }
    return accepted;
  } catch {
    signal?.throwIfAborted();
    return new Set();
  }
}

async function hasGitConversion(
  worktree: string,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return !(await pathsWithoutGitConversion(worktree, [path], signal)).has(path);
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
  const regularFiles: string[] = [];
  for (const path of [...new Set(paths)]) {
    signal?.throwIfAborted();
    if (regularFiles.length >= limit) break;
    try {
      const details = await lstat(resolve(worktree, path));
      signal?.throwIfAborted();
      if (details.isFile() && details.size <= MAX_DIFF_BYTES) regularFiles.push(path);
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and snapshot preparation.
    }
  }
  const accepted = await pathsWithoutGitConversion(worktree, regularFiles, signal);
  return regularFiles.filter((path) => accepted.has(path));
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
  const sources = deleted.slice(0, MAX_RENAME_CANDIDATES);
  const regularCandidates: ChangeEntry[] = [];
  for (const entry of candidates) {
    signal?.throwIfAborted();
    try {
      const details = await lstat(resolve(worktree, entry.path));
      signal?.throwIfAborted();
      if (details.isFile() && details.size <= MAX_EXACT_RENAME_BYTES) regularCandidates.push(entry);
    } catch {
      signal?.throwIfAborted();
      // The worktree may change between status and rename matching.
    }
  }
  const conversionSafe = await pathsWithoutGitConversion(
    worktree,
    [...sources.map((entry) => entry.path), ...regularCandidates.map((entry) => entry.path)],
    signal,
  );
  const sourceObjects = new Map<string, string[]>();
  const admittedSources = sources.filter((entry) => conversionSafe.has(entry.path));
  const metadata = await committedObjectMetadata(
    worktree,
    admittedSources.map((entry) => entry.path),
    signal,
  );
  for (const entry of admittedSources) {
    const source = metadata.get(entry.path);
    if (!source || source.size > MAX_EXACT_RENAME_BYTES) continue;
    const paths = sourceObjects.get(source.objectId) ?? [];
    paths.push(entry.path);
    sourceObjects.set(source.objectId, paths);
  }
  const safeCandidates = regularCandidates.filter(
    (entry) => conversionSafe.has(entry.path) && !/[\r\n]/.test(entry.path),
  );
  const candidateObjects = new Map<string, string>();
  try {
    if (safeCandidates.length > 0) {
      const objects = await snapshotGitInput(
        worktree,
        ["hash-object", "--no-filters", "--stdin-paths"],
        process.env,
        Buffer.from(`${safeCandidates.map((entry) => entry.path).join("\n")}\n`),
        signal,
        "git",
        SNAPSHOT_GIT_TIMEOUT_MS,
        safeCandidates.length * 65,
      );
      const objectIds = objects.stdout.toString("ascii").trimEnd().split("\n");
      if (
        objectIds.length === safeCandidates.length &&
        objectIds.every((objectId) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId))
      ) {
        safeCandidates.forEach((entry, index) =>
          candidateObjects.set(entry.path, objectIds[index]!),
        );
      }
    }
  } catch {
    signal?.throwIfAborted();
    // The worktree may change between status and rename matching.
  }
  for (const entry of regularCandidates) {
    signal?.throwIfAborted();
    try {
      if (!conversionSafe.has(entry.path)) continue;
      const objectId =
        candidateObjects.get(entry.path) ??
        (
          await git(worktree, ["hash-object", "--no-filters", "--", entry.path], undefined, signal)
        ).stdout.trim();
      const previousPath = sourceObjects.get(objectId)?.shift();
      if (!previousPath) continue;
      entry.initial = "renamed";
      entry.previousPath = previousPath;
      mark(entry);
      const deletedEntry = entries.find(
        (candidate) => candidate.initial === "deleted" && candidate.path === previousPath,
      );
      if (deletedEntry) entries.splice(entries.indexOf(deletedEntry), 1);
      if (sourceObjects.get(objectId)?.length === 0) sourceObjects.delete(objectId);
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

type TrackedNumstat = { binary: boolean; additions: number; deletions: number };

async function batchTrackedNumstats(
  worktree: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<Map<string, TrackedNumstat>> {
  const stats = new Map<string, TrackedNumstat>();
  const unique = [...new Set(paths)];
  for (let offset = 0; offset < unique.length; offset += MAX_NUMSTAT_PATHS_PER_BATCH) {
    const batch = unique.slice(offset, offset + MAX_NUMSTAT_PATHS_PER_BATCH);
    const result = await snapshotGitInput(
      worktree,
      ["diff", "--no-textconv", "--numstat", "-z", "--no-renames", "HEAD", "--", ...batch],
      { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
      Buffer.alloc(0),
      signal,
      "git",
      SNAPSHOT_GIT_TIMEOUT_MS,
      batch.reduce((maximum, path) => maximum + Buffer.byteLength(path) + 48, 0),
    );
    const records = result.stdout.toString("utf8").split("\0");
    if (records.at(-1) === "") records.pop();
    for (const record of records) {
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab < 1 || secondTab < firstTab + 2) {
        throw new RepositoryError("Git returned invalid changed-file statistics.", 409);
      }
      const added = record.slice(0, firstTab);
      const deleted = record.slice(firstTab + 1, secondTab);
      const path = safeRelativePath(worktree, record.slice(secondTab + 1));
      if (added === "-" && deleted === "-") {
        stats.set(path, { binary: true, additions: 0, deletions: 0 });
        continue;
      }
      const additions = Number(added);
      const deletions = Number(deleted);
      if (
        !Number.isSafeInteger(additions) ||
        additions < 0 ||
        !Number.isSafeInteger(deletions) ||
        deletions < 0
      ) {
        throw new RepositoryError("Git returned invalid changed-file statistics.", 409);
      }
      stats.set(path, { binary: false, additions, deletions });
    }
  }
  return stats;
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

async function boundedStatusEntries(
  worktree: string,
  maximumEntries: number,
  signal?: AbortSignal,
): Promise<{ entries: ChangeEntry[]; truncated: boolean }> {
  signal?.throwIfAborted();
  const entries: ChangeEntry[] = [];
  let trackedCandidates = 0;
  let untrackedCandidates = 0;
  let hiddenRenameCandidates = 0;
  let truncated = false;
  // Each rename-reconciliation pass can consume deleted candidates. Reserve
  // enough look-ahead for both runtime-path and ordinary untracked pairing so
  // a truncated response can still fill the requested page.
  const visibleParseLimit = maximumEntries + MAX_RENAME_CANDIDATES * 2;

  const collect = async (
    args: string[],
    admit: (entry: ChangeEntry) => boolean,
    fieldsAreUntrackedPaths = false,
  ): Promise<boolean> => {
    const child = spawn("git", ["-C", worktree, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<{ code: number | null; childSignal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code, childSignal) => resolveExit({ code, childSignal }));
      },
    );
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STATUS_STDERR_BYTES) return;
      const retained = chunk.subarray(0, MAX_STATUS_STDERR_BYTES - stderrBytes);
      stderr.push(Buffer.from(retained));
      stderrBytes += retained.length;
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    let pending = Buffer.alloc(0);
    let pendingRename: Omit<ChangeEntry, "previousPath"> | null = null;
    let stopped = false;
    try {
      outer: for await (const chunk of child.stdout) {
        signal?.throwIfAborted();
        const bytes = chunk as Buffer;
        const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
        let start = 0;
        for (;;) {
          const end = joined.indexOf(0, start);
          if (end < 0) break;
          const field = joined.toString("utf8", start, end);
          start = end + 1;
          if (fieldsAreUntrackedPaths) {
            if (
              !admit({
                code: "??",
                path: safeRelativePath(worktree, field),
                previousPath: null,
                initial: "added",
              })
            ) {
              stopped = true;
              break outer;
            }
            continue;
          }
          if (pendingRename) {
            const entry = { ...pendingRename, previousPath: safeRelativePath(worktree, field) };
            pendingRename = null;
            if (!admit(entry)) {
              stopped = true;
              break outer;
            }
            continue;
          }
          if (!field) continue;
          const code = field.slice(0, 2);
          const path = safeRelativePath(worktree, field.slice(3));
          const entry = { code, path, initial: baseState(code) };
          if (code.includes("R") || code.includes("C")) pendingRename = entry;
          else if (!admit({ ...entry, previousPath: null })) {
            stopped = true;
            break outer;
          }
        }
        pending = Buffer.from(joined.subarray(start));
        if (pending.length > MAX_STATUS_RECORD_BYTES) {
          throw new RepositoryError(
            "A changed-file status record exceeded its resource limit.",
            413,
          );
        }
      }
      if (stopped) child.kill("SIGTERM");
      const completion = await exit;
      signal?.throwIfAborted();
      if (!stopped && (pending.length > 0 || pendingRename)) {
        throw new RepositoryError("Git returned an incomplete changed-file inventory.", 409);
      }
      if (!stopped && completion.code !== 0) {
        const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
        throw new RepositoryError(detail || "Git could not inspect changed files.", 409);
      }
      return stopped;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit.catch(() => undefined);
    }
  };

  const admitVisible =
    (source: "tracked" | "untracked") =>
    (entry: ChangeEntry): boolean => {
      const count = source === "tracked" ? trackedCandidates : untrackedCandidates;
      if (count >= visibleParseLimit) {
        truncated = true;
        return false;
      }
      if (source === "tracked") trackedCandidates += 1;
      else untrackedCandidates += 1;
      entries.push(entry);
      return true;
    };
  const exclusions = HIDDEN_REVIEW_PATHSPECS.map((pathspec) =>
    pathspec
      .replace(":(glob)", ":(exclude,glob)")
      .replace(":(icase,glob)", ":(exclude,icase,glob)"),
  );
  await collect(
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--find-renames"],
    admitVisible("tracked"),
  );
  await collect(
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...exclusions],
    admitVisible("untracked"),
    true,
  );
  await collect(
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...HIDDEN_REVIEW_PATHSPECS],
    (entry) => {
      if (hiddenRenameCandidates >= MAX_RENAME_CANDIDATES) return false;
      hiddenRenameCandidates += 1;
      entries.push(entry);
      return true;
    },
    true,
  );
  // Git emits each inventory in bytewise pathname order. Keep that exact
  // ordering after merging so bounded source prefixes remain a valid global
  // prefix even for mixed-case and non-ASCII paths.
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { entries, truncated };
}

async function inspectChangedFiles(
  worktree: string,
  signal?: AbortSignal,
  maximumEntries = Number.POSITIVE_INFINITY,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  signal?.throwIfAborted();
  const bounded = Number.isFinite(maximumEntries);
  const boundedStatus = bounded
    ? await boundedStatusEntries(worktree, maximumEntries, signal)
    : null;
  const result = boundedStatus
    ? null
    : await git(
        worktree,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--find-renames"],
        undefined,
        signal,
      );
  const fields = result?.stdout.split("\0") ?? [];
  const entries: ChangeEntry[] = boundedStatus?.entries ?? [];
  let truncated = boundedStatus?.truncated ?? false;
  let visibleCandidates = 0;
  let hiddenRenameCandidates = 0;
  const visibleParseLimit = bounded ? maximumEntries + MAX_RENAME_CANDIDATES * 2 : maximumEntries;
  for (let index = 0; index < fields.length; index += 1) {
    signal?.throwIfAborted();
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = safeRelativePath(worktree, field.slice(3));
    const renamed = code.includes("R") || code.includes("C");
    const previousPath = renamed ? safeRelativePath(worktree, fields[++index] ?? "") : null;
    const hiddenRenameCandidate = code === "??" && isHiddenReviewPath(path);
    if (hiddenRenameCandidate && bounded && hiddenRenameCandidates >= MAX_RENAME_CANDIDATES) {
      continue;
    }
    if (!hiddenRenameCandidate && visibleCandidates >= visibleParseLimit) {
      truncated = true;
      break;
    }
    if (hiddenRenameCandidate) hiddenRenameCandidates += 1;
    else visibleCandidates += 1;
    entries.push({ code, path, previousPath, initial: baseState(code) });
  }

  const ignoredRuntimePaths = entries.some((entry) => entry.initial === "deleted")
    ? await listIgnoredRuntimePaths(worktree, signal)
    : [];
  for (const path of ignoredRuntimePaths) {
    if (entries.some((entry) => entry.path === path)) continue;
    if (bounded && hiddenRenameCandidates >= MAX_RENAME_CANDIDATES) continue;
    hiddenRenameCandidates += 1;
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
    const visibleEntries = entries.filter(
      (entry) =>
        !(entry.code === "??" && entry.initial === "added" && isHiddenReviewPath(entry.path)),
    );
    if (visibleEntries.length > maximumEntries) truncated = true;
    const projectedEntries = visibleEntries.slice(0, maximumEntries);
    const committedMetadata = await committedObjectMetadata(
      worktree,
      projectedEntries
        .filter((entry) => entry.initial !== "added")
        .map((entry) => entry.previousPath ?? entry.path),
      signal,
    );
    const committedSizes = new Map(
      [...committedMetadata].map(([path, metadata]) => [path, metadata.size]),
    );
    const oversizedEntries = new Map<ChangeEntry, boolean>();
    for (const entry of projectedEntries) {
      oversizedEntries.set(
        entry,
        await isOversized(
          worktree,
          entry.path,
          entry.initial === "deleted",
          entry.previousPath,
          entry.code === "??",
          committedSizes,
          signal,
        ),
      );
    }
    const trackedNumstats = await batchTrackedNumstats(
      worktree,
      projectedEntries
        .filter(
          (entry) =>
            !oversizedEntries.get(entry) && entry.code !== "??" && entry.previousPath === null,
        )
        .map((entry) => entry.path),
      signal,
    );
    const changes: ChangedFile[] = [];
    for (const entry of projectedEntries) {
      signal?.throwIfAborted();
      const { code, path, previousPath, initial } = entry;
      if (code === "??" && initial === "added" && isHiddenReviewPath(path)) continue;
      let oversized = oversizedEntries.get(entry) ?? false;
      let untrackedContent: Buffer | null | undefined;
      if (!oversized && code === "??" && !entry.symlink && !entry.nonRenderable) {
        untrackedContent = await readBoundedChangedFile(
          resolve(worktree, path),
          MAX_DIFF_BYTES,
          signal,
        );
        if (untrackedContent === null) oversized = true;
      }
      const trackedNumstat =
        code !== "??" && previousPath === null ? trackedNumstats.get(path) : undefined;
      const binary =
        !oversized &&
        (entry.symlink ||
          entry.nonRenderable ||
          trackedNumstat?.binary ||
          (untrackedContent
            ? untrackedContent.subarray(0, 8_000).includes(0)
            : trackedNumstat
              ? false
              : await isBinary(worktree, path, false, signal)));
      const [additions, deletions] =
        oversized || binary
          ? [null, null]
          : trackedNumstat
            ? [trackedNumstat.additions, trackedNumstat.deletions]
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
    return { files: changes.sort((left, right) => left.path.localeCompare(right.path)), truncated };
  } finally {
    if (snapshot) await disposeWorktreeSnapshot(snapshot);
  }
}

export async function listChangedFiles(
  worktree: string,
  signal?: AbortSignal,
): Promise<ChangedFile[]> {
  return (await inspectChangedFiles(worktree, signal)).files;
}

export async function listChangedFilesPage(
  worktree: string,
  signal?: AbortSignal,
): Promise<{ files: ChangedFile[]; truncated: boolean }> {
  const inspected = await inspectChangedFiles(worktree, signal, MAX_CHANGED_FILES + 1);
  return {
    files: inspected.files.slice(0, MAX_CHANGED_FILES),
    truncated: inspected.truncated || inspected.files.length > MAX_CHANGED_FILES,
  };
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
