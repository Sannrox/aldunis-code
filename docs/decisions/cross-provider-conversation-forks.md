# Cross-provider conversation forks

Status: Accepted
Source: [Issue #29 maintainer direction](https://github.com/Sannrox/aldunis-code/issues/29)

## Decision

A started conversation remains bound to its provider and native provider
session. Continuing with another provider creates a new local conversation with
explicit ancestry and a fresh provider-native session.

Before creating the destination conversation, Aldunis Code renders the exact,
bounded transfer manifest. Transfer content is constructed from an allowlist of
persisted user and assistant messages, user-authored diff annotations, selected
repository file excerpts, and explicit summaries. Credentials, environment
values, provider session identifiers, hidden reasoning, raw tool inputs and
outputs, approval state, and provider runtime events are not members of the
transfer model and cannot be selected.

The user chooses the destination provider, profile, model, and canonical
worktree, then confirms the manifest once. Validation fails closed when the
provider, profile, model, capability, context size, file, or worktree is no
longer available. Cancellation and failed validation create no destination
conversation and never modify the source conversation or provider session.

The destination records its source conversation, transfer manifest, provider,
profile, model, canonical worktree, and creation time. The manifest is local
provenance only; it is never represented as Sekai Chisei evidence. Retention of
a fork follows conversation retention and never deletes or rewrites its source.

## Consequences

- Provider switching remains unavailable inside a started conversation.
- Provider resume cursors and credentials are never translated or reused.
- A destination provider receives only the confirmed manifest through its
  normal first-turn input.
- The source and destination can be inspected independently even when the
  destination provider fails.
- Automatic transcript export, approval reuse, and governance evidence remain
  out of scope.
