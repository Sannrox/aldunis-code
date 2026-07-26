# Workspace checkpoints

Aldunis Code captures a Git tree identity before an agent turn and, when the
turn completes, another identity for the resulting workspace. The real Git
index identity is recorded separately, while a temporary index captures the
full file snapshot without changing staging. Dedicated local refs keep snapshot
objects reachable until project deletion or retention removes both refs and
checkpoint metadata. The canonical common Git directory is recorded so linked
worktree removal does not prevent that cleanup.
Deletion and retention first persist an unavailable cleanup intent for every
affected checkpoint, then remove refs, then compact history. Interrupted cleanup
can therefore be retried without advertising a checkpoint whose objects are no
longer reachable.

Checkpoint states are explicit:

- `baseline`: the clean pre-turn workspace was captured and the turn is active.
- `completed`: both identities are available for diff and rewind.
- `failed`: the turn stopped before a completed checkpoint could be captured.
- `superseded`: a later completed checkpoint exists, or this checkpoint was
  used to rewind.
- `unavailable`: a safe snapshot could not be created.

Capture refuses a dirty pre-turn workspace or pre-existing untracked files.
Changed symlinks, submodules, untracked embedded repositories, Git clean/smudge
filters, and working-tree encodings make checkpoints unavailable rather than
partially captured. This prevents Aldunis Code from claiming it can restore
bytes that Git transforms.

Gitignored paths (for example `node_modules/`, build output, `.env`,
`.DS_Store`) are outside checkpoint scope. They are not snapshotted, not
rewritten on rewind, and no longer block capture merely by existing on disk—
otherwise every ordinary project would report checkpoints as unavailable. Do
not rely on rewind to undo agent writes into ignored paths. A completed
checkpoint can include ordinary non-ignored files created by the agent.

If a turn changes `HEAD`, its checkpoint is unavailable. Rewind restores a
workspace and index; it never rewrites commits or branch history. Project
deletion and retention return a retryable conflict while an affected turn is
active so snapshot creation cannot race cleanup.

## Rewind and recovery

Rewind is a two-step local operation. Preview verifies that the current Git
tree exactly matches the completed checkpoint and lists every affected file.
Confirmation repeats both the workspace and Git index identity checks, validates
the reverse patch, applies it, and restores the baseline index. A concurrent
edit or staging change therefore fails without mutation.

If capture is interrupted, restart Aldunis Code. The durable state remains
`baseline`, `failed`, or `unavailable`; the workspace is not rewritten. Inspect
the worktree and start a new turn after handling any dirty or untracked work.

If rewind is interrupted before patch application, no file changed and preview
can be retried. If the process stops during patch application, Git may leave a
partially changed worktree. Aldunis Code will reject the old confirmation
identity. Inspect the changed-file view, restore or commit the visible work
manually, and prepare a new preview. Aldunis Code never runs destructive cleanup
or rewrites general Git history during recovery.
