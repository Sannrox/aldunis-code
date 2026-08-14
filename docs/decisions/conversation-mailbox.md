# Inspectable conversation mailbox

- Status: Accepted
- Date: 2026-08-14
- Issue: [#1101](https://github.com/Sannrox/aldunis-code/issues/1101)
- Source: Maintainer direction to ship a human-reviewed mailbox before
  autonomous agent-to-agent turns

## Context

Operators can coordinate child conversations from a parent, but they still copy
text between independent threads. Grok Bot-style autonomous messaging would
reverse [delegated human control](delegated-human-control.md): the parent is a
human control surface, and approvals cannot be delegated to an agent.

## Decision

Ship a **human-reviewed mailbox** between existing conversations in the same
local project:

1. The operator chooses a destination thread, writes 1–4000 characters, and
   confirms the exact payload. Canceling the review dialog persists nothing.
2. Confirm atomically persists the destination `turn`, user `message`, and
   `mailbox_transfer_saved` record, then admits that pre-created turn through
   `admitProviderRun`. The reviewed text is the destination user message and
   provider prompt. If admit fails, the destination turn is interrupted so the
   same idempotency key can retry.
3. Source and destination history both project the transfer. The source card is
   inspectable chrome only and never enters the source provider context.
4. Destination busy, missing, deleted, pending-fork, or same-as-source fails
   closed before persist. Reusing an idempotency key while the destination turn
   is still active or already launched returns the existing transfer without a
   second admit. Mailbox delivery never prepends pending-fork source context.
5. Mutating tools on the destination turn still require PermissionBroker.
   Remote and managed hosted clients cannot send.

## Consequences

- Humans remain the router. Agents cannot originate mailbox sends or answer
  approvals for each other.
- Destination worktree, provider, and session stay bound to conversation B.
- Mailbox records are local provenance, not Sekai Chisei evidence.

## Non-goals

- Agent-originated sends or automatic replies
- Group threads or a shared computer
- Cross-project or cross-provider implicit context copy
- Automatic tool approval
- Always-on teammate loops
