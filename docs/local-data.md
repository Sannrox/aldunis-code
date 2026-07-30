# Local data

All durable Aldunis Code state stays on the machine. Treat prompts, paths,
diffs, and tool activity as **sensitive local data**.

## State directory

Default:

| Platform | Path |
| --- | --- |
| Linux (XDG) | `$XDG_STATE_HOME/aldunis-code` or `~/.local/state/aldunis-code` |
| Override | `ALDUNIS_CODE_STATE_DIR` |

Typical contents (names may evolve; do not commit these files):

| File / area | Purpose |
| --- | --- |
| `events.v1.jsonl` | Append-only conversation history log |
| `preferences.v1.json` | Theme, density, worktree limit, shortcuts |
| `automations.v1.json` | Scheduled automations |
| Profile / secret store | Provider profile metadata (all providers + adapters) + env secrets |
| Provider adapter metadata | Installed declarative adapters |
| Shikigami run dirs | Per-conversation harness state under `~/.aldunis-code/shikigami` (and related) |

File modes are restricted (owner-only where applicable). History mutations are
locked across local host processes. If an older concurrent-host race left intact
JSONL records with forked sequence metadata, startup renumbers those records in
physical append order without discarding them. Malformed JSON and incompatible
schemas still **fail visibly** rather than wiping data.

## Conversation history

Projects, threads, turns, messages, typed tool activity, provider session
references, context receipts, checkpoints, delegated-conversation
relationships, and related records rebuild from the event log.

- Active turns remain owned by the host if you navigate away and return.
- Each project is limited to a bounded number of retained conversations
  (currently 200) until older history is deleted or compacted.
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
- While an orchestration parent is focused, its child statuses remain a quiet
  projection: running and blocking counts are aggregated, completed outcomes
  stay collapsed in relationship order, and ordinary child completion does not
  raise a desktop notification. Approval, input, and failure states remain
  eligible for attention. Disabling the beta restores the standard independent
  conversation presentation and notification behavior.

## Preferences

Appearance and keyboard preferences load/save via
`/api/preferences/load` and `/api/preferences/save`. Invalid files recover to
safe defaults with a visible recovered flag. Experimental orchestration
threads are disabled by default; disabling the beta hides projections without
deleting stored relationships.

## Secrets

- **Provider logins** remain in each CLI’s own store.
- **Profile environment secrets** are Aldunis-owned, write-only in the UI, and
  deleted only when you remove the variable or profile—not when you clear a
  masked field.

## What never to commit

- Credentials, tokens, `.env` with secrets
- Provider transcripts and unredacted logs
- Customer or private repository content
- Local databases and runtime state directories
- Absolute private paths in public bug reports (prefer redaction)

See [SECURITY.md](../SECURITY.md).
