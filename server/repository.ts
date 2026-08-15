import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKTREE_CLASSIFICATION_CONCURRENCY = 8;
const WORKTREE_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_WORKTREE_DISCOVERY_RECORD_BYTES = 64 * 1024;
const MAX_WORKTREE_DISCOVERY_STDERR_BYTES = 64 * 1024;
const LOCAL_BRANCH_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_LOCAL_BRANCH_RECORD_BYTES = 64 * 1024;
const MAX_LOCAL_BRANCH_STDERR_BYTES = 64 * 1024;
export const MAX_LOCAL_BRANCH_SUGGESTIONS = 256;
const DEFAULT_BRANCH_CANDIDATES = new Set(["main", "master", "trunk", "develop"]);
const INDEX_COPY_BUFFER_BYTES = 256 * 1024;
const CHECKPOINT_INVENTORY_TIMEOUT_MS = 15_000;
const MAX_CHECKPOINT_INVENTORY_RECORD_BYTES = 64 * 1024;
const MAX_CHECKPOINT_INVENTORY_STDERR_BYTES = 64 * 1024;

export type WorktreeState = "available" | "detached" | "missing" | "inaccessible";

export interface WorktreeMetadata {
  path: string;
  head: string | null;
  branch: string | null;
  state: WorktreeState;
}

export interface RepositoryMetadata {
  name: string;
  root: string;
  defaultBranch: string | null;
  /** Local branch names available as worktree creation bases. */
  localBranches: string[];
  localBranchCount: number;
  localBranchesTruncated: boolean;
  selectedWorktree: string;
  worktrees: WorktreeMetadata[];
}

export class RepositoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface CheckpointSnapshot {
  identity: string;
  indexIdentity: string;
  head: string;
  gitDirectory: string;
}

export interface CheckpointFile {
  path: string;
  state: "added" | "modified" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
}

async function git(
  worktree: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      env: options.env,
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new RepositoryError(
      message.includes("timed out")
        ? "Git did not finish while inspecting the workspace."
        : "The workspace checkpoint operation could not be completed.",
      409,
    );
  }
}

async function optionalGit(worktree: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function gitBuffer(
  worktree: string,
  args: string[],
  maxBuffer = 32 * 1024 * 1024,
): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", ["-C", worktree, ...args], {
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer,
    });
    return result.stdout;
  } catch {
    throw new RepositoryError("The workspace checkpoint operation could not be completed.", 409);
  }
}

async function checkpointInventoryHasRecord(
  worktree: string,
  args: string[],
  matches: (record: Buffer) => boolean,
): Promise<boolean> {
  const child = spawn("git", ["-C", worktree, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_LITERAL_PATHSPECS: "0",
      GIT_GLOB_PATHSPECS: "0",
      GIT_NOGLOB_PATHSPECS: "0",
      GIT_ICASE_PATHSPECS: "0",
    },
  });
  const exit = new Promise<{ code: number | null; childSignal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, childSignal) => resolveExit({ code, childSignal }));
    },
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let pending = Buffer.alloc(0);
  let found = false;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    escalation.unref?.();
  };
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_CHECKPOINT_INVENTORY_STDERR_BYTES) return;
    const retained = chunk.subarray(0, MAX_CHECKPOINT_INVENTORY_STDERR_BYTES - stderrBytes);
    stderr.push(Buffer.from(retained));
    stderrBytes += retained.length;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, CHECKPOINT_INVENTORY_TIMEOUT_MS);
  timeout.unref?.();
  try {
    outer: for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = joined.indexOf(0, start);
        if (end < 0) break;
        if (end - start > MAX_CHECKPOINT_INVENTORY_RECORD_BYTES) {
          throw new RepositoryError(
            "A checkpoint inventory record exceeded its resource limit.",
            409,
          );
        }
        if (matches(joined.subarray(start, end))) {
          found = true;
          stop();
          break outer;
        }
        start = end + 1;
      }
      pending = Buffer.from(joined.subarray(start));
      if (pending.length > MAX_CHECKPOINT_INVENTORY_RECORD_BYTES) {
        throw new RepositoryError(
          "A checkpoint inventory record exceeded its resource limit.",
          409,
        );
      }
    }
    const completion = await exit;
    if (timedOut) {
      throw new RepositoryError("Git did not finish while inspecting the workspace.", 409);
    }
    if (!found && pending.length > 0) {
      throw new RepositoryError("Git returned an incomplete checkpoint inventory.", 409);
    }
    if (!found && completion.code !== 0) {
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
      throw new RepositoryError(
        detail || "The workspace checkpoint operation could not be completed.",
        409,
      );
    }
    return found;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The workspace checkpoint operation could not be completed.", 409);
  } finally {
    clearTimeout(timeout);
    stop();
    await exit.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
  }
}

async function hasCheckpointAttribute(worktree: string, attribute: string): Promise<boolean> {
  return checkpointInventoryHasRecord(
    worktree,
    [
      "ls-files",
      "-z",
      "--",
      ":(top)",
      `:(top,exclude,attr:!${attribute})`,
      `:(top,exclude,attr:-${attribute})`,
    ],
    () => true,
  );
}

/** Copy a generated Git index into an already-exclusive lock without retaining the whole file. */
export async function copyIndexIntoLock(
  sourcePath: string,
  destination: Pick<FileHandle, "write">,
): Promise<number> {
  const source = await open(sourcePath, "r");
  try {
    const before = await source.stat();
    if (!before.isFile())
      throw new RepositoryError("The checkpoint index is not a regular file.", 409);
    const buffer = Buffer.allocUnsafe(INDEX_COPY_BUFFER_BYTES);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw new RepositoryError("The checkpoint index changed while it was copied.", 409);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        if (result.bytesWritten === 0) {
          throw new RepositoryError("The checkpoint index lock could not be written.", 409);
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if ((await source.read(buffer, 0, 1, before.size)).bytesRead !== 0) {
      throw new RepositoryError("The checkpoint index changed while it was copied.", 409);
    }
    const after = await source.stat();
    if (
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new RepositoryError("The checkpoint index changed while it was copied.", 409);
    }
    return position;
  } finally {
    await source.close();
  }
}

export async function checkpointGitDirectory(worktree: string): Promise<string> {
  const value = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(resolve(worktree, value));
}

export async function assertCheckpointable(worktree: string, allowChanges: boolean): Promise<void> {
  const hasSubmodule = await checkpointInventoryHasRecord(
    worktree,
    ["ls-files", "--stage", "-z"],
    (record) => record.subarray(0, 7).toString("ascii") === "160000 ",
  );
  if (hasSubmodule) {
    throw new RepositoryError(
      "Checkpoints are unavailable while the worktree contains submodules.",
      409,
    );
  }
  // Gitignored paths (node_modules, build output, .env, .DS_Store, …) are outside
  // checkpoint scope: `git add -A` never stages them, so they are not snapshotted
  // or rewritten on rewind. Refusing capture whenever any ignored path exists on
  // disk made checkpoints unusable on ordinary projects. Leave them alone.
  const porcelain = await git(worktree, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = porcelain.split("\0").filter(Boolean);
  if (!allowChanges && entries.length > 0) {
    throw new RepositoryError(
      entries.some((entry) => entry.startsWith("?? "))
        ? "Start the turn with no untracked files so unrelated work cannot be lost."
        : "Start the turn with a clean worktree so unrelated work cannot be lost.",
      409,
    );
  }
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const filesystemPaths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const path = entry.slice(3);
    changedPaths.push(path);
    if (entry.startsWith("?? ")) untrackedPaths.push(path);
    if (entry[0] !== "D" && entry[1] !== "D") filesystemPaths.push(path);
    if (
      (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") &&
      entries[index + 1]
    ) {
      changedPaths.push(entries[++index]);
    }
  }
  if (
    (await hasCheckpointAttribute(worktree, "filter")) ||
    (await hasCheckpointAttribute(worktree, "working-tree-encoding"))
  ) {
    throw new RepositoryError(
      "Checkpoints are unavailable for files transformed by Git filters or working-tree encodings.",
      409,
    );
  }
  for (let index = 0; index < untrackedPaths.length; index += 200) {
    const attributes = await git(worktree, [
      "check-attr",
      "-z",
      "filter",
      "working-tree-encoding",
      "--",
      ...untrackedPaths.slice(index, index + 200),
    ]);
    const fields = attributes.split("\0").filter(Boolean);
    for (let field = 0; field < fields.length; field += 3) {
      const attribute = fields[field + 1];
      const value = fields[field + 2];
      if (
        (attribute === "filter" || attribute === "working-tree-encoding") &&
        value !== "unspecified" &&
        value !== "unset"
      ) {
        throw new RepositoryError(
          "Checkpoints are unavailable for files transformed by Git filters or working-tree encodings.",
          409,
        );
      }
    }
  }
  if (changedPaths.length > 0) {
    const changed = new Set(changedPaths);
    const hasChangedSymlink = await checkpointInventoryHasRecord(
      worktree,
      ["ls-files", "--stage", "-z"],
      (record) => {
        if (record.subarray(0, 7).toString("ascii") !== "120000 ") return false;
        const separator = record.indexOf(9);
        return separator >= 0 && changed.has(record.subarray(separator + 1).toString("utf8"));
      },
    );
    if (hasChangedSymlink) {
      throw new RepositoryError(
        "Checkpoints are unavailable when a changed path is a symlink.",
        409,
      );
    }
  }
  for (const path of filesystemPaths) {
    try {
      const details = await lstat(join(worktree, path));
      if (details.isSymbolicLink()) {
        throw new RepositoryError(
          "Checkpoints are unavailable when a changed path is a symlink.",
          409,
        );
      }
      if (details.isDirectory()) {
        try {
          await lstat(join(worktree, path, ".git"));
          throw new RepositoryError(
            "Checkpoints are unavailable when an untracked path is an embedded Git repository.",
            409,
          );
        } catch (error) {
          if (error instanceof RepositoryError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function captureCheckpoint(
  worktree: string,
  allowChanges: boolean,
  reference?: string,
): Promise<CheckpointSnapshot> {
  const workspace = await captureWorkspaceIdentity(worktree, allowChanges);
  const indexIdentity = (await git(worktree, ["write-tree"])).trim();
  if (reference) {
    await git(worktree, ["update-ref", reference, workspace.identity]);
    await git(worktree, ["update-ref", `${reference}-index`, indexIdentity]);
  }
  return { ...workspace, indexIdentity };
}

async function captureWorkspaceIdentity(
  worktree: string,
  allowChanges: boolean,
): Promise<Omit<CheckpointSnapshot, "indexIdentity">> {
  await assertCheckpointable(worktree, allowChanges);
  const head = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const commonDirectory = await checkpointGitDirectory(worktree);
  const temporary = await mkdtemp(join(tmpdir(), "aldunis-checkpoint-"));
  const indexPath = join(temporary, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await git(worktree, ["read-tree", "HEAD"], { env: environment });
    await git(worktree, ["add", "-A", "--", "."], { env: environment });
    const identity = (await git(worktree, ["write-tree"], { env: environment })).trim();
    return { identity, head, gitDirectory: commonDirectory };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseNameStatus(output: string): CheckpointFile[] {
  const fields = output.split("\0").filter(Boolean);
  const files: CheckpointFile[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    const status = code[0];
    const firstPath = fields[index++];
    const renamed = status === "R" || status === "C";
    const path = renamed ? fields[index++] : firstPath;
    files.push({
      path,
      previousPath: renamed ? firstPath : null,
      state:
        status === "A" ? "added" : status === "D" ? "deleted" : renamed ? "renamed" : "modified",
      additions: null,
      deletions: null,
    });
  }
  return files;
}

function parseNumstat(
  output: string,
): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const field of output.split("\0").filter(Boolean)) {
    const firstTab = field.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : field.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = field.slice(0, firstTab);
    const deleted = field.slice(firstTab + 1, secondTab);
    const path = field.slice(secondTab + 1);
    if (!path) continue;
    stats.set(path, {
      additions: added === "-" ? null : Number.isFinite(Number(added)) ? Number(added) : null,
      deletions: deleted === "-" ? null : Number.isFinite(Number(deleted)) ? Number(deleted) : null,
    });
  }
  return stats;
}

export async function checkpointDiff(
  worktree: string,
  fromIdentity: string,
  toIdentity: string,
): Promise<CheckpointFile[]> {
  const output = await git(worktree, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    fromIdentity,
    toIdentity,
    "--",
  ]);
  const files = parseNameStatus(output);
  // Do not ask Git to detect renames for numstat: the NUL-delimited output
  // for a rename has two path fields, while the name-status result above has
  // already normalized the old and new paths for us.
  const stats = parseNumstat(
    await git(worktree, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      fromIdentity,
      toIdentity,
      "--",
    ]),
  );
  return files.map((file) => {
    const stat =
      stats.get(file.path) ?? (file.previousPath ? stats.get(file.previousPath) : undefined);
    const binary = stat?.additions === null && stat.deletions === null;
    return {
      ...file,
      additions: binary ? null : (stat?.additions ?? 0),
      deletions: binary ? null : (stat?.deletions ?? 0),
      state: binary ? "binary" : file.state,
    };
  });
}

export async function rewindCheckpoint(
  worktree: string,
  currentIdentity: string,
  currentIndexIdentity: string,
  currentHead: string,
  targetIdentity: string,
  targetIndexIdentity: string,
): Promise<CheckpointFile[]> {
  await assertCheckpointable(worktree, true);
  const current = await captureCheckpoint(worktree, true);
  if (current.identity !== currentIdentity) {
    throw new RepositoryError(
      "The workspace changed after this rewind was prepared. Preview it again before confirming.",
      409,
    );
  }
  if (current.indexIdentity !== currentIndexIdentity) {
    throw new RepositoryError(
      "The Git index changed after this rewind was prepared. Preview it again before confirming.",
      409,
    );
  }
  if (current.head !== currentHead) {
    throw new RepositoryError(
      "HEAD changed after this rewind was prepared. Rewind does not rewrite Git history.",
      409,
    );
  }
  const files = await checkpointDiff(worktree, currentIdentity, targetIdentity);
  const temporary = await mkdtemp(join(tmpdir(), "aldunis-rewind-"));
  const patchPath = join(temporary, "rewind.patch");
  const targetIndexPath = join(temporary, "target-index");
  const indexValue = (await git(worktree, ["rev-parse", "--git-path", "index"])).trim();
  const indexPath = resolve(worktree, indexValue);
  const indexLockPath = `${indexPath}.lock`;
  let indexLockCreated = false;
  try {
    const targetEnvironment = { ...process.env, GIT_INDEX_FILE: targetIndexPath };
    await git(worktree, ["read-tree", targetIndexIdentity], { env: targetEnvironment });
    if (files.length > 0) {
      const patch = await gitBuffer(worktree, [
        "diff",
        "--binary",
        "--full-index",
        currentIdentity,
        targetIdentity,
        "--",
      ]);
      await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
      await git(worktree, ["apply", "--check", "--whitespace=nowarn", patchPath], {
        maxBuffer: 32 * 1024 * 1024,
      });
    }
    const indexLock = await open(indexLockPath, "wx", 0o600);
    indexLockCreated = true;
    try {
      await copyIndexIntoLock(targetIndexPath, indexLock);
      await indexLock.sync();
    } finally {
      await indexLock.close();
    }
    const lockedCurrent = await captureWorkspaceIdentity(worktree, true);
    if (lockedCurrent.identity !== currentIdentity || lockedCurrent.head !== currentHead) {
      throw new RepositoryError(
        "The workspace changed while acquiring the rewind lock. Preview it again before confirming.",
        409,
      );
    }
    if (files.length > 0) {
      await git(worktree, ["apply", "--whitespace=nowarn", patchPath], {
        maxBuffer: 32 * 1024 * 1024,
      });
    }
    const restored = await captureWorkspaceIdentity(worktree, true);
    if (restored.identity !== targetIdentity || restored.head !== currentHead) {
      if (files.length > 0) {
        await git(worktree, ["apply", "--reverse", "--whitespace=nowarn", patchPath], {
          maxBuffer: 32 * 1024 * 1024,
        });
      }
      throw new RepositoryError(
        "The workspace changed during rewind. The rewind was rolled back; preview it again.",
        409,
      );
    }
    await rename(indexLockPath, indexPath);
    indexLockCreated = false;
  } finally {
    if (indexLockCreated) await rm(indexLockPath, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
  return files;
}

export function checkpointReference(checkpointId: string, phase: "baseline" | "completed"): string {
  if (!/^[0-9a-f-]+$/.test(checkpointId)) {
    throw new RepositoryError("The checkpoint identity is invalid.");
  }
  return `refs/aldunis-code/checkpoints/${checkpointId}/${phase}`;
}

export async function deleteCheckpointReferences(
  commonDirectory: string,
  checkpointId: string,
): Promise<void> {
  try {
    if (!(await stat(commonDirectory)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new RepositoryError("Checkpoint references could not be inspected for deletion.", 409);
  }
  for (const phase of ["baseline", "baseline-index", "completed", "completed-index"]) {
    try {
      await execFileAsync(
        "git",
        [
          "--git-dir",
          commonDirectory,
          "update-ref",
          "-d",
          `refs/aldunis-code/checkpoints/${checkpointId}/${phase}`,
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
    } catch {
      throw new RepositoryError("Checkpoint references could not be deleted.", 409);
    }
  }
}

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export async function canonicalizeRepositoryRoot(input: string): Promise<string> {
  const selected = expandUserPath(input);
  if (!selected || !isAbsolute(selected)) {
    throw new RepositoryError("Select an absolute repository path (or ~/…).");
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(selected));
    if (!(await stat(canonical)).isDirectory()) {
      throw new RepositoryError("The selected path is not a directory.");
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The selected repository is missing or inaccessible.");
  }

  let gitRoot: string;
  try {
    const result = await execFileAsync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    gitRoot = await realpath(result.stdout.trim());
  } catch {
    throw new RepositoryError("The selected path is not inside a Git repository.");
  }

  return gitRoot;
}

export async function constrainPath(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCandidate = await realpath(candidate);
  const pathFromRoot = relative(canonicalRoot, canonicalCandidate);

  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new RepositoryError("The requested path escapes the selected repository root.", 403);
  }

  return canonicalCandidate;
}

export async function classifyWorktree(path: string, detached: boolean): Promise<WorktreeState> {
  try {
    const details = await stat(path);
    if (!details.isDirectory()) return "missing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "inaccessible";
  }

  try {
    await access(path, constants.R_OK | constants.X_OK);
  } catch {
    return "inaccessible";
  }

  return detached ? "detached" : "available";
}

interface DiscoveredWorktreeRecord {
  [key: string]: string | true | undefined;
  worktree: string | true;
  HEAD?: string | true;
  branch?: string | true;
  detached?: string | true;
}

export async function classifyDiscoveredWorktrees(
  records: DiscoveredWorktreeRecord[],
  classifier: (path: string, detached: boolean) => Promise<WorktreeState> = classifyWorktree,
): Promise<WorktreeMetadata[]> {
  const worktrees = new Array<WorktreeMetadata>(records.length);
  let nextIndex = 0;
  const classifyNext = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= records.length) return;
      const record = records[index];
      const path = String(record.worktree);
      const detached = record.detached === true;
      worktrees[index] = {
        path,
        head: typeof record.HEAD === "string" ? record.HEAD : null,
        branch:
          typeof record.branch === "string" ? record.branch.replace(/^refs\/heads\//, "") : null,
        state: await classifier(path, detached),
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(WORKTREE_CLASSIFICATION_CONCURRENCY, records.length) },
      classifyNext,
    ),
  );
  return worktrees;
}

export async function canonicalizeDiscoveredWorktreePaths(
  worktrees: ReadonlyArray<Pick<WorktreeMetadata, "path">>,
  canonicalize: (path: string) => Promise<string> = realpath,
): Promise<Set<string>> {
  const canonicalPaths = new Array<string | null>(worktrees.length);
  let nextIndex = 0;
  const canonicalizeNext = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= worktrees.length) return;
      canonicalPaths[index] = await canonicalize(worktrees[index].path).catch(() => null);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(WORKTREE_CLASSIFICATION_CONCURRENCY, worktrees.length) },
      canonicalizeNext,
    ),
  );
  return new Set(canonicalPaths.filter((path): path is string => path !== null));
}

export async function discoverWorktrees(
  root: string,
  command = "git",
): Promise<WorktreeMetadata[]> {
  const child = spawn(command, ["-C", root, "worktree", "list", "--porcelain", "-z"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = new Promise<{ code: number | null; childSignal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, childSignal) => resolveExit({ code, childSignal }));
    },
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_WORKTREE_DISCOVERY_STDERR_BYTES) return;
    const retained = chunk.subarray(0, MAX_WORKTREE_DISCOVERY_STDERR_BYTES - stderrBytes);
    stderr.push(Buffer.from(retained));
    stderrBytes += retained.length;
  });
  let pending = Buffer.alloc(0);
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    escalation.unref?.();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, WORKTREE_DISCOVERY_TIMEOUT_MS);
  timeout.unref?.();
  const records: DiscoveredWorktreeRecord[] = [];
  let current: DiscoveredWorktreeRecord | undefined;
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = joined.indexOf(0, start);
        if (end < 0) break;
        if (end - start > MAX_WORKTREE_DISCOVERY_RECORD_BYTES) {
          throw new RepositoryError(
            "A worktree inventory record exceeded its resource limit.",
            409,
          );
        }
        const field = joined.toString("utf8", start, end);
        start = end + 1;
        if (!field) {
          current = undefined;
          continue;
        }
        const separator = field.indexOf(" ");
        const key = separator === -1 ? field : field.slice(0, separator);
        const value = separator === -1 ? true : field.slice(separator + 1);
        if (key === "worktree" && typeof value === "string" && value && !current) {
          current = { worktree: value };
          records.push(current);
        } else if (current) {
          current[key] = value;
        } else {
          throw new RepositoryError("Git returned a malformed worktree inventory.", 409);
        }
      }
      pending = Buffer.from(joined.subarray(start));
      if (pending.length > MAX_WORKTREE_DISCOVERY_RECORD_BYTES) {
        throw new RepositoryError("A worktree inventory record exceeded its resource limit.", 409);
      }
    }
    const completion = await exit;
    if (timedOut) {
      throw new RepositoryError("Git did not finish while discovering worktrees.", 409);
    }
    if (pending.length > 0 || current) {
      throw new RepositoryError("Git returned an incomplete worktree inventory.", 409);
    }
    if (completion.code !== 0) {
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
      throw new RepositoryError(detail || "Git could not discover repository worktrees.", 409);
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if (timedOut) {
      throw new RepositoryError("Git did not finish while discovering worktrees.", 409);
    }
    throw new RepositoryError("Git could not discover repository worktrees.", 409);
  } finally {
    clearTimeout(timeout);
    stop();
    await exit.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
  }

  return classifyDiscoveredWorktrees(records);
}

export const WORKTREE_DISCOVERY_CLASSIFICATION_CONCURRENCY = WORKTREE_CLASSIFICATION_CONCURRENCY;

export async function repositoryCommonDir(worktreePath: string): Promise<string> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  return checkpointGitDirectory(root);
}

/** Primary checkout path for a repository (first entry from `git worktree list`). */
export async function repositoryMainRoot(worktreePath: string): Promise<string> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  const worktrees = await discoverWorktrees(root);
  return resolveRepositoryMainRoot(root, worktrees);
}

export async function resolveRepositoryMainRoot(
  root: string,
  worktrees: ReadonlyArray<Pick<WorktreeMetadata, "path">>,
  canonicalize: (path: string) => Promise<string> = realpath,
): Promise<string> {
  const primary = worktrees[0]?.path;
  if (!primary) return root;
  try {
    return await canonicalize(primary);
  } catch {
    return root;
  }
}

/**
 * List local branch names that can be offered as worktree creation bases.
 * Sorted for stable UI presentation. Remote-only refs are excluded.
 */
export async function repositoryLocalBranches(worktreePath: string): Promise<string[]> {
  return (await repositoryLocalBranchProjection(worktreePath)).branches;
}

export interface LocalBranchProjection {
  branches: string[];
  count: number;
  truncated: boolean;
}

function retainLocalBranch(branches: string[], branch: string): void {
  let low = 0;
  let high = branches.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (branches[middle].localeCompare(branch) < 0) low = middle + 1;
    else high = middle;
  }
  branches.splice(low, 0, branch);
  if (branches.length > MAX_LOCAL_BRANCH_SUGGESTIONS) branches.pop();
}

export async function repositoryLocalBranchProjection(
  worktreePath: string,
  command = "git",
  timeoutMs = LOCAL_BRANCH_DISCOVERY_TIMEOUT_MS,
): Promise<LocalBranchProjection> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  const child = spawn(
    command,
    ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exit = new Promise<{ code: number | null; childSignal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, childSignal) => resolveExit({ code, childSignal }));
    },
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_LOCAL_BRANCH_STDERR_BYTES) return;
    const retained = chunk.subarray(0, MAX_LOCAL_BRANCH_STDERR_BYTES - stderrBytes);
    stderr.push(Buffer.from(retained));
    stderrBytes += retained.length;
  });
  let pending = Buffer.alloc(0);
  let count = 0;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const branches: string[] = [];
  const retainedDefaultCandidates = new Set<string>();
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    escalation.unref?.();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref?.();
  const admit = (record: Buffer) => {
    const branch = record.toString("utf8").replace(/\r$/, "").trim();
    if (!branch) throw new RepositoryError("Git returned a malformed local branch inventory.", 409);
    count += 1;
    if (DEFAULT_BRANCH_CANDIDATES.has(branch)) retainedDefaultCandidates.add(branch);
    retainLocalBranch(branches, branch);
  };
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = joined.indexOf(10, start);
        if (end < 0) break;
        if (end - start > MAX_LOCAL_BRANCH_RECORD_BYTES) {
          throw new RepositoryError("A local branch name exceeded its resource limit.", 409);
        }
        admit(joined.subarray(start, end));
        start = end + 1;
      }
      pending = Buffer.from(joined.subarray(start));
      if (pending.length > MAX_LOCAL_BRANCH_RECORD_BYTES) {
        throw new RepositoryError("A local branch name exceeded its resource limit.", 409);
      }
    }
    const completion = await exit;
    if (timedOut) {
      throw new RepositoryError("Git did not finish while discovering local branches.", 409);
    }
    if (pending.length > 0) admit(pending);
    if (completion.code !== 0) {
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
      throw new RepositoryError(detail || "Git could not discover local branches.", 409);
    }
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    if (timedOut) {
      throw new RepositoryError("Git did not finish while discovering local branches.", 409);
    }
    throw new RepositoryError("Git could not discover local branches.", 409);
  } finally {
    clearTimeout(timeout);
    stop();
    await exit.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
  }
  for (const candidate of retainedDefaultCandidates) {
    if (!branches.includes(candidate)) branches.push(candidate);
  }
  branches.sort((left, right) => left.localeCompare(right));
  while (branches.length > MAX_LOCAL_BRANCH_SUGGESTIONS) {
    const removable = branches.findLastIndex((branch) => !retainedDefaultCandidates.has(branch));
    if (removable < 0) break;
    branches.splice(removable, 1);
  }
  return { branches, count, truncated: count > branches.length };
}

/**
 * Resolve the repository default branch used when the operator does not pick
 * an explicit worktree base.
 *
 * Configured remote HEADs are the strongest local signal for a repository's
 * default branch. They must agree when more than one is present. Without one,
 * use a conventional branch name; never infer the default from the currently
 * checked-out branch.
 *
 * A null result is intentional: opening a repository remains available when
 * its default branch cannot be determined. Managed worktree creation still
 * succeeds when the operator selects an explicit local base branch.
 */
export async function repositoryDefaultBranch(worktreePath: string): Promise<string | null> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  const remotes = (await optionalGit(root, ["remote"]))?.split(/\r?\n/).filter(Boolean) ?? [];
  const remoteHeads: Array<{ remote: string; branch: string; ref: string }> = [];
  for (const remote of remotes) {
    const remoteHead = await optionalGit(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (!remoteHead || !remoteHead.startsWith(`${remote}/`)) continue;
    remoteHeads.push({
      remote,
      branch: remoteHead.slice(remote.length + 1),
      ref: remoteHead,
    });
  }
  const remoteBranches = new Set(remoteHeads.map((head) => head.branch));
  if (remoteBranches.size > 1) {
    return null;
  }
  if (remoteHeads.length > 0) {
    const { branch, ref } = remoteHeads[0]!;
    const localBranch = await optionalGit(root, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    ]);
    return localBranch === null ? ref : branch;
  }

  const localBranches = await repositoryLocalBranches(root);
  for (const candidate of ["main", "master", "trunk"]) {
    if (candidate && localBranches.includes(candidate)) return candidate;
  }
  return null;
}

export interface CollapsedProject {
  id: string;
  name: string;
  root: string;
  openedAt: string;
  /** All local project record ids that share this git repository (main + worktrees). */
  memberIds: string[];
  /** Exact saved root for each local project record in this repository group. */
  memberRoots: Record<string, string>;
  /** Per-record bindings retained when repository worktrees collapse into one chip. */
  chiseiBindings: Record<string, string | null>;
  chiseiNamespace?: string | null;
}

/**
 * Collapse worktree/main checkouts of the same git repository into one project
 * chip. Prefer the most recently opened record; expose the main worktree path
 * as `root` when resolvable.
 */
export async function collapseProjectsByRepository(
  projects: Array<{
    id: string;
    name: string;
    root: string;
    openedAt: string;
    chiseiNamespace?: string | null;
  }>,
): Promise<CollapsedProject[]> {
  const sorted = [...projects].sort(
    (left, right) =>
      right.openedAt.localeCompare(left.openedAt) || left.root.localeCompare(right.root),
  );
  const groups = new Map<
    string,
    {
      winner: (typeof sorted)[number];
      memberIds: string[];
      commonDir: string;
    }
  >();

  for (const project of sorted) {
    let key: string;
    try {
      key = await repositoryCommonDir(project.root);
    } catch {
      // Missing/orphaned worktree records: fold into an existing same-name
      // repository chip instead of spawning another "aldunis-code" entry.
      const sameName = [...groups.values()].find(
        (group) => group.winner.name === project.name && !group.commonDir.startsWith("path:"),
      );
      if (sameName) {
        sameName.memberIds.push(project.id);
        continue;
      }
      if (isEphemeralWorktreePath(project.root)) {
        // Drop unreachable agent worktrees that never had a main checkout saved.
        continue;
      }
      key = `path:${project.root}`;
    }
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { winner: project, memberIds: [project.id], commonDir: key });
      continue;
    }
    existing.memberIds.push(project.id);
    // Prefer a non-worktree-looking path when the winner is a managed/agent worktree.
    const winnerLooksEphemeral = isEphemeralWorktreePath(existing.winner.root);
    const candidateLooksPrimary = !isEphemeralWorktreePath(project.root);
    if (winnerLooksEphemeral && candidateLooksPrimary) {
      existing.winner = project;
    }
  }

  const collapsed: CollapsedProject[] = [];
  for (const group of groups.values()) {
    let root = group.winner.root;
    try {
      root = await repositoryMainRoot(group.winner.root);
    } catch {
      /* keep winner root */
    }
    const name = root.split(sep).filter(Boolean).at(-1) ?? group.winner.name;
    collapsed.push({
      id: group.winner.id,
      name,
      root,
      openedAt: group.winner.openedAt,
      memberIds: [...new Set(group.memberIds)],
      memberRoots: Object.fromEntries(
        projects
          .filter((project) => group.memberIds.includes(project.id))
          .map((project) => [project.id, project.root]),
      ),
      chiseiBindings: Object.fromEntries(
        projects
          .filter((project) => group.memberIds.includes(project.id))
          .map((project) => [project.id, project.chiseiNamespace ?? null]),
      ),
      chiseiNamespace: group.winner.chiseiNamespace ?? null,
    });
  }

  // Stable chip order: name, then root. Do not sort by last-selected time.
  return collapsed.sort(
    (left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root),
  );
}

function isEphemeralWorktreePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.includes("/.codex/worktrees/") ||
    normalized.includes("/.aldunis/wt/") ||
    normalized.includes("/.git/worktrees/")
  );
}

interface OpenRepositoryOperations {
  canonicalize(input: string): Promise<string>;
  discover(root: string): Promise<WorktreeMetadata[]>;
  resolveMainRoot(
    root: string,
    worktrees: ReadonlyArray<Pick<WorktreeMetadata, "path">>,
  ): Promise<string>;
  defaultBranch(root: string): Promise<string | null>;
  localBranches(root: string): Promise<LocalBranchProjection | string[]>;
}

const openRepositoryOperations: OpenRepositoryOperations = {
  canonicalize: canonicalizeRepositoryRoot,
  discover: discoverWorktrees,
  resolveMainRoot: resolveRepositoryMainRoot,
  defaultBranch: repositoryDefaultBranch,
  localBranches: repositoryLocalBranchProjection,
};

export async function openRepository(
  input: string,
  operations: OpenRepositoryOperations = openRepositoryOperations,
): Promise<RepositoryMetadata> {
  const selected = await operations.canonicalize(input);
  const worktrees = await operations.discover(selected);
  const mainRoot = await operations.resolveMainRoot(selected, worktrees);
  const [defaultBranch, localBranchResult] = await Promise.all([
    operations.defaultBranch(mainRoot),
    operations.localBranches(mainRoot),
  ]);
  const localBranchProjection = Array.isArray(localBranchResult)
    ? {
        branches: localBranchResult,
        count: localBranchResult.length,
        truncated: false,
      }
    : localBranchResult;
  return {
    name:
      mainRoot.split(sep).filter(Boolean).at(-1) ??
      selected.split(sep).filter(Boolean).at(-1) ??
      mainRoot,
    root: mainRoot,
    defaultBranch,
    localBranches: localBranchProjection.branches,
    localBranchCount: localBranchProjection.count,
    localBranchesTruncated: localBranchProjection.truncated,
    selectedWorktree: selected,
    worktrees,
  };
}
