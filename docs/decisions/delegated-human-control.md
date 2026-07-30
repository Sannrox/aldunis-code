# Delegated human control

- Status: Accepted
- Date: 2026-07-30
- Issues: [#411](https://github.com/Sannrox/aldunis-code/issues/411),
  [#413](https://github.com/Sannrox/aldunis-code/issues/413)
- Source: Maintainer direction recorded on
  [#411](https://github.com/Sannrox/aldunis-code/issues/411#issuecomment-5131007080)
  and
  [#413](https://github.com/Sannrox/aldunis-code/issues/413#issuecomment-5131007475)

## Context

A delegated child can require a human approval or product decision while its
parent remains the developer's focused coordination surface. Moving the
controls into the parent must not transfer conversation authority, broaden a
tool approval, or copy parent context into the child.

Provider input mechanisms also differ materially: some can resume a native
request, some park with provider-specific recovery, and some require a new
turn.

## Decision

The parent is a beta-gated human control surface, not an authority principal.

For tool approvals, the parent projects only pending approvals belonging to an
explicitly linked child. A parent-routed decision must revalidate the current
relationship and the original approval ID, run, child conversation,
repository, worktree, tool call, state, and expiry. It then invokes the same
single-use `PermissionBroker` decision path as the child. The approval is never
copied, widened, made durable, or delegated to an agent.

For input requests, adapters normalize a bounded provider-independent request.
A human response is single-use and routes only to the originating child. An
adapter may resume the native request when supported; otherwise Aldunis creates
an explicitly identified child follow-up turn. The parent stores a
coordination receipt, not a provider-visible copied message.

Parent projections and human responses never enter the parent provider
context. Disabling orchestration removes the parent controls and makes
parent-routed mutations fail closed. The child surfaces remain the recovery
path.

## Consequences

- Parent and child controls race on the same single-use identity; the second
  resolution receives `409`.
- Stale relationships, mismatched bindings, expired requests, provider
  failures, and restarts cannot create replacement authority.
- Provider-specific resume behavior remains behind adapters.
- Recommendations and choices remain informational; Aldunis never answers
  automatically.

## Non-goals

- Durable, batch, or automatic approvals.
- Agent-to-agent approval or decision delegation.
- Copying parent transcripts, tool state, or credentials into a child.
- Treating a displayed projection as domain authority.
