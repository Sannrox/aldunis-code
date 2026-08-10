/**
 * Resolve a "previous worktree" seed for shared-checkout reuse (T3-inspired).
 * Picks the most recently updated conversation worktree in the project that
 * is not the current selection and is not archived. Only the shared workspace
 * path should surface this seed — managed create uses a base-branch dialog.
 */

export interface PreviousWorktreeSeedInput {
  conversations: ReadonlyArray<{
    projectId: string;
    worktree: string;
    updatedAt: string;
    archivedAt?: string | null;
  }>;
  projectId: string | null | undefined;
  currentWorktreePath: string | null | undefined;
}

export interface PreviousWorktreeSeed {
  worktreePath: string;
  updatedAt: string;
}

export function resolvePreviousWorktreeSeed(
  input: PreviousWorktreeSeedInput,
): PreviousWorktreeSeed | null {
  const projectId = input.projectId?.trim();
  if (!projectId) return null;
  const current = input.currentWorktreePath?.trim() || null;

  let latest: PreviousWorktreeSeed | null = null;
  for (const conversation of input.conversations) {
    if (conversation.projectId !== projectId) continue;
    if (conversation.archivedAt) continue;
    const path = conversation.worktree?.trim();
    if (!path || path === current) continue;
    if (!latest || conversation.updatedAt > latest.updatedAt) {
      latest = { worktreePath: path, updatedAt: conversation.updatedAt };
    }
  }
  return latest;
}
