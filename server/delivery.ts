import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { MAX_PENDING_APPROVAL_PLANS, retainBoundedPendingPlan } from "./pending-plan-retention.ts";
import { RepositoryError } from "./repository.ts";
import type { PullRequestDraft } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const PLAN_TTL_MS = 5 * 60_000;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const MAX_DRAFT_PATHS = 40;
export const MAX_DELIVERY_CHANGED_PATHS = 256;
const MAX_DELIVERY_STATUS_RECORD_BYTES = 64 * 1024;
const MAX_DELIVERY_STATUS_STDERR_BYTES = 64 * 1024;
const DELIVERY_STATUS_TIMEOUT_MS = 15_000;

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
  stagedCount: number;
  unstagedCount: number;
  changedCount: number;
  truncated: boolean;
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

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function retainDeliveryPath(paths: string[], path: string): void {
  if (path.length > 1_024 || paths.includes(path)) return;
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (comparePaths(paths[middle]!, path) < 0) low = middle + 1;
    else high = middle;
  }
  if (paths.length >= MAX_DELIVERY_CHANGED_PATHS && low >= paths.length) return;
  paths.splice(low, 0, path);
  if (paths.length > MAX_DELIVERY_CHANGED_PATHS) paths.pop();
}

interface DeliveryStatusProjection {
  staged: string[];
  unstaged: string[];
  stagedCount: number;
  unstagedCount: number;
  changedCount: number;
}

async function readDeliveryStatus(worktree: string): Promise<DeliveryStatusProjection> {
  const child = spawn(
    "git",
    ["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_LITERAL_PATHSPECS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  const exit = new Promise<{ code: number | null; childSignal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, childSignal) => resolveExit({ code, childSignal }));
    },
  );
  const projection: DeliveryStatusProjection = {
    staged: [],
    unstaged: [],
    stagedCount: 0,
    unstagedCount: 0,
    changedCount: 0,
  };
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let pending = Buffer.alloc(0);
  let renameState: { staged: boolean; unstaged: boolean } | null = null;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    escalation.unref?.();
  };
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_DELIVERY_STATUS_STDERR_BYTES) return;
    const retained = chunk.subarray(0, MAX_DELIVERY_STATUS_STDERR_BYTES - stderrBytes);
    stderr.push(Buffer.from(retained));
    stderrBytes += retained.length;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, DELIVERY_STATUS_TIMEOUT_MS);
  timeout.unref?.();
  const retain = (path: string, staged: boolean, unstaged: boolean) => {
    projection.changedCount += 1;
    if (staged) {
      projection.stagedCount += 1;
      retainDeliveryPath(projection.staged, path);
    }
    if (unstaged) {
      projection.unstagedCount += 1;
      retainDeliveryPath(projection.unstaged, path);
    }
  };
  const accept = (record: Buffer) => {
    if (record.length > MAX_DELIVERY_STATUS_RECORD_BYTES) {
      throw new RepositoryError("A delivery status record exceeded its resource limit.", 409);
    }
    if (renameState) {
      retain(record.toString("utf8"), renameState.staged, renameState.unstaged);
      renameState = null;
      return;
    }
    if (record.length < 3 || record[2] !== 32) {
      throw new RepositoryError("Git returned an invalid delivery status record.", 409);
    }
    const index = String.fromCharCode(record[0]!);
    const worktreeState = String.fromCharCode(record[1]!);
    const staged = index !== " " && index !== "?";
    const unstaged = worktreeState !== " " || index === "?";
    retain(record.subarray(3).toString("utf8"), staged, unstaged);
    if (index === "R" || index === "C" || worktreeState === "R" || worktreeState === "C") {
      renameState = { staged, unstaged };
    }
  };
  try {
    for await (const chunk of child.stdout) {
      const bytes = chunk as Buffer;
      const joined = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = joined.indexOf(0, start);
        if (end < 0) break;
        accept(joined.subarray(start, end));
        start = end + 1;
      }
      pending = Buffer.from(joined.subarray(start));
      if (pending.length > MAX_DELIVERY_STATUS_RECORD_BYTES) {
        throw new RepositoryError("A delivery status record exceeded its resource limit.", 409);
      }
    }
    const completion = await exit;
    if (timedOut) throw new RepositoryError("Git did not finish inspecting delivery state.", 409);
    if (pending.length > 0 || renameState) {
      throw new RepositoryError("Git returned an incomplete delivery status inventory.", 409);
    }
    if (completion.code !== 0) {
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf8").trim();
      throw new RepositoryError(sanitizeDiagnostic(detail) || "The Git action failed.", 409);
    }
    return projection;
  } catch (error) {
    if (error instanceof RepositoryError) throw error;
    throw new RepositoryError("The Git action failed.", 409);
  } finally {
    clearTimeout(timeout);
    stop();
    await exit.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
  }
}

function statusPaths(status: string): Set<string> {
  const fields = status.split("\0");
  const paths = new Set<string>();
  for (let position = 0; position < fields.length; position += 1) {
    const field = fields[position];
    if (!field) continue;
    paths.add(field.slice(3));
    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") {
      const previousPath = fields[++position];
      if (previousPath) paths.add(previousPath);
    }
  }
  return paths;
}

function unstagedStatusPaths(status: string): Set<string> {
  const fields = status.split("\0");
  const paths = new Set<string>();
  for (let position = 0; position < fields.length; position += 1) {
    const field = fields[position];
    if (!field) continue;
    const unstaged = field[1] !== " " || field[0] === "?";
    if (unstaged) paths.add(field.slice(3));
    if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") {
      const previousPath = fields[++position];
      if (unstaged && previousPath) paths.add(previousPath);
    }
  }
  return paths;
}

async function mixedStagedPaths(worktree: string, staged: string[]): Promise<string[]> {
  const mixed = new Set<string>();
  for (let index = 0; index < staged.length; index += 50) {
    const batch = staged.slice(index, index + 50);
    const status = (await git(worktree, ["status", "--porcelain=v1", "-z", "--", ...batch])).stdout;
    const unstaged = unstagedStatusPaths(status);
    for (const path of batch) {
      if (unstaged.has(path)) mixed.add(path);
    }
  }
  return [...mixed];
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
    const changed = statusPaths(status);
    if (paths.some((path) => !changed.has(path))) {
      throw new RepositoryError("Only currently changed files can be staged.", 409);
    }
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
    remoteHead =
      (await git(worktree, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])).stdout
        .trim()
        .split(/\s+/)[0] || null;
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
    throw new RepositoryError(
      "A changed file is required and must be shorter than 1024 characters.",
    );
  }
  if (path === "." || path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
    throw new RepositoryError("Staged paths must stay inside the selected worktree.", 403);
  }
  return path;
}

export async function inspectDelivery(
  repository: string,
  worktree: string,
): Promise<DeliveryContext> {
  const [branchResult, upstreamResult, remotesResult, status] = await Promise.all([
    git(worktree, ["branch", "--show-current"]),
    git(worktree, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(
      () => null,
    ),
    git(worktree, ["remote", "-v"]),
    readDeliveryStatus(worktree),
  ]);
  const branch = branchResult.stdout.trim() || null;
  const remoteMap = new Map<string, string>();
  for (const line of remotesResult.stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(push\)$/);
    if (match) remoteMap.set(match[1], match[2]);
  }
  return {
    repository,
    worktree,
    branch,
    detached: branch === null,
    upstream: upstreamResult?.stdout.trim() || null,
    remotes: [...remoteMap].map(([name, url]) => ({ name, url: remoteDestination(url) })),
    staged: status.staged,
    unstaged: status.unstaged,
    stagedCount: status.stagedCount,
    unstagedCount: status.unstagedCount,
    changedCount: status.changedCount,
    truncated:
      status.stagedCount > status.staged.length || status.unstagedCount > status.unstaged.length,
  };
}

function markdownCode(value: string): string {
  return value.replaceAll("`", "\\`");
}

function branchTitle(branch: string): string {
  const words = branch.split(/[/_-]+/).filter(Boolean);
  const withoutPrefix =
    words.length > 1 &&
    ["bugfix", "chore", "codex", "feature", "fix", "refactor", "research"].includes(
      words[0]!.toLocaleLowerCase(),
    )
      ? words.slice(1)
      : words;
  const label = withoutPrefix
    .map((word) => (/^\d+$/.test(word) ? word : `${word[0]!.toLocaleUpperCase()}${word.slice(1)}`))
    .join(" ")
    .trim();
  return label || "branch changes";
}

function boundedPath(path: string): string {
  const normalized = path.length > 240 ? `${path.slice(0, 237)}…` : path;
  return markdownCode(normalized);
}

export function pullRequestDraft(context: DeliveryContext, baseInput: unknown): PullRequestDraft {
  if (!context.branch) {
    throw new RepositoryError("Detached HEAD cannot produce a pull-request draft.", 409);
  }
  const base = assertText(baseInput, "A base branch", 240);
  const paths = [...new Set([...context.staged, ...context.unstaged])].sort();
  const changedFiles = paths.slice(0, MAX_DRAFT_PATHS);
  const omittedFiles = Math.max(0, context.changedCount - changedFiles.length);
  const title = `Update ${branchTitle(context.branch)}`.slice(0, 120).trim();
  const pathLines =
    changedFiles.length > 0
      ? changedFiles.map((path) => `- \`${boundedPath(path)}\``)
      : ["- No changed paths detected; inspect the branch before publishing."];
  if (omittedFiles > 0) {
    pathLines.push(`- …and ${omittedFiles} more changed path${omittedFiles === 1 ? "" : "s"}.`);
  }
  const body = [
    "## Summary",
    `- Prepare ${markdownCode(branchTitle(context.branch).toLocaleLowerCase())} for review.`,
    "",
    "## Review surface",
    `- Head: \`${markdownCode(context.branch)}\``,
    `- Base: \`${markdownCode(base)}\``,
    `- Changed paths: ${context.changedCount}`,
    "",
    "## Changed paths",
    ...pathLines,
  ]
    .join("\n")
    .slice(0, 12_000);
  return {
    title,
    body,
    branch: context.branch,
    base,
    changedFiles,
    omittedFiles,
  };
}

export async function draftPullRequest(
  repository: string,
  worktree: string,
  baseInput: unknown,
): Promise<PullRequestDraft> {
  return pullRequestDraft(await inspectDelivery(repository, worktree), baseInput);
}

export class DeliveryBroker {
  readonly #plans = new Map<string, PendingPlan>();

  constructor(private readonly maxRetainedPlans = MAX_PENDING_APPROVAL_PLANS) {}

  /** Test and diagnostics: unexpired approvals still retained in memory. */
  get retainedPlanCount(): number {
    return this.#plans.size;
  }

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
      throw new RepositoryError(
        "Detached HEAD cannot be delivered. Create or select a branch first.",
        409,
      );
    }
    if (action !== "stage" && PROTECTED_BRANCHES.has(context.branch)) {
      throw new RepositoryError(
        `Direct ${action.replace("_", " ")} on protected branch ${context.branch} is not allowed.`,
        409,
      );
    }

    let args: string[];
    let summary: string;
    let remote: string | null = null;
    let destination: string | null = null;
    let details: string[];
    if (action === "stage") {
      const paths = Array.isArray(input.paths) ? [...new Set(input.paths.map(assertPath))] : [];
      if (!paths.length) throw new RepositoryError("Select at least one changed file to stage.");
      args = ["add", "--", ...paths];
      summary = `Stage ${paths.length} selected ${paths.length === 1 ? "file" : "files"}`;
      details = paths;
    } else if (action === "commit") {
      const message = assertText(input.message, "A commit message", 240);
      if (context.stagedCount > context.staged.length) {
        throw new RepositoryError(
          `Commit review is limited to ${MAX_DELIVERY_CHANGED_PATHS} staged files. Split the commit before continuing.`,
          409,
        );
      }
      if (!context.staged.length)
        throw new RepositoryError("Stage reviewed changes before committing.", 409);
      const mixed = await mixedStagedPaths(worktree, context.staged);
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
      const rawRemote = (
        await git(worktree, ["remote", "get-url", "--push", remote])
      ).stdout.trim();
      const repositoryName = githubRepository(rawRemote);
      if (!repositoryName)
        throw new RepositoryError("Pull-request creation currently requires a GitHub remote.", 409);
      destination = selected.url;
      args = [
        "pr",
        "create",
        "--repo",
        repositoryName,
        "--base",
        base,
        "--head",
        context.branch,
        "--title",
        title,
        "--body",
        body,
      ];
      summary = `Open pull request from ${context.branch} to ${base}`;
      details = [
        `destination: ${destination}`,
        `head: ${context.branch}`,
        `base: ${base}`,
        `title: ${title}`,
        `body: ${body}`,
      ];
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
    retainBoundedPendingPlan(this.#plans, plan, Date.now(), this.maxRetainedPlans);
    const { args: _args, stateBinding: _stateBinding, used: _used, ...snapshot } = plan;
    return snapshot;
  }

  async execute(
    id: string,
    repository: string,
    worktree: string,
  ): Promise<{ status: string; output: string }> {
    const plan = this.#plans.get(id);
    if (!plan) throw new RepositoryError("The delivery approval does not exist.", 404);
    if (plan.used || Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(id);
      throw new RepositoryError("The delivery approval is expired or already used.", 409);
    }
    if (plan.repository !== repository || plan.worktree !== worktree) {
      throw new RepositoryError(
        "The delivery approval is bound to another repository or worktree.",
        403,
      );
    }
    plan.used = true;
    this.#plans.delete(id);
    const context = await inspectDelivery(repository, worktree);
    if (context.branch !== plan.branch) {
      this.#plans.delete(id);
      throw new RepositoryError(
        "The selected branch changed after review. Inspect the action again.",
        409,
      );
    }
    const currentBinding = await fingerprint(
      worktree,
      plan.action,
      plan.action === "stage" ? plan.args.slice(2) : [],
      plan.remote,
    );
    if (currentBinding !== plan.stateBinding) {
      this.#plans.delete(id);
      throw new RepositoryError(
        "The reviewed Git state or destination changed. Inspect the action again.",
        409,
      );
    }
    const result =
      plan.action === "pull_request"
        ? await run(worktree, "gh", plan.args, 30_000)
        : await git(worktree, plan.args);
    return { status: "completed", output: result.stdout.trim() };
  }
}
