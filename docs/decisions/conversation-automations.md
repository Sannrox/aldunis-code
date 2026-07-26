# Conversation automations (timer-only)

- Status: Accepted
- Date: 2026-07-26
- Issue: #117

## Context

Operators want recurring prompts into existing Aldunis Code conversations
(checks, follow-ups) without manually re-sending while the local host runs.

## Decision

Ship **timer-only** automations stored outside preferences:

1. Durable store `automations.v1.json` under the host state directory.
2. Schedules: interval (≥ 60s) or 5-field **UTC** cron.
3. Targets: existing conversation/thread only (no new-session or worktree create).
4. Evaluate only while the local host process is running (no system-wide daemon).
5. First evaluation **seeds** `lastRunAt` without firing; **Run now** bypasses the schedule.
6. If the target thread is busy, scheduled ticks **skip without advancing** `lastRunAt`.
7. Explicit PermissionBroker approvals remain required for mutating tools; automations never auto-approve.

## Non-goals

- Event triggers (git push, file watch, webhooks)
- RRULE / calendar expansions
- Chisei policy hooks or governed routing
- Creating new conversations or managed worktrees from a schedule
- Unattended auto-approve of tools

## Consequences

- Automations are best-effort while the workbench host is up.
- Cron is UTC and minute-granularity; sub-minute intervals use interval schedules.
- Operators manage automations via the Automations dialog (command palette).
