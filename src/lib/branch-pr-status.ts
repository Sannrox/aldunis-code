import type { BranchPrLookupResult, BranchPrStatus } from "../types";

export function prStatusLabel(pr: BranchPrStatus): string {
  if (pr.state === "open") return `PR #${pr.number}`;
  if (pr.state === "merged") return `Merged #${pr.number}`;
  return `Closed #${pr.number}`;
}

export function prStatusAriaLabel(pr: BranchPrStatus): string {
  return `${prStatusLabel(pr)}: ${pr.title}`;
}

/** Map batch results by worktree for O(1) row lookup. */
export function indexBranchPrResults(
  results: readonly BranchPrLookupResult[],
): Map<string, BranchPrStatus> {
  const map = new Map<string, BranchPrStatus>();
  for (const result of results) {
    if (result.pr) map.set(result.worktree, result.pr);
  }
  return map;
}

export const BRANCH_PR_CLIENT_BATCH_LIMIT = 24;
export const BRANCH_PR_INITIAL_REFRESH_DELAY_MS = 250;
export const BRANCH_PR_REFRESH_INTERVAL_MS = 60_000;

type BranchPrStatusRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadBranchPrLookupResults(
  items: ReadonlyArray<{ root: string; worktree: string }>,
  signal: AbortSignal,
  request: BranchPrStatusRequest = globalThis.fetch,
): Promise<BranchPrLookupResult[]> {
  const results: BranchPrLookupResult[] = [];
  for (const batch of chunkWorktreeRoots(items, BRANCH_PR_CLIENT_BATCH_LIMIT)) {
    signal.throwIfAborted();
    const response = await request("/api/delivery/pr-status/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: batch }),
      signal,
    });
    if (!response.ok) continue;
    const body = (await response.json()) as {
      results?: BranchPrLookupResult[];
      error?: string;
    };
    if (Array.isArray(body.results)) results.push(...body.results);
  }
  signal.throwIfAborted();
  return results;
}

interface PollingVisibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface PollingTimers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(handle: number): void;
}

const browserPollingTimers: PollingTimers = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => window.clearTimeout(handle),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (handle) => window.clearInterval(handle),
};

/**
 * Poll PR chrome only while it can be seen. A visibility refresh or interval
 * tick never starts a second Git/GitHub inspection while one is in flight.
 */
export function startBranchPrStatusPolling(
  refresh: (signal: AbortSignal) => Promise<void>,
  visibility: PollingVisibility,
  timers: PollingTimers = browserPollingTimers,
): () => void {
  let initialRefresh: number | undefined;
  let interval: number | undefined;
  let inFlight = false;
  let refreshAfterFlight = false;
  let disposed = false;
  let activeController: AbortController | undefined;

  const stopTimers = () => {
    if (initialRefresh !== undefined) timers.clearTimeout(initialRefresh);
    if (interval !== undefined) timers.clearInterval(interval);
    initialRefresh = undefined;
    interval = undefined;
  };
  const run = async (queueIfBusy = false) => {
    if (disposed || visibility.visibilityState !== "visible") return;
    if (inFlight) {
      if (queueIfBusy) refreshAfterFlight = true;
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      await refresh(controller.signal);
    } finally {
      if (activeController === controller) activeController = undefined;
      inFlight = false;
      if (refreshAfterFlight) {
        refreshAfterFlight = false;
        void run();
      }
    }
  };
  const start = (immediate: boolean) => {
    stopTimers();
    activeController?.abort();
    if (disposed || visibility.visibilityState !== "visible") {
      refreshAfterFlight = false;
      return;
    }
    if (immediate) void run(true);
    else initialRefresh = timers.setTimeout(() => void run(), BRANCH_PR_INITIAL_REFRESH_DELAY_MS);
    interval = timers.setInterval(() => void run(), BRANCH_PR_REFRESH_INTERVAL_MS);
  };
  const onVisibilityChange = () => start(true);

  start(false);
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    disposed = true;
    stopTimers();
    activeController?.abort();
    activeController = undefined;
    refreshAfterFlight = false;
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export function uniqueWorktreeRoots(
  items: ReadonlyArray<{ worktree: string; root: string }>,
  limit = BRANCH_PR_CLIENT_BATCH_LIMIT,
): Array<{ root: string; worktree: string }> {
  const seen = new Set<string>();
  const unique: Array<{ root: string; worktree: string }> = [];
  for (const item of items) {
    if (!item.worktree || !item.root || seen.has(item.worktree)) continue;
    seen.add(item.worktree);
    unique.push({ root: item.root, worktree: item.worktree });
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Split a worktree list into server-bounded batches. */
export function chunkWorktreeRoots<T>(
  items: readonly T[],
  size = BRANCH_PR_CLIENT_BATCH_LIMIT,
): T[][] {
  if (size <= 0) return [items.slice()];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
