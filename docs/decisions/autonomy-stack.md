# Safe local autonomy stack

- Status: Accepted safe v1
- Date: 2026-08-03
- Source: Maintainer implementation direction in the autonomy work request

## Context

Aldunis Code needs more durable autonomy primitives than timer-only prompts:
periodic awareness, background task ledgers, resumable typed flows, internal
event hooks, standing orders, and a nightly maintenance gardener.

## Decision

Implement the primitives in the local Code host using the existing append-only
state log and writer lease:

1. Runs and tasks are durable metadata records with explicit lifecycle states.
2. Typed flows provide bounded retries, timeouts, approval-gate markers,
   resumability, task/runtime budgets, and zero provider-cost v1 limits.
3. Heartbeats and internal hooks execute only while the local host is alive.
4. Standing orders are persisted operator preferences, not new authority.
5. The maintenance gardener is read-only and reports bounded findings.
6. Provider runs, tool approvals, filesystem mutations, source-control delivery,
   releases, and cross-product policy remain owned by their existing boundaries.
7. Remote and managed clients may inspect an allowed projection but cannot mutate
   or launch local autonomy records.

## Consequences

Autonomy survives host restarts as an inspectable ledger and never guesses the
outcome of an interrupted step. An operator must explicitly resume lost work.
The system can grow typed read-only steps without creating a hidden terminal or
approval bypass. Provider-backed or mutating steps require a new accepted
architecture decision before implementation.
