# Managed conversation worktrees

Status: Accepted
Source: [Issue #26 maintainer direction](https://github.com/Sannrox/aldunis-code/issues/26#issuecomment-5061520662)

This record governs Aldunis-managed worktree coordination. The accepted
workspace-mode extension, including the capability-gated provider-native
option, is recorded in [Conversation workspace modes](conversation-workspace-modes.md).

## Decision

Aldunis Code owns worktree coordination as a typed local-host capability.
Providers never create, select, rebind, or remove conversation worktrees on
behalf of the workbench.

Creation follows a preview-and-approve flow:

1. Canonicalize the repository and target path.
2. Resolve the repository default branch to an exact commit from agreeing
   remote HEADs or a conventional local branch.
   New worktrees do not inherit the selected checkout's or parent conversation's
   current branch; ambiguous repositories fail closed at creation. The
   repository can still be opened for shared-workspace use while that default
   is unresolved.
3. Validate a clean index, attached HEAD, branch and path availability,
   submodule absence, and Git-operation locks. Unstaged and untracked changes
   remain in the source checkout and are not copied into the new worktree.
4. Render the repository, base name and commit, new branch, and target path.
5. After one scoped approval, revalidate the exact plan and execute
   `git worktree add` without a shell.
6. Persist Aldunis ownership separately from Git and bind the conversation to
   the resulting canonical worktree.

User-created worktrees remain selectable and are never reclassified as
Aldunis-owned. An existing conversation cannot change its canonical worktree.
Recovery reports Aldunis-owned worktrees as available, moved, missing, or
inaccessible.

Managed worktrees have an installation-wide configurable soft limit of ten by
default; unlimited is an explicit setting. Reaching the limit blocks creation.
Removal is always separately previewed and approved, applies only to a clean,
unused Aldunis-owned checkout, and uses `git worktree remove` without force.
It never deletes a branch, commit, remote, conversation, dirty file, or
user-created worktree.

Closing, deleting, or retaining conversation history never triggers worktree
removal. There is no automatic cleanup.

## Consequences

- Worktree behavior stays provider-independent. Provider setup, worktree
  coordination, and cleanup remain separate capabilities with separate
  authority and approval boundaries.
- A registry failure after Git creation leaves the checkout intact and reports
  that it must be treated as user-created; rollback never deletes user files.
- Moving an owned worktree outside Aldunis Code is detected through its branch
  identity, but the application does not silently rewrite its stored ownership
  path.
- Branch deletion, merging, force operations, remote repository creation, and
  setup-script execution remain out of scope.
