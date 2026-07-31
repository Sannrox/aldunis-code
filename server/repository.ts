import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function checkpointGitDirectory(worktree: string): Promise<string> {
  const value = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
  return realpath(resolve(worktree, value));
}

async function assertCheckpointable(worktree: string, allowChanges: boolean): Promise<void> {
  const submodules = await git(worktree, ["ls-files", "--stage"]);
  if (submodules.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new RepositoryError("Checkpoints are unavailable while the worktree contains submodules.", 409);
  }
  // Gitignored paths (node_modules, build output, .env, .DS_Store, …) are outside
  // checkpoint scope: `git add -A` never stages them, so they are not snapshotted
  // or rewritten on rewind. Refusing capture whenever any ignored path exists on
  // disk made checkpoints unusable on ordinary projects. Leave them alone.
  const porcelain = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    changedPaths.push(entry.slice(3));
    if ((entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C")
      && entries[index + 1]) {
      changedPaths.push(entries[++index]);
    }
  }
  const trackedPaths = (await git(worktree, ["ls-files", "-z"])).split("\0").filter(Boolean);
  const attributePaths = [...new Set([...trackedPaths, ...changedPaths])];
  for (let index = 0; index < attributePaths.length; index += 200) {
    const attributes = await git(worktree, [
      "check-attr",
      "-z",
      "filter",
      "working-tree-encoding",
      "--",
      ...attributePaths.slice(index, index + 200),
    ]);
    const fields = attributes.split("\0").filter(Boolean);
    for (let field = 0; field < fields.length; field += 3) {
      const attribute = fields[field + 1];
      const value = fields[field + 2];
      if ((attribute === "filter" || attribute === "working-tree-encoding")
        && value !== "unspecified"
        && value !== "unset") {
        throw new RepositoryError(
          "Checkpoints are unavailable for files transformed by Git filters or working-tree encodings.",
          409,
        );
      }
    }
  }
  if (changedPaths.length > 0) {
    const trackedModes = await git(worktree, ["ls-files", "--stage", "--", ...changedPaths]);
    if (trackedModes.split("\n").some((line) => line.startsWith("120000 "))) {
      throw new RepositoryError("Checkpoints are unavailable when a changed path is a symlink.", 409);
    }
  }
  for (const path of changedPaths) {
    try {
      const details = await lstat(join(worktree, path));
      if (details.isSymbolicLink()) {
        throw new RepositoryError("Checkpoints are unavailable when a changed path is a symlink.", 409);
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
      state: status === "A"
        ? "added"
        : status === "D"
          ? "deleted"
          : renamed
            ? "renamed"
            : "modified",
    });
  }
  return files;
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
  const binary = await git(worktree, ["diff", "--numstat", "-z", fromIdentity, toIdentity, "--"]);
  const binaryPaths = new Set(
    binary.split("\0").filter(Boolean).flatMap((field) => {
      const [added, deleted, ...pathParts] = field.split("\t");
      return added === "-" && deleted === "-" ? [pathParts.join("\t")] : [];
    }),
  );
  return files.map((file) => binaryPaths.has(file.path) ? { ...file, state: "binary" } : file);
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
      const patch = await gitBuffer(
        worktree,
        ["diff", "--binary", "--full-index", currentIdentity, targetIdentity, "--"],
      );
      await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
      await git(worktree, ["apply", "--check", "--whitespace=nowarn", patchPath], {
        maxBuffer: 32 * 1024 * 1024,
      });
    }
    const indexLock = await open(indexLockPath, "wx", 0o600);
    indexLockCreated = true;
    try {
      await indexLock.writeFile(await readFile(targetIndexPath));
      await indexLock.sync();
    } finally {
      await indexLock.close();
    }
    const lockedCurrent = await captureWorkspaceIdentity(worktree, true);
    if (
      lockedCurrent.identity !== currentIdentity
      || lockedCurrent.head !== currentHead
    ) {
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
      await execFileAsync("git", [
        "--git-dir",
        commonDirectory,
        "update-ref",
        "-d",
        `refs/aldunis-code/checkpoints/${checkpointId}/${phase}`,
      ], { encoding: "utf8", timeout: 15_000 });
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
    const result = await execFileAsync(
      "git",
      ["-C", canonical, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5_000 },
    );
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

export async function discoverWorktrees(root: string): Promise<WorktreeMetadata[]> {
  const result = await execFileAsync(
    "git",
    ["-C", root, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  const fields = result.stdout.split("\0").filter(Boolean);
  const records: Array<Record<string, string | true>> = [];
  let current: Record<string, string | true> | undefined;

  for (const field of fields) {
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? true : field.slice(separator + 1);
    if (key === "worktree") {
      current = { worktree: value };
      records.push(current);
    } else if (current) {
      current[key] = value;
    }
  }

  return Promise.all(records.map(async (record) => {
    const path = String(record.worktree);
    const detached = record.detached === true;
    return {
      path,
      head: typeof record.HEAD === "string" ? record.HEAD : null,
      branch: typeof record.branch === "string"
        ? record.branch.replace(/^refs\/heads\//, "")
        : null,
      state: await classifyWorktree(path, detached),
    };
  }));
}

export async function repositoryCommonDir(worktreePath: string): Promise<string> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  return checkpointGitDirectory(root);
}

/** Primary checkout path for a repository (first entry from `git worktree list`). */
export async function repositoryMainRoot(worktreePath: string): Promise<string> {
  const root = await canonicalizeRepositoryRoot(worktreePath);
  const worktrees = await discoverWorktrees(root);
  const primary = worktrees[0]?.path;
  if (!primary) return root;
  try {
    return await realpath(primary);
  } catch {
    return root;
  }
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
    (left, right) => right.openedAt.localeCompare(left.openedAt) || left.root.localeCompare(right.root),
  );
  const groups = new Map<string, {
    winner: (typeof sorted)[number];
    memberIds: string[];
    commonDir: string;
  }>();

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
    normalized.includes("/.codex/worktrees/")
    || normalized.includes("/.aldunis/wt/")
    || normalized.includes("/.git/worktrees/")
  );
}

export async function openRepository(input: string): Promise<RepositoryMetadata> {
  const selected = await canonicalizeRepositoryRoot(input);
  const mainRoot = await repositoryMainRoot(selected);
  const worktrees = await discoverWorktrees(mainRoot);
  return {
    name: mainRoot.split(sep).filter(Boolean).at(-1) ?? selected.split(sep).filter(Boolean).at(-1) ?? mainRoot,
    root: mainRoot,
    selectedWorktree: selected,
    worktrees,
  };
}
