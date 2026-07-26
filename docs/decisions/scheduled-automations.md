# Scheduled automations (existing conversation)

Status: Accepted  
Date: 2026-07-26

## Decision

Aldunis Code supports **timer-only automations**: a durable prompt delivered on
an interval or 5-field Unix cron schedule into an **existing conversation**.

Product model follows Codex *thread* scheduled tasks (return to the same chat
with context) rather than standalone new-chat-per-run automations.

### In scope

- Target: existing `threadId` only
- Schedule: interval (≥ 60s) or 5-field cron (UTC)
- Scheduler: host process while the host is listening
- First evaluation **seeds** `lastRun` and does not fire (use **Run now**)
- Skip when the target thread is busy; do not advance `lastRun` on scheduled
  busy skips
- Normal provider turn path (checkpoint, events, wake)
- Explicit tool approvals unchanged (no auto-never trust mode)

### Out of scope

- Event triggers (filesystem, webhooks, PR events)
- Standalone new conversation / new worktree per run
- RFC 5545 RRULE
- Per-automation approval widening
- OS-level daemons outside the host
- Create-from-chat natural language authoring

## Consequences

- Persistence: `{stateDir}/automations.v1.json` (not preferences)
- The host must stay running for schedules to fire (same as Codex desktop app
  for local projects)
- Findings are reviewed by opening the target conversation transcript
- Cron uses UTC; document that in the UI

## References

- Codex scheduled tasks: https://learn.chatgpt.com/docs/automations?surface=app
- Bugyo ADR (implementation patterns): existing-session enqueue, pure `isDue`, seed
