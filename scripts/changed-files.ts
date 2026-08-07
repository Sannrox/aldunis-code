import { execFileSync } from "node:child_process";

export interface ChangedFilesOptions {
  base?: string;
  cwd?: string;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function parseNullSeparated(value: string): string[] {
  return value
    .split("\0")
    .map((file) => file.replaceAll("\\", "/"))
    .filter(Boolean);
}

function revisionExists(cwd: string, revision: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", revision], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveBaseRevision(cwd = process.cwd(), requested?: string): string | undefined {
  if (requested && revisionExists(cwd, requested)) return requested;

  const configured = process.env.DETERMINISTIC_CHECK_BASE;
  if (configured && revisionExists(cwd, configured)) return configured;

  const githubBase = process.env.GITHUB_BASE_REF;
  if (githubBase && revisionExists(cwd, `origin/${githubBase}`)) {
    return `origin/${githubBase}`;
  }

  if (revisionExists(cwd, "origin/main")) return "origin/main";
  if (revisionExists(cwd, "HEAD^")) return "HEAD^";
  return undefined;
}

function diffFiles(cwd: string, base: string): string[] {
  return parseNullSeparated(
    git(cwd, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", `${base}...HEAD`]),
  );
}

export function listTrackedFiles(cwd = process.cwd()): string[] {
  return [
    ...new Set(parseNullSeparated(git(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]))),
  ].sort();
}

export function getChangedFiles(options: ChangedFilesOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const workingTree = new Set([
    ...parseNullSeparated(git(cwd, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"])),
    ...parseNullSeparated(
      git(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]),
    ),
    ...parseNullSeparated(git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])),
  ]);

  const base = resolveBaseRevision(cwd, options.base);
  const files = new Set(base ? diffFiles(cwd, base) : []);
  for (const file of workingTree) files.add(file);

  // A clean checkout of the default branch has no diff from origin/main. Use
  // the tip commit as a conservative local/CI fallback in that case.
  if (files.size === 0 && workingTree.size === 0 && base !== "HEAD^") {
    for (const file of diffFiles(cwd, "HEAD^")) files.add(file);
  }

  return [...files].sort();
}
