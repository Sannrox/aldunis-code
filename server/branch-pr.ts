/**
 * Best-effort GitHub PR projection for a worktree branch (T3-inspired row status).
 * Soft-fails when gh is missing, unauthenticated, or no PR exists.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

const CACHE_TTL_MS = 45_000;
const MAX_BATCH = 24;
const cache = new Map<string, { at: number; value: BranchPrLookupResult }>();

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

async function gitShowCurrentBranch(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function ghPrViewJson(worktree: string): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", "--json", "number,title,state,url"],
      {
        cwd: worktree,
        encoding: "utf8",
        timeout: 12_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export async function inspectBranchPr(worktree: string): Promise<BranchPrLookupResult> {
  const now = Date.now();
  const cached = cache.get(worktree);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const branch = await gitShowCurrentBranch(worktree);
  if (!branch) {
    const value: BranchPrLookupResult = { worktree, branch: null, pr: null };
    cache.set(worktree, { at: now, value });
    return value;
  }

  const payload = await ghPrViewJson(worktree);
  const pr = payload ? parseBranchPrPayload(worktree, branch, payload) : null;
  const value: BranchPrLookupResult = { worktree, branch, pr };
  cache.set(worktree, { at: now, value });
  return value;
}

export async function inspectBranchPrBatch(worktrees: string[]): Promise<BranchPrLookupResult[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const worktree of worktrees) {
    if (typeof worktree !== "string" || !worktree || worktree.includes("\0")) continue;
    if (seen.has(worktree)) continue;
    seen.add(worktree);
    unique.push(worktree);
    if (unique.length >= MAX_BATCH) break;
  }
  return Promise.all(unique.map((worktree) => inspectBranchPr(worktree)));
}

/** Test helper: drop cache between cases. */
export function clearBranchPrCache(): void {
  cache.clear();
}

export const BRANCH_PR_BATCH_LIMIT = MAX_BATCH;
