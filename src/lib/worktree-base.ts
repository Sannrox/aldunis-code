/**
 * Resolve selectable starting branches for managed worktree creation.
 * Prefers the repository default when present, then any known local heads.
 */

export interface WorktreeBaseSource {
  defaultBranch?: string | null;
  localBranches?: readonly string[] | null;
  localBranchesTruncated?: boolean;
  worktrees?: ReadonlyArray<{ branch?: string | null }>;
}

export const MAX_WORKTREE_BASE_SUGGESTIONS = 256;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

/** Local branch names the operator can start a new worktree from. */
export function worktreeBaseBranchOptions(source: WorktreeBaseSource): string[] {
  const activeBranches: string[] = [];
  for (const worktree of source.worktrees ?? []) {
    if (worktree.branch) activeBranches.push(worktree.branch);
  }
  const names = source.defaultBranch ? [source.defaultBranch.trim()] : [];
  for (const branch of uniqueSorted(activeBranches)) {
    if (!names.includes(branch) && names.length < MAX_WORKTREE_BASE_SUGGESTIONS) names.push(branch);
  }
  for (const branch of uniqueSorted(source.localBranches ?? [])) {
    if (!names.includes(branch) && names.length < MAX_WORKTREE_BASE_SUGGESTIONS) {
      names.push(branch);
    }
  }
  return uniqueSorted(names);
}

/** Default "start from" selection for create forms. */
export function defaultWorktreeBase(source: WorktreeBaseSource): string {
  const defaultBranch = source.defaultBranch?.trim();
  if (defaultBranch) return defaultBranch;
  return worktreeBaseBranchOptions(source)[0] ?? "";
}
