# Conversation lifecycle concepts

Status: Keep current

Source: [Issue #365](https://github.com/Sannrox/aldunis-code/issues/365)

Scope: Pin, archive, settle, unsettle, and managed-worktree release

## Decision

Keep pin, archive, settle, and managed-worktree release as independent
operations and independent authorities.

They answer different questions:

| Concept          | Question                                                                     | Owner                             | Durable effect                                       |
| ---------------- | ---------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| Pin              | Should this conversation sort prominently?                                   | Conversation history              | `Thread.pinnedAt`                                    |
| Archive          | Should this conversation leave the ordinary active-history view?             | Conversation history              | `Thread.archivedAt`                                  |
| Settle           | Has the operator finished attending to this conversation for now?            | Conversation history              | `Thread.settledAt`                                   |
| Snooze           | Should this conversation leave the ordinary inbox until a chosen wake time?  | Conversation history              | `Thread.snoozedUntil` + `Thread.snoozedAt`           |
| Release worktree | Should this Aldunis-owned checkout stop consuming local filesystem capacity? | Managed-worktree registry and Git | Registry removal intent/result plus checkout removal |

Unsettle is the inverse transition for settle, not a fifth concept.
Unsnooze is the inverse transition for snooze (timer wake is derived, not
a separate write). Restore is the inverse transition for archive.

Snooze is visibility-only and orthogonal to archive and worktree release.
Presentation treats settle and snooze as mutually exclusive: snoozing
clears `settledAt`, and settling clears snooze fields. Pending approval or
awaiting input cannot be snoozed and override an active snooze so the
operator is never asked in the dark.

The application may continue to offer the compound **Settle and release
worktree** action, but it must remain an explicit composition of two operations.
It is not an atomic lifecycle state.

No persistence-schema change is justified by this investigation. One focused
implementation issue is required: make an interrupted managed-worktree registry
finalization explicitly retryable.

## Current persisted model

Conversation history is reconstructed from append-only `thread_saved` events.
Pin, archive, and settle update nullable timestamps on the thread and bump
`updatedAt`. Existing version-one history is already migrated by treating
missing lifecycle timestamps as `null`.

Worktree ownership is persisted separately from conversation history. Release
uses the managed-worktree registry's recoverable removal protocol:

1. record `removalPendingAt`;
2. run `git worktree remove` without force;
3. record `removedAt` and clear the pending marker.

If the final registry write fails after Git removes the checkout, the pending
record no longer counts against the worktree limit. Repeating Release is an
explicit, idempotent recovery: it finalizes the record only when the registered
path is absent, Git has no worktree for the owned branch, and the registry has
one unambiguous ownership record. A replaced path or moved checkout is
preserved and reported instead. Conversation deletion, retention, archive, and
settle never remove a worktree.

## Presentation and behavior

| Operation | Primary presentation effect                                                     | Other behavior                                                                                     |
| --------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pin       | Orders the conversation ahead of ordinary peers in its current group            | Does not change visibility, completion, history, checkpoints, or worktrees                         |
| Archive   | Moves the conversation from Active to the Archived filter                       | Preserves pin, settle, history, checkpoints, provider binding, and worktree                        |
| Restore   | Clears archived presentation                                                    | Preserves pin, settle, history, checkpoints, and worktree                                          |
| Settle    | Moves an unarchived conversation to the reversible Settled shelf                | Suppresses attention grouping; preserves history, checkpoints, and worktree                        |
| Unsettle  | Returns the conversation to ordinary active grouping                            | Preserves archive, pin, history, checkpoints, and worktree                                         |
| Release   | Removes only a clean Aldunis-owned checkout and frees one managed-worktree slot | Preserves conversation history, branch, commits, remote, provider binding, and checkpoint metadata |

Archive and settle both reduce ordinary sidebar prominence, but they express
different intent. Archive is a visibility filter over retained history.
Settle is reversible completion and drives a dedicated shelf with worktree
capacity and release actions. Settle therefore has behavior independent of
both archive and release.

## Valid transitions

Pin, archive, and settle are orthogonal nullable timestamps. The state layer
allows all eight combinations:

| Archived | Settled | Pinned | Meaning                                                |
| -------- | ------- | ------ | ------------------------------------------------------ |
| No       | No      | No/Yes | Ordinary active conversation, optionally prominent     |
| No       | Yes     | No/Yes | Completed-for-now conversation on the Settled shelf    |
| Yes      | No      | No/Yes | Retained history hidden behind the Archived filter     |
| Yes      | Yes     | No/Yes | Archived retained history that is also marked complete |

The normal UI does not offer Settle while viewing Archived conversations, but
the persisted model does not make archive and settle mutually exclusive.
Preserving that compatibility avoids rewriting existing event history and keeps
restore/unsettle independently reversible.

Release is not another thread-state bit. For the conversation's bound path the
managed registry can be:

- user-created or never managed;
- active and available;
- active but moved, missing, or inaccessible;
- removal pending;
- removed.

The conversation retains its canonical worktree binding after release. That
binding is historical identity, not a claim that the checkout still exists.
A future provider turn must therefore fail visibly until the path is restored
or work continues in a new conversation; it must not silently rebind history.

### Transition guards

- Pin and unpin are permitted during active turns because they change ordering
  only.
- Unsettle is idempotent and does not touch provider execution or the
  filesystem. Restore is state-repeatable but currently appends a new
  `thread_saved` event and updates ordering even when already restored.
- Archive, settle, conversation deletion, and worktree release reject active,
  running, waiting-for-input, and waiting-for-approval turns.
- Worktree release additionally requires explicit confirmation, Aldunis
  ownership, matching branch identity, no Git lock, and a clean removable
  checkout. It never uses force and never deletes the branch.
- Conversation deletion has a separate preview and confirmation. It compacts
  conversation-owned local records but explicitly excludes the repository,
  worktree, branch, credentials, and remote content.

## Recovery cases

| Case                                                                      | Required outcome                                                                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active provider turn                                                      | Archive, settle, delete, and release return a retryable conflict; pin remains presentation-only                                                                               |
| Missing managed worktree                                                  | Release marks the ownership record removed and succeeds; it currently does not first prove the checkout was not moved                                                         |
| User-created or already released worktree                                 | Release reports no removal and does not claim ownership                                                                                                                       |
| Dirty, locked, or branch-mismatched checkout still at the registered path | Release fails without force or hidden cleanup                                                                                                                                 |
| Managed checkout moved away from its registered path                      | Current release treats the old path as missing, drops the active ownership record, and can leave the moved checkout intact; the recovery follow-up must close this gap        |
| Git removal fails                                                         | The registry rolls back the pending marker where possible; files and history remain inspectable                                                                               |
| Registry finalization fails after Git removal                             | Pending-removal state remains and no longer consumes the active limit, but no startup or operator retry currently finalizes it; the follow-up issue must add bounded recovery |
| Combined settle then release fails                                        | Settle remains recorded; the Settled shelf continues to show the held worktree and offers Release again                                                                       |
| Retained conversation                                                     | Pin/archive/settle do not affect the 200-conversation retention count                                                                                                         |
| Checkpoint cleanup                                                        | Conversation deletion, project deletion, and retention own checkpoint-ref cleanup; settle/archive/release do not                                                              |
| Project deletion                                                          | Active checkpoint work blocks deletion; cleanup intent is persisted before refs and project records are removed; worktrees are not implicitly removed                         |

The partial result of the combined action is important: settling is safe to
commit before destructive filesystem cleanup because a failed release remains
visible and retryable. Making the combination atomic would require rollback of
conversation history after a filesystem failure, or would conceal a checkout
that still exists.

## Complexity assessment

| Measure                                     |                                      Current independent model |                                            Collapsed lifecycle proposal |
| ------------------------------------------- | -------------------------------------------------------------: | ----------------------------------------------------------------------: |
| User-facing concepts                        |                                                              4 |                                                               At best 3 |
| Thread timestamp fields                     |                                                              3 |                                                               At best 2 |
| Conversation lifecycle routes               | 6 (`pin`, `archive`, `restore`, `settle`, `unsettle`, release) |                                                               At best 4 |
| Filesystem removal routes                   |                                                              1 |                     Still 1; confirmation and recovery cannot disappear |
| Managed registry states                     |                                                      Unchanged |                                                               Unchanged |
| Partial-success branch for settle + release |                                         Explicit and retryable | Still exists, but must be hidden, rolled back, or represented elsewhere |
| Existing history migration                  |                                                           None |                 Required for any removed timestamp or changed semantics |

The maximum apparent reduction is one concept, one timestamp, and two inverse
routes. It does not remove the filesystem confirmation, Git validation,
managed-registry recovery, archived-history filter, or reversible completion
need. Instead it displaces complexity into compound transitions, rollback,
migration, and ambiguous partial-success presentation.

Integrating archive with settle would also lose the distinction between “hide
retained history” and “finished for now.” Integrating settle with release would
make completion contingent on filesystem ownership and cleanliness, so
user-created worktrees and failed cleanup could not be settled. Integrating
archive with release would make a presentation choice destructive. None is a
safe simplification.

## Invariants

- Conversation history survives pin, archive, settle, restore, unsettle, and
  worktree release.
- Hiding history never grants filesystem mutation authority.
- Completion never requires or implies worktree removal.
- Worktree removal is always explicit, scoped, confirmed, clean-only, and
  recoverable.
- Checkpoint retention and cleanup remain independent of sidebar presentation.
- A conversation never silently changes its canonical worktree.
- Active and unresolved provider work cannot be hidden as complete or lose its
  checkout.
- Compound UI actions expose both effects and leave partial success visible.

## Verification basis

This decision is based on:

- `server/state.ts` lifecycle fields, transition guards, event persistence,
  deletion, retention, and project cleanup;
- `server/host.ts` route separation and active-turn checks;
- `server/worktrees.ts` ownership, clean-removal, idempotency, and
  pending-removal recovery;
- `src/features/code/conversation-list.ts` and
  `src/features/code/sidebar.tsx` grouping and worktree-capacity presentation;
- `src/features/code/conversation.tsx` explicit composition of Settle followed
  by Release;
- deterministic lifecycle, retention, checkpoint, and managed-worktree tests;
- the accepted
  [managed conversation worktrees](../decisions/managed-conversation-worktrees.md)
  boundary and [workspace checkpoint recovery](../workspace-checkpoints.md).

## Removal recovery

[Issue #406](https://github.com/Sannrox/aldunis-code/issues/406) added bounded
operator recovery through the existing Release action:

- reproduce a final registry-save failure after Git has removed the checkout;
- preserve the existing rule that pending removal does not consume the active
  worktree limit;
- finalize only a record whose registered path is absent and whose ownership
  identity remains unambiguous, including proving the checkout was not moved;
- repeated recovery is idempotent and never deletes a branch, conversation, or
  user-created worktree;
- cover repeated recovery, moved and replaced paths, malformed registry state,
  and concurrent worktree administration.

Recovery does not combine settle with release and requires no
conversation-history migration.
