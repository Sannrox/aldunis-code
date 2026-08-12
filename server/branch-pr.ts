/**
 * Best-effort GitHub PR projection for a worktree branch (T3-inspired row status).
 * Soft-fails when gh is missing, unauthenticated, or no PR exists.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface BranchPrExecOptions {
  cwd: string;
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type BranchPrExec = (
  command: string,
  args: string[],
  options: BranchPrExecOptions,
) => Promise<{ stdout: string }>;

const defaultBranchPrExec: BranchPrExec = (command, args, options) =>
  execFileAsync(command, args, options);

export type BranchPrState = "open" | "merged" | "closed";

export interface BranchPrStatus {
  worktree: string;
  branch: string;
  number: number;
  title: string;
  state: BranchPrState;
  url: string;
}

export interface BranchPrLookupResult {
  worktree: string;
  branch: string | null;
  pr: BranchPrStatus | null;
}

const MAX_BATCH = 24;
export const BRANCH_PR_BATCH_CONCURRENCY = 4;
export const BRANCH_PR_CACHE_TTL_MS = 45_000;
export const BRANCH_PR_CACHE_LIMIT = MAX_BATCH * 4;

export class BranchPrResultCache {
  readonly #entries = new Map<string, { at: number; value: BranchPrLookupResult }>();

  constructor(
    readonly limit = BRANCH_PR_CACHE_LIMIT,
    readonly ttlMs = BRANCH_PR_CACHE_TTL_MS,
  ) {}

  #purgeExpired(now: number): void {
    for (const [worktree, entry] of this.#entries) {
      if (now - entry.at >= this.ttlMs) this.#entries.delete(worktree);
    }
  }

  get(worktree: string, now = Date.now()): BranchPrLookupResult | null {
    this.#purgeExpired(now);
    const entry = this.#entries.get(worktree);
    if (!entry) return null;
    this.#entries.delete(worktree);
    this.#entries.set(worktree, entry);
    return entry.value;
  }

  set(worktree: string, value: BranchPrLookupResult, now = Date.now()): void {
    this.#purgeExpired(now);
    this.#entries.delete(worktree);
    this.#entries.set(worktree, { at: now, value });
    while (this.#entries.size > this.limit) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

const cache = new BranchPrResultCache();

function finitePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (!Number.isInteger(value)) return null;
  return value;
}

export function normalizeBranchPrState(value: unknown): BranchPrState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "open") return "open";
  if (normalized === "merged") return "merged";
  if (normalized === "closed") return "closed";
  return null;
}

export function parseBranchPrPayload(
  worktree: string,
  branch: string,
  payload: unknown,
): BranchPrStatus | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const number = finitePositiveInt(record.number);
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const state = normalizeBranchPrState(record.state);
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (number === null || !title || !state || !url) return null;
  if (!/^https:\/\//i.test(url)) return null;
  return { worktree, branch, number, title, state, url };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError"),
  );
}

async function gitShowCurrentBranch(
  worktree: string,
  signal?: AbortSignal,
  execute: BranchPrExec = defaultBranchPrExec,
): Promise<string | null> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execute("git", ["branch", "--show-current"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      signal,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return null;
  }
}

async function ghPrViewJson(
  worktree: string,
  signal?: AbortSignal,
  execute: BranchPrExec = defaultBranchPrExec,
): Promise<unknown | null> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execute("gh", ["pr", "view", "--json", "number,title,state,url"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 12_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      signal,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    if (isCancellation(error, signal)) throw error;
    return null;
  }
}

export async function inspectBranchPr(
  worktree: string,
  signal?: AbortSignal,
  execute: BranchPrExec = defaultBranchPrExec,
): Promise<BranchPrLookupResult> {
  throwIfAborted(signal);
  const now = Date.now();
  const cached = cache.get(worktree, now);
  if (cached) return cached;

  const branch = await gitShowCurrentBranch(worktree, signal, execute);
  if (!branch) {
    const value: BranchPrLookupResult = { worktree, branch: null, pr: null };
    cache.set(worktree, value, now);
    return value;
  }

  const payload = await ghPrViewJson(worktree, signal, execute);
  const pr = payload ? parseBranchPrPayload(worktree, branch, payload) : null;
  const value: BranchPrLookupResult = { worktree, branch, pr };
  cache.set(worktree, value, now);
  return value;
}

export async function inspectBranchPrBatch(
  worktrees: string[],
  signal?: AbortSignal,
  execute: BranchPrExec = defaultBranchPrExec,
): Promise<BranchPrLookupResult[]> {
  throwIfAborted(signal);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const worktree of worktrees) {
    if (typeof worktree !== "string" || !worktree || worktree.includes("\0")) continue;
    if (seen.has(worktree)) continue;
    seen.add(worktree);
    unique.push(worktree);
    if (unique.length >= MAX_BATCH) break;
  }
  const results = new Array<BranchPrLookupResult>(unique.length);
  let nextIndex = 0;
  const inspectNext = async (): Promise<void> => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= unique.length) return;
      results[index] = await inspectBranchPr(unique[index], signal, execute);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(BRANCH_PR_BATCH_CONCURRENCY, unique.length) }, () =>
      inspectNext(),
    ),
  );
  return results;
}

/** Test helper: drop cache between cases. */
export function clearBranchPrCache(): void {
  cache.clear();
}

export const BRANCH_PR_BATCH_LIMIT = MAX_BATCH;
