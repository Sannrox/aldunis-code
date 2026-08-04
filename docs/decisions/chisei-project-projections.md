# Server-owned Chisei project projections

- Status: Accepted
- Date: 2026-07-30
- Issue: [#207](https://github.com/Sannrox/aldunis-code/issues/207)

## Context

Aldunis Code needs to display governed Action and operation state associated
with a local project. Chisei owns that state and its namespace authorization.
Accepting a namespace, endpoint, or credential on each browser read would let a
caller select authority and would blur the product boundary.

## Decision

- A local project may store one Chisei namespace binding in Aldunis Code's
  restricted event history.
- Binding administration is available only in the default loopback-only mode.
  It is disabled for every browser session while remote access is active so a
  loopback reverse proxy cannot be mistaken for local authority.
- The Chisei endpoint and optional bearer token come from server environment
  configuration. They are never returned to or accepted from the browser.
- Read APIs accept a local project id and bounded filters or record ids. The
  host derives the namespace from its project binding and rejects responses
  outside that namespace.
- Action, effect, and operation receipt responses are projected through an
  allowlist. Parameters, producer text, claim fencing tokens, raw receipt JSON,
  and credentials are not exposed or persisted.
- Recent list results may be retained in memory for a bounded stale fallback.
  They are labelled stale and never become domain authority.
- Contract incompatibility, authentication failure, missing configuration, and
  unavailability fail visibly.

## Consequences

The browser can inspect Chisei state without gaining namespace or credential
authority. A local namespace binding is durable but contains no remote content.
The gRPC read contract is vendored as a minimal compatibility surface and must
be updated deliberately when the upstream wire contract changes. The Node host
uses the pinned `@sannrox/sekai-chisei-sdk` facade for transport, metadata,
deadlines, and typed errors; see [the SDK compatibility reference](../chisei-sdk.md).

## Non-goals

- Action admission or mutation
- Runtime claims, leases, retries, or acknowledgement
- Shared databases or locally authoritative Action caches
- Sending repository paths, prompts, source text, or provider transcripts to
  Chisei
