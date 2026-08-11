/**
 * Extract the primitive identity used by renderer effects that inspect a
 * repository worktree. Equivalent projection objects intentionally collapse
 * to the same React dependency values.
 */
export function conversationResourceTarget(
  repository: { root: string } | null,
  worktree: { path: string } | null,
): readonly [root: string | null, worktree: string | null] {
  return [repository?.root ?? null, worktree?.path ?? null];
}
