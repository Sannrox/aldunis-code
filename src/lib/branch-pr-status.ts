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
