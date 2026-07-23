import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { RepositoryError } from "./repository.ts";

const execFileAsync = promisify(execFile);
const PLAN_TTL_MS = 5 * 60_000;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

export type DeliveryAction = "stage" | "commit" | "push" | "pull_request";

export interface DeliveryContext {
  repository: string;
  worktree: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  remotes: Array<{ name: string; url: string }>;
  staged: string[];
  unstaged: string[];
}

export interface DeliveryPlan {
  id: string;
  action: DeliveryAction;
  summary: string;
  repository: string;
  worktree: string;
  branch: string;
  remote: string | null;
  destination: string | null;
  details: string[];
  expiresAt: string;
}

interface PendingPlan extends DeliveryPlan {
  args: string[];
  stateBinding: string;
  used: boolean;
}

async function run(worktree: string, command: string, args: string[], timeout = 15_000) {
  try {
    return await execFileAsync(command, args, {
      cwd: worktree,
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { stderr?: string };
    const detail = sanitizeDiagnostic(error.stderr?.trim().split("\n").at(-1) ?? "");
    throw new RepositoryError(detail || "The Git action failed.", 409);
  }
}

async function git(worktree: string, args: string[]) {
  return run(worktree, "git", args);
}

async function fingerprint(
  worktree: string,
  action: DeliveryAction,
  paths: string[],
  remote: string | null,
): Promise<string> {
  const head = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  if (action === "stage") {
    const status = (await git(worktree, ["status", "--porcelain=v1", "-z", "--", ...paths])).stdout;
    const hashes: string[] = [];
    for (const path of paths) {
      const object = await git(worktree, ["hash-object", "--", path]).catch(() => null);
      const gitlink = object
        ? null
        : await git(worktree, ["-C", path, "rev-parse", "HEAD"]).catch(() => null);
      hashes.push(`${path}:${object?.stdout.trim() ?? gitlink?.stdout.trim() ?? "missing"}`);
    }
    return JSON.stringify({ head, status, hashes });
  }
  if (action === "commit") {
    const index = (await git(worktree, ["diff-index", "--cached", "--raw", "HEAD"])).stdout;
    return JSON.stringify({ head, index });
  }
  const remoteUrl = remote
    ? (await git(worktree, ["remote", "get-url", "--push", remote])).stdout.trim()
    : null;
  let remoteHead: string | null = null;
  if (action === "pull_request" && remote) {
    const branch = (await git(worktree, ["branch", "--show-current"])).stdout.trim();
    remoteHead = (await git(worktree, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]))
      .stdout.trim().split(/\s+/)[0] || null;
    if (!remoteHead) {
      throw new RepositoryError("Push the reviewed branch before opening a pull request.", 409);
    }
    if (remoteHead !== head) {
      throw new RepositoryError("Push the reviewed HEAD before opening a pull request.", 409);
    }
  }
  return JSON.stringify({ head, remoteUrl, remoteHead });
}

function remoteDestination(url: string): string {
  const withoutSuffix = url.replace(/[?#].*$/, "").replace(/\.git$/, "");
  if (withoutSuffix.includes("://")) {
    try {
      const parsed = new URL(withoutSuffix);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      return "[configured remote]";
    }
  }
  return withoutSuffix.replace(/^([^@]+)@([^:]+):/, "$2/");
}

export function sanitizeDiagnostic(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (url) => remoteDestination(url))
    .replace(/\b((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(?:gh[opsu]_|github_pat_|sk-)[a-zA-Z0-9_-]+\b/g, "[redacted]");
}

function githubRepository(url: string): string | null {
  const withoutSuffix = url.replace(/[?#].*$/, "").replace(/\.git$/, "");
  if (withoutSuffix.includes("://")) {
    try {
      const parsed = new URL(withoutSuffix);
      return parsed.hostname.toLowerCase() === "github.com"
        ? parsed.pathname.replace(/^\/+/, "")
        : null;
    } catch {
      return null;
    }
  }
  const scp = withoutSuffix.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  return scp?.[1].toLowerCase() === "github.com" ? scp[2].replace(/^\/+/, "") : null;
}

function assertText(value: unknown, name: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new RepositoryError(`${name} is required and must be shorter than ${max} characters.`);
  }
  return value.trim();
}

function assertPath(path: unknown): string {
  if (typeof path !== "string" || !path.length || path.length > 1_024 || path.includes("\0")) {
    throw new RepositoryError("A changed file is required and must be shorter than 1024 characters.");
  }
  if (path === "." || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new RepositoryError("Staged paths must stay inside the selected worktree.", 403);
  }
  return path;
}

export async function inspectDelivery(repository: string, worktree: string): Promise<DeliveryContext> {
  const [branchResult, upstreamResult, remotesResult, statusResult] = await Promise.all([
    git(worktree, ["branch", "--show-current"]),
    git(worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => null),
    git(worktree, ["remote", "-v"]),
    git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const branch = branchResult.stdout.trim() || null;
  const remoteMap = new Map<string, string>();
  for (const line of remotesResult.stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(push\)$/);
    if (match) remoteMap.set(match[1], match[2]);
  }
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const fields = statusResult.stdout.split("\0");
  for (let position = 0; position < fields.length; position += 1) {
    const field = fields[position];
    if (!field) continue;
    const index = field[0];
    const worktreeState = field[1];
    const path = field.slice(3);
    if (index !== " " && index !== "?") staged.add(path);
    if (worktreeState !== " " || index === "?") unstaged.add(path);
    if (index === "R" || index === "C" || worktreeState === "R" || worktreeState === "C") {
      const previousPath = fields[++position];
      if (previousPath) {
        if (index !== " ") staged.add(previousPath);
        if (worktreeState !== " ") unstaged.add(previousPath);
      }
    }
  }
  return {
    repository,
    worktree,
    branch,
    detached: branch === null,
    upstream: upstreamResult?.stdout.trim() || null,
    remotes: [...remoteMap].map(([name, url]) => ({ name, url: remoteDestination(url) })),
    staged: [...staged].sort(),
    unstaged: [...unstaged].sort(),
  };
}

export class DeliveryBroker {
  readonly #plans = new Map<string, PendingPlan>();

  async plan(
    repository: string,
    worktree: string,
    action: DeliveryAction,
    input: Record<string, unknown>,
  ): Promise<DeliveryPlan> {
    const now = Date.now();
    for (const [id, pending] of this.#plans) {
      if (pending.used || Date.parse(pending.expiresAt) <= now) this.#plans.delete(id);
    }
    const context = await inspectDelivery(repository, worktree);
    if (!context.branch) {
      throw new RepositoryError("Detached HEAD cannot be delivered. Create or select a branch first.", 409);
    }
    if (action !== "stage" && PROTECTED_BRANCHES.has(context.branch)) {
      throw new RepositoryError(`Direct ${action.replace("_", " ")} on protected branch ${context.branch} is not allowed.`, 409);
    }

    let args: string[];
    let summary: string;
    let remote: string | null = null;
    let destination: string | null = null;
    let details: string[];
    if (action === "stage") {
      const paths = Array.isArray(input.paths) ? [...new Set(input.paths.map(assertPath))] : [];
      if (!paths.length) throw new RepositoryError("Select at least one changed file to stage.");
      const known = new Set([...context.staged, ...context.unstaged]);
      if (paths.some((path) => !known.has(path))) {
        throw new RepositoryError("Only currently changed files can be staged.", 409);
      }
      args = ["add", "--", ...paths];
      summary = `Stage ${paths.length} selected ${paths.length === 1 ? "file" : "files"}`;
      details = paths;
    } else if (action === "commit") {
      const message = assertText(input.message, "A commit message", 240);
      if (!context.staged.length) throw new RepositoryError("Stage reviewed changes before committing.", 409);
      const mixed = context.staged.filter((path) => context.unstaged.includes(path));
      if (mixed.length) {
        throw new RepositoryError(
          `Commit review requires staged files without additional unstaged edits: ${mixed.join(", ")}.`,
          409,
        );
      }
      args = ["commit", "-m", message];
      summary = "Create one commit from staged changes";
      details = [`message: ${message}`, ...context.staged.map((path) => `staged: ${path}`)];
    } else if (action === "push") {
      remote = assertText(input.remote, "A remote", 120);
      const selected = context.remotes.find((item) => item.name === remote);
      if (!selected) throw new RepositoryError("Select a configured push remote.", 409);
      destination = selected.url;
      args = ["push", "--set-upstream", remote, context.branch];
      summary = `Push branch ${context.branch}`;
      details = [`remote: ${remote}`, `destination: ${destination}`, "force: disabled"];
    } else {
      remote = assertText(input.remote, "A remote", 120);
      const selected = context.remotes.find((item) => item.name === remote);
      if (!selected) throw new RepositoryError("Select a configured destination remote.", 409);
      const base = assertText(input.base, "A base branch", 240);
      const title = assertText(input.title, "A pull request title", 240);
      const body = assertText(input.body, "A pull request body", 20_000);
      const rawRemote = (await git(worktree, ["remote", "get-url", "--push", remote])).stdout.trim();
      const repositoryName = githubRepository(rawRemote);
      if (!repositoryName) throw new RepositoryError("Pull-request creation currently requires a GitHub remote.", 409);
      destination = selected.url;
      args = ["pr", "create", "--repo", repositoryName, "--base", base, "--head", context.branch, "--title", title, "--body", body];
      summary = `Open pull request from ${context.branch} to ${base}`;
      details = [`destination: ${destination}`, `head: ${context.branch}`, `base: ${base}`, `title: ${title}`, `body: ${body}`];
    }
    const stateBinding = await fingerprint(
      worktree,
      action,
      action === "stage" ? args.slice(2) : [],
      remote,
    );
    const plan: PendingPlan = {
      id: randomUUID(),
      action,
      summary,
      repository,
      worktree,
      branch: context.branch,
      remote,
      destination,
      details,
      args,
      stateBinding,
      used: false,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    };
    this.#plans.set(plan.id, plan);
    const { args: _args, stateBinding: _stateBinding, used: _used, ...snapshot } = plan;
    return snapshot;
  }

  async execute(id: string, repository: string, worktree: string): Promise<{ status: string; output: string }> {
    const plan = this.#plans.get(id);
    if (!plan) throw new RepositoryError("The delivery approval does not exist.", 404);
    if (plan.used || Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(id);
      throw new RepositoryError("The delivery approval is expired or already used.", 409);
    }
    if (plan.repository !== repository || plan.worktree !== worktree) {
      throw new RepositoryError("The delivery approval is bound to another repository or worktree.", 403);
    }
    plan.used = true;
    this.#plans.delete(id);
    const context = await inspectDelivery(repository, worktree);
    if (context.branch !== plan.branch) {
      this.#plans.delete(id);
      throw new RepositoryError("The selected branch changed after review. Inspect the action again.", 409);
    }
    const currentBinding = await fingerprint(
      worktree,
      plan.action,
      plan.action === "stage" ? plan.args.slice(2) : [],
      plan.remote,
    );
    if (currentBinding !== plan.stateBinding) {
      this.#plans.delete(id);
      throw new RepositoryError("The reviewed Git state or destination changed. Inspect the action again.", 409);
    }
    const result = plan.action === "pull_request"
      ? await run(worktree, "gh", plan.args, 30_000)
      : await git(worktree, plan.args);
    return { status: "completed", output: result.stdout.trim() };
  }
}
