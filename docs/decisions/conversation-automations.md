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
2. Schedules: interval (≥ 60s) or 5-field **UTC** cron. When both day-of-month
   and day-of-week are restricted, matching uses POSIX **OR** (either field may hit).
3. Targets: existing conversation/thread only (no new-session or worktree create).
4. Evaluate only while the local host process is running (no system-wide daemon).
5. First evaluation **seeds** `lastRunAt` without firing; **Run now** bypasses the schedule.
6. If the target thread is busy, scheduled ticks **skip without advancing** `lastRunAt`.
7. Explicit PermissionBroker approvals remain required for mutating tools; automations never auto-approve.

## Durability extension (#448)

Each scheduled slot receives a deterministic fire key and each explicit manual
request receives a caller-provided idempotency key. The fire identity is
appended to the local event log before provider launch, then bound to the
created Aldunis turn and provider-confirmed run identity. Reusing a key is
idempotent. An explicit retry of an unknown fire must use a new key and remains
visible as a separate attempt.

On host recovery, a fire is marked completed or failed only when the bound turn
proves that outcome. Any started fire whose provider outcome cannot be proven
is marked unknown and is never replayed automatically. This preserves the
existing writer lease, existing-conversation/worktree binding, and explicit
PermissionBroker approval boundary.

## Non-goals

- Event triggers (git push, file watch, webhooks)
- RRULE / calendar expansions
- Chisei policy hooks or governed routing
- Creating new conversations or managed worktrees from a schedule
- Unattended auto-approve of tools

## Consequences

- Automations are best-effort while the workbench host is up; an interrupted
  provider execution is visible as unknown and requires an explicit retry.
- Cron is UTC and minute-granularity; sub-minute intervals use interval schedules.
- Operators manage automations via the Automations dialog (command palette).
- Create / update / delete / run-now reject authenticated remote clients (same
  posture as adapter administration); list remains available when remote-paired.
- Due fires in one tick start concurrently so one long turn does not delay others.
