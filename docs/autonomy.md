# Autonomy

Aldunis Code now has a local autonomy plane for durable awareness and bounded
maintenance. It is deliberately separate from provider execution: autonomy can
observe, queue, retry, pause, resume, and report, while provider mutations
still pass through the ordinary conversation and approval surfaces.

Open the command palette → **Autonomy**.

## Primitives

| Primitive                    | Behavior                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background task ledger       | Every run is a durable `AutonomyRun` with ordered `AutonomyTask` records, status, attempts, errors, and result digest.                                                                     |
| Typed Task Flows             | Built-in flow definitions contain ordered step kinds, retries, timeouts, approval-gate markers, resumability, runtime/task budgets, and a zero provider-cost limit.                        |
| Heartbeats                   | Host-owned periodic awareness checks or scheduled gardener runs with minimum 60-second intervals and optional active hours. They run only while the host is alive.                         |
| Hooks                        | Internal reactions to completed turns, failed turns, completed automations, heartbeat ticks, or completed autonomy runs. Hooks have cooldowns and can start only built-in read-only flows. |
| Standing orders              | Durable, bounded operator preferences carried as metadata into future run context. They do not grant authority.                                                                            |
| Nightly maintenance gardener | A read-only flow that checks the worktree, scans a bounded set of text files for maintenance signals, ranks findings, and writes an operator report.                                       |

The local event log remains the single durability authority. The autonomy
records are metadata only: source contents, prompts, provider transcripts,
credentials, raw tool traffic, and hidden reasoning are not stored in them.

## Recovery and resumability

On host startup, active autonomy runs are marked `lost` because their in-flight
step cannot be proven to have completed. The operator can inspect the run and
choose **Resume**. Queued and failed tasks are reset at the state boundary and
the same run continues through the typed flow. Cancellation is sticky and does
not silently restart work.

Retries are per step and bounded by the flow definition. Each step has a
timeout, and the run has a maximum task count and runtime budget. The shipped
flows have `maxCostUsd: 0` because no provider-backed autonomy step is enabled.

## Gardener scope

The gardener uses read-only Git inspection and bounded local file reads. It
records only relative paths, categories, severity, counts, short explanations,
and suggested follow-up. It skips secret-bearing filename patterns and binary
files. It does not stage, edit, commit, push, create a worktree, start a
provider run, approve a tool, or launch a release.

The initial signals are intentionally small and deterministic:

- dirty worktree awareness;
- tracked secret-file name candidates;
- TODO/FIXME/XXX maintenance-marker counts;
- presence of a README/docs entry point;
- a package test-script check; and
- a package-lockfile presence check.

Findings are suggestions, not commands. A follow-up uses a normal provider turn
and its existing scoped approval boundary.

## Host and API behavior

All routes are POST-only and return bounded JSON. Read-only ledger loading is
available to the current host surface. Creating, updating, deleting, starting,
cancelling, and resuming autonomy records is loopback-local, and is unavailable
in managed hosted mode. No system daemon is installed; schedules are evaluated
only by a running Aldunis Code host.

Important routes:

- `POST /api/autonomy/load`
- `POST /api/autonomy/gardener/start`
- `POST /api/autonomy/runs/cancel`
- `POST /api/autonomy/runs/resume`
- `POST /api/autonomy/heartbeats/create|update|delete|run-now`
- `POST /api/autonomy/standing-orders/create|update|delete`
- `POST /api/autonomy/hooks/create|update|delete`

## Boundary

This is a local awareness and maintenance layer, not an unattended coding or
deployment agent. General-purpose terminal access, automatic provider tool
approval, arbitrary external webhooks, automatic worktree creation, commits,
pushes, pull requests, releases, and cross-product governance authority remain
out of scope until a separate accepted boundary changes them.
