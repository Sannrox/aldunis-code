/**
 * Resolve selectable starting branches for managed worktree creation.
 * Prefers the repository default when present, then any known local heads.
 */

export interface WorktreeBaseSource {
  defaultBranch?: string | null;
  localBranches?: readonly string[] | null;
  worktrees?: ReadonlyArray<{ branch?: string | null }>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

/** Local branch names the operator can start a new worktree from. */
export function worktreeBaseBranchOptions(source: WorktreeBaseSource): string[] {
  const names: string[] = [];
  for (const branch of source.localBranches ?? []) names.push(branch);
  for (const worktree of source.worktrees ?? []) {
    if (worktree.branch) names.push(worktree.branch);
  }
  if (source.defaultBranch) names.push(source.defaultBranch);
  return uniqueSorted(names);
}

/** Default "start from" selection for create forms. */
export function defaultWorktreeBase(source: WorktreeBaseSource): string {
  const defaultBranch = source.defaultBranch?.trim();
  if (defaultBranch) return defaultBranch;
  return worktreeBaseBranchOptions(source)[0] ?? "";
}
