# Local data

All durable Aldunis Code state stays on the machine. Treat prompts, paths,
diffs, and tool activity as **sensitive local data**.

## State directory

Default:

| Platform    | Path                                                            |
| ----------- | --------------------------------------------------------------- |
| Linux (XDG) | `$XDG_STATE_HOME/aldunis-code` or `~/.local/state/aldunis-code` |
| Override    | `ALDUNIS_CODE_STATE_DIR`                                        |

Repository file browsing and context attachment use Git's tracked/non-ignored
view and additionally exclude hidden and credential-shaped secret-like paths,
including exact `secret`/`secrets`/`token`/`tokens` components and credential
filenames such as `clientSecret.json` or `apiToken.txt`. Composer drag/drop and
paste may stage supported images under `aldunis-code-composer-images/` inside the
active worktree. That directory is gitignored (so screenshots stay out of
`git add -A`), remains attachable as local context, and is filtered out of
Changes review and file browse results. Staging is capped at 32 images or 32 MB
per worktree (reject when full), with quota mutations serialized across local
host processes. Operators may remove
`aldunis-code-composer-images/` manually when reclaiming disk space.

Typical contents (names may evolve; do not commit these files):

| File / area                  | Purpose                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `events.v1.jsonl`            | Append-only conversation and autonomy history log                                          |
| `preferences.v1.json`        | At most 16 KiB of schema-owned theme, density, worktree, shortcut, and display preferences |
| `automations.v1.json`        | Scheduled automations                                                                      |
| `release-deliveries.v1.json` | At most 16 MiB of candidate/build digests and opaque Chisei/Tenkai correlation references  |
| Profile / secret store       | At most 24 MiB each of provider metadata and Aldunis-owned environment secrets             |
| Provider adapter metadata    | Installed declarative adapters                                                             |
| Shikigami run dirs           | Per-conversation harness state under `~/.aldunis-code/shikigami` (and related)             |

File modes are restricted (owner-only where applicable). History mutations are
locked across local host processes. If an older concurrent-host race left intact
JSONL records with forked sequence metadata, startup renumbers those records in
physical append order without discarding them. Malformed JSON and incompatible
schemas still **fail visibly** rather than wiping data.

## Conversation history

Projects, threads, turns, messages, typed tool activity, provider session
references, context receipts, checkpoints, delegated-conversation
relationships, and related records rebuild from the event log.

Automation fire identities also rebuild from the event log. They contain only
bounded idempotency and lifecycle metadata: fire key, scheduled/requested time,
bound Aldunis turn and provider-run identifiers, outcome, retry link, and safe
error code. Raw prompts, provider output, credentials, and approval material do
not enter the fire record. A started fire whose outcome cannot be proven after
host recovery is retained as unknown and is never replayed automatically.

Autonomy runs and tasks also rebuild from the same event log. They retain typed
workflow identity, lifecycle status, retry/timeout metadata, bounded budgets,
standing-order references, and metadata-only findings. Running records become
`lost` on host recovery and require an explicit operator resume. They never
retain source contents, provider transcripts, credentials, raw tool traffic, or
approval payloads.

A project may also retain one Chisei namespace binding. This is local routing
metadata, not a copy of Chisei authority. Action/effect/receipt projections are
not written to disk; a successful list may remain in memory for at most 30
seconds as an explicitly stale fallback.

- Active turns remain owned by the host if you navigate away and return.
- The workbench list projection (`POST /api/state/load`) returns lifecycle
  metadata only (threads, turns, statuses, sessions, delegated projections).
  Transcript bodies (messages, tool activities, plans, context receipts) load
  per conversation through `POST /api/state/conversations/history` so status
  refreshes do not re-ship multi-megabyte histories over loopback.
- In-process hot paths (provider event status, wake membership filters, autonomy
  ticks) read the live projection via `inspect()` instead of `load()`. `load()`
  still returns a full `structuredClone` for callers that need isolation;
  cloning multi-megabyte history on every provider event is not required for
  pure reads.
- Each project is limited to a bounded number of retained conversations
  (currently 200) until older history is deleted or compacted.
- Provider assistant streams are buffered and flushed as one durable message
  per segment (between tools, approvals, input prompts, or turn end). Segments
  also soft-checkpoint about every 4 KiB of growth and on host close so a long
  text-only reply is not only in RAM. Host recovery collapses older
  token-per-event assistant rows when rewriting history so long ACP streams do
  not retain multi-megabyte message tables or one fsync per token.
- Provider credentials, raw tool inputs/outputs, and environment values are
  **not** part of the history schema.
- Context receipts retain repository-relative paths, entry types, byte counts,
  truncation state, content digests, and omission reasons. They do not retain a
  second copy of repository file content.
- Delegated-conversation relationships contain only parent/child identifiers
  and creation time. Their UI projections derive title, project, worktree,
  provider, and status from the independent child conversation. Messages,
  tool activity, approvals, and provider sessions never enter the parent
  provider context.
- A human-started child is first persisted as a normal new thread and then
  linked to its parent before provider startup. The default child checkout is
  a new managed worktree; Build cannot use the parent worktree, while Ask and
  Plan may do so when explicitly selected. A failed provider startup leaves
  the independent child history visible without creating a second parent
  message or copying parent context.
- While an orchestration parent is focused, its child statuses remain a quiet
  projection: running and blocking counts are aggregated, completed outcomes
  stay collapsed in relationship order, and ordinary child completion does not
  raise a desktop notification. Approval, input, and failure states remain
  eligible for attention. Disabling the beta restores the standard independent
  conversation presentation and notification behavior.
- Pending child approvals are projected from the in-memory permission broker
  only while the beta is enabled. Resolving one from the parent reuses the
  original child-bound, single-use approval and records the resolution in the
  child's history; the parent stores no copied approval or provider-visible
  response.
- Normalized child input requests and coordination receipts are durable local
  records. A receipt stores the originating child, optional coordinating
  parent, route, timestamp, and answer digest—not the answer text. The answer
  itself is persisted only as the prompt of the originating child's native
  resume or explicitly identified follow-up turn.
- Governed direct Shikigami turns retain only provider, governance mode,
  thread/turn identifiers, the provider-confirmed run UUID, the equal Chisei
  operation UUID, and creation time. Prompts, paths, tool payloads, harvest
  output, credentials, and Chisei receipt bodies are excluded. Conversation
  deletion, project deletion, and retention remove the correlation.
- Local release-delivery sessions retain the candidate document and identity,
  build/test status and evidence digest, bounded Chisei receipt references, and
  bounded Tenkai release/plan/environment references. They do not retain source,
  command output, the signed provenance envelope, trust-root files, credentials,
  approval material, database paths, or raw logs. The store is capped at 50
  recent sessions and fails visibly on corruption.

## Preferences

Appearance, keyboard, and live-thinking display preferences load/save via
`/api/preferences/load` and `/api/preferences/save`. Invalid files recover to
safe defaults with a visible recovered flag. Experimental orchestration
threads are disabled by default; disabling the beta hides projections without
deleting stored relationships. The optional show-thinking flag is disabled by
default and only reveals provider-emitted reasoning in the active in-memory
timeline; thinking is never written to local history or included in fork
context.

## Secrets

- **Provider logins** remain in each CLI’s own store.
- **Profile environment secrets** are Aldunis-owned, write-only in the UI, and
  deleted only when you remove the variable or profile—not when you clear a
  masked field.
- **Chisei credentials** come from `ALDUNIS_CHISEI_TOKEN` in the host
  environment. They are never persisted in project history or returned to the
  browser.

## What never to commit

- Credentials, tokens, `.env` with secrets
- Provider transcripts and unredacted logs
- Customer or private repository content
- Local databases and runtime state directories
- Absolute private paths in public bug reports (prefer redaction)

See [SECURITY.md](../SECURITY.md).
