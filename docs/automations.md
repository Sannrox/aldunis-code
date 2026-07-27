# Automations

Timer-only **durable prompts** that fire into an **existing conversation** while
the local host is running.

Open via the command palette → **Automations**.

## What they are

| Field | Meaning |
| --- | --- |
| Name | Operator label |
| Target | Existing thread only (no new chat / worktree) |
| Prompt | Durable instruction for each run |
| Mode | Ask / Plan / Build (defaults apply per create UI) |
| Schedule | Interval (≥ 60 seconds) or 5-field **UTC** cron |
| Enabled | Paused when off |

Design record: [decisions/conversation-automations.md](decisions/conversation-automations.md).

## Schedule semantics

1. **First evaluation seeds** `lastRunAt` without firing (avoids surprise fire
   after create or host restart).
2. **Run now** ignores the schedule and runs immediately (still respects busy).
3. If the target thread is **busy** (active turn or pending approval), a
   scheduled tick records `skipped_busy` and **does not advance** `lastRunAt`.
4. Cron uses standard 5-field form (`min hour dom month dow`). When both
   day-of-month and day-of-week are restricted, matching uses **POSIX OR**
   (either field may match).
5. Due automations in one tick start **concurrently**; two automations on the
   same thread still serialize (second skips busy).

## Safety

- Tool approvals are **unchanged**: automations never auto-approve mutations.
- Create / update / delete / run-now are **loopback-only** for remote-paired
  clients (same posture as adapter administration). List remains available.
- Schedules evaluate only while the **host process is alive**. There is no
  system daemon.

## Persistence

Stored as `automations.v1.json` under the host state directory (not preferences).
See [local-data.md](local-data.md).

## Non-goals

- Event triggers (git hooks, webhooks, file watchers)
- RFC 5545 RRULE
- New conversation or worktree targets
- Chisei policy hooks

## API (host)

| Route | Purpose |
| --- | --- |
| `POST /api/automations/list` | List automations |
| `POST /api/automations/create` | Create |
| `POST /api/automations/update` | Update / pause |
| `POST /api/automations/delete` | Delete |
| `POST /api/automations/run-now` | Immediate fire |
