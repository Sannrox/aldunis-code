import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
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

export async function canonicalizeRepositoryRoot(input: string): Promise<string> {
  const selected = input.trim();
  if (!selected || !isAbsolute(selected)) {
    throw new RepositoryError("Select an absolute repository path.");
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

export async function openRepository(input: string): Promise<RepositoryMetadata> {
  const root = await canonicalizeRepositoryRoot(input);
  const worktrees = await discoverWorktrees(root);
  return {
    name: root.split(sep).filter(Boolean).at(-1) ?? root,
    root,
    selectedWorktree: root,
    worktrees,
  };
}
