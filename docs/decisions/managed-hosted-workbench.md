# Enterprise-managed hosted workbench

- Status: Accepted
- Date: 2026-07-31
- Issue: [#438](https://github.com/Sannrox/aldunis-code/issues/438)
- Source: maintainer direction selecting Option A, consistent with Platform Discussion #34 and Platform ADR 0005

## Context

Aldunis Code already supports a local loopback host and an explicitly paired
remote workbench. Enterprise composition needs a third, deliberate mode: a
private hosted Code instance for one configured tenant and repository
catalogue. Browser control hiding is not an authority boundary. The host must
reject untrusted identity, provider, model, executable, credential, and path
choices before local state or a provider subprocess is changed.

## Decision

Implement Option A: a gateway-issued, short-lived, EdDSA-signed managed
assertion selects a fixed Code host profile. The managed host:

1. starts only when issuer, audience, tenant, instance, assertion public key,
   repository catalogue, and complete Shikigami configuration are present.
   The assertion public key is exactly one inline or file-backed Ed25519 PEM,
   limited to 64 KiB. File-backed keys are read through one descriptor and
   rejected if their identity, size, or timestamps change during the read;
2. accepts only `x-aldunis-code-assertion` assertions with the configured
   issuer/audience/tenant/instance, `code:workbench` scope, `managed` mode,
   `aldunis-code-managed` profile, valid lifetime of at most five minutes, and
   a single-use `jti`. Every non-descriptor `/api/*` assertion must bind
   `method`, `path`, and `body_sha256` to the request; unbound assertions are
   rejected. Consumed JTIs are persisted under the host state directory so
   replay fails closed across process restarts and concurrent host processes
   that share that directory. Missing, expired, replayed, altered, unbound, or
   cross-audience assertions fail closed;
3. exposes only the configured canonical repository catalogue. Root and
   worktree requests are resolved against that catalogue, reject symlinks and
   filesystem-device changes, and never accept URL or arbitrary path input;
4. resolves every run to Shikigami `Build` with profile
   `aldunis-code-managed`, `model.adapter = "plane"`, and
   `governance.adapter = "sekai-chisei"` with `fail_closed = true`. The
   operator-selected model, endpoint, principal, namespace, executable, and
   governance token environment are host configuration, not browser inputs;
5. launches Shikigami 1.0.5+ with a deterministic environment containing only
   runtime basics, the dedicated run directories, and the configured Chisei
   token. Provider, platform, source-control, proxy, unrelated host, and
   ambient home credentials are not inherited. The managed tool allowlist
   excludes shell and background-shell tools so the governance token cannot be
   exfiltrated through an agent-controlled command;
6. keeps existing Code conversation, streaming, approval, cancellation,
   checkpoint, and diff flows, while hiding or rejecting provider/profile/
   adapter/model/mode administration and arbitrary repository browsing.

The managed listener may bind to loopback without its own TLS termination. A
non-loopback private bind requires explicitly supplied certificate and key PEM
files; private addressing alone is not treated as transport security.

The managed verifier is a separate trust boundary from `RemoteAuth` pairing.
Managed mode cannot combine with paired remote mode and never falls back to
loopback or device pairing after a managed assertion failure.

## Account projection

The enterprise account session remains owned by the gateway and its identity
provider. Code does not implement a password or OIDC login surface. For each
authenticated browser request, the gateway may include signed `name`,
`display_name`, `preferred_username`, `email`, `role` / `roles`, and optional
`session_exp` claims. Code verifies the assertion, then exposes a bounded
read-only account projection through `/api/host/capabilities`: display name,
the configured tenant, roles, scopes, and assertion/session expiry. It never
returns the assertion, provider credentials, or the raw subject identifier to
the browser.

The managed sidebar shows this projection only in managed mode. Local mode is
accountless and remains usable offline. When
`ALDUNIS_MANAGED_LOGOUT_URL` is configured, it must be an operator-selected
HTTPS URL without credentials or a fragment; Code renders it as the gateway
sign-out link. Without it, Code directs the user to the enterprise gateway
without guessing a logout endpoint.

## State and recovery

Managed mode is a single-tenant alpha. Code state and Shikigami run state live
on the operator-provided dedicated volume with restart preservation and no
implicit backup or cross-tenant recovery. Loss or corruption is visible and
fails closed. The mode is not an operating-system sandbox: the configured
provider subprocess still runs with the host operating system's authority.

## Ownership and dependencies

- Code owns the host mode, capability projection, repository/worktree
  boundary, conversations, approvals, diffs, and Shikigami subprocess adapter.
- Platform owns browser sessions, the gateway, private deployment, secrets,
  and repository materialization. Its audience-bound assertions are verified
  by Code and are never replaced by caller-selected tenant headers.
- The managed account panel is a projection of that gateway-owned session;
  it does not create local account authority or allow tenant switching.
- Chisei owns routing, policy, usage, receipts, and audit. Code does not turn
  a local projection into governance authority.
- Managed Shikigami requires the compatibility contract from Shikigami #152
  and release 1.0.5+; managed plane conformance depends on Chisei #488.

## Non-goals

Multi-tenancy within one Code process, public hosting, caller-selected
providers or credentials, arbitrary repository browsing, branch push/PR/delivery
authority, new conversation storage, and an operating-system sandbox remain
out of scope.

## Superseded guidance

The generic local Shikigami profile and `SHIKIGAMI_*` model/governance
environment controls remain valid for local loopback mode. They must not be
used as the managed hosted profile. The paired remote workbench decision
continues to govern device sessions and is not an enterprise tenant
assertion.
