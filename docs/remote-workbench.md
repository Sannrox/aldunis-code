# Authenticated remote workbench recommendation

## Decision

Aldunis Code remains loopback-only by default. Maintainer direction recorded
on issue #32 accepts one proof-key-bound application authentication protocol
over explicitly launched transports:

- Tailscale Serve HTTPS/WSS is the recommended iPad and remote transport.
- A specifically selected private LAN address may be exposed only through an
  HTTPS listener with explicitly supplied certificate and key files.
- The desktop can launch an SSH-backed remote workbench through a loopback
  forward. The remote host remains loopback-bound and uses the same proof-key
  pairing protocol.

None of these transports changes the normal local listener. Remote startup creates a
separate authenticated server, and plaintext browser access fails
closed. Pairing creation, device listing, and revocation remain local-host
controls. In SSH mode the desktop invokes the remote auth CLI through the
already host-verified SSH identity; the browser-visible forward is never
granted local administration, and remote device sessions cannot administer
access.

The remote host remains part of Aldunis Code, not a new hosted service. A
separate network service boundary is justified only if Aldunis later needs
browser-only access, rendezvous, or managed relay. Such a service would require
its own availability, abuse, tenant-isolation, data-processing, and incident
response design.

## Connection model comparison

| Model | Reachability and transport | Authentication and browser behavior | Recommendation |
| --- | --- | --- | --- |
| Loopback-only | The UI and host run on one device. No network listener exists. | Existing same-device boundary; origin checks and application permissions still apply. | Keep as the default and recovery path. It cannot reach a remote repository. |
| SSH-forwarded loopback | The remote host binds to `127.0.0.1`; the desktop launches or reuses it and exposes it on a saved, preferred local port through an explicit SSH forward. | SSH host verification plus loopback-only proof-key application authentication. | Implemented desktop transport. Reuse the user's SSH configuration and credentials. |
| Tailscale Serve | The authenticated server remains on loopback while Tailscale provides a Tailnet-reachable HTTPS/WSS endpoint. | Tailnet controls reachability and TLS transport; proof-key-bound Aldunis sessions control application authority. | Recommended initial iPad and remote transport. |
| Private LAN endpoint | The authenticated HTTPS server binds to one selected private address using explicitly supplied certificate and key files. | TLS provides confidentiality and a secure browser context; application authentication, exact origin checks, expiry, and revocation remain required. | Explicit trusted-LAN mode only; never bind implicitly to all interfaces or fall back to plaintext. |
| Public HTTPS endpoint | The host or a gateway is Internet-reachable with TLS and a stable name. | Requires trusted certificates, `https`/`wss`, strict origin validation, rate limits, proof-of-possession credentials, tenant-safe routing, and an operated revocation plane. | No-go for the workbench host. Revisit only behind a separately owned gateway or relay with a complete service threat model. |

Private-network location must not grant implicit trust. Browser WebSocket
clients also require explicit `Origin` validation; the origin header protects
browser use, but a non-browser client can supply an arbitrary value, so it is
not client authentication. See [NIST SP 800-207][] and [RFC 6455][].

## Authority and data placement

The machine that can read the repository and launch the provider owns the
workbench execution authority. Remote use does not make a local repository
remote or synchronize two event stores; it attaches the desktop to a distinct
remote workbench.

| Concern | Local desktop | Remote workbench host | External authority |
| --- | --- | --- | --- |
| Repository and worktrees | Store a user-visible host label and opaque repository identifier. Do not cache source as authority. Render requested source and diffs ephemerally. | Canonicalize roots, constrain file access, run Git operations, and retain repository authority. | None. |
| Provider process and session | Render normalized events and cancellation state. | Launch, resume, cancel, and supervise the provider. Store provider-session references in the remote event log. | Provider owns its supported credential store. |
| Credentials | Store the paired device private key in OS-protected storage and refer to SSH configuration by name. Never import SSH or provider private keys. | Keep provider credentials and paired-client public keys locally on the remote machine with restricted permissions. | Provider owns its supported credential store. |
| Conversations and logs | Keep only explicit connection metadata and user-selected local exports. Logs exclude repository content, prompts, tool data, tokens, and endpoints containing secrets. | Persist the authoritative conversation event log and sanitized operational logs under the remote user's account. Apply retention and deletion there. | Sekai Chisei may receive explicit governance, evidence, provenance, usage, and audit events through an authenticated contract, never raw local state by default. |
| Approvals | Present the exact remote action, host identity, repository/worktree, scope, and expiry; sign the response with the paired device key. Do not silently replay an approval after reconnect. | Enforce approval at the mutation point, bind it to the turn, action digest, repository/worktree, device, nonce, and expiry, and append the outcome to the remote event log. | Sekai Chisei may supply policy; it does not execute the local action. |
| Delivery projections | Display authenticated projections only. | No authority over delivery records. | Tenkai owns releases, environments, delivery plans, deployments, rollback, and recovery. |

Disconnecting the desktop must not terminate an already accepted provider
operation implicitly. The remote host records whether the operation continued,
completed, failed, or was cancelled, and the client reconciles from the remote
event sequence on reconnect. Mutating tool calls that have not received a
valid scoped approval remain denied.

## Pairing and session lifecycle

Pairing establishes a device grant for one remote workbench host. It is local
workbench authentication, not a federated product login.

1. The remote host creates a high-entropy, single-use pairing secret with a
   short expiry and displays it only in the user's authenticated remote shell.
2. The desktop connects through an already host-verified SSH tunnel, generates
   a non-exportable device key where the operating system permits, and sends
   the public key plus the pairing secret.
3. Both sides show the remote SSH host-key fingerprint, remote workbench
   instance fingerprint, client device name, and a short confirmation digest.
   The user confirms on both ends.
4. The host consumes the secret atomically and returns an opaque grant
   identifier bound to the client's public key, protocol audience, and
   workbench instance. The secret is never a reusable bearer credential.
5. Later requests prove key possession and include method, target, body digest,
   issued-at time, unique request ID, and server challenge. The host rejects
   duplicate, expired, wrong-audience, and wrong-instance requests.

This borrows the short-lived, high-entropy, rate-limited, user-confirmed
properties of the OAuth device flow without treating pairing as OAuth.
[RFC 8628][] describes device-code brute force and remote-phishing risks.
Sender-constrained credentials reduce the value of a stolen token; [RFC 9449][]
provides the relevant proof-of-possession and replay considerations.

Each paired device has an independent grant, display name, creation time, last
use, and revocation state. The remote user can list and revoke grants from an
authenticated shell command even when no desktop can connect. Revocation takes
effect before new requests are accepted and closes active connections. A
rotated remote instance key invalidates all grants and requires pairing again.
Grant material must not appear in URLs, browser storage, logs, crash reports,
or repository files.

## Transport and SSH launch

The supported first transport is an SSH local forward equivalent to:

```text
ssh -N -T \
  -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:<ephemeral-client-port>:127.0.0.1:<remote-host-port> \
  <user-selected-host-alias>
```

This is a protocol shape, not a command to concatenate and pass to a shell.
The launcher must use an argument vector, a user-selected SSH host alias, the
user's normal `known_hosts` verification, and an inspectable lifecycle. It
must not accept arbitrary extra arguments from a repository, disable host-key
checking, copy private keys, open a remote shell, or hide SSH prompts behind a
generic loading state. Cancellation terminates only the child SSH process that
the application started.

SSH forwarding protects the transport from the local port to the remote port.
It does not protect against another process running as either OS user, a
mis-forwarded port, a malicious browser origin, or a compromised remote host.
The application protocol therefore requires device proof, authorization, and
strict browser-origin checks even inside the tunnel.

### Desktop-managed environments

The Electron desktop exposes **Settings → Connections → Remote workbenches**.
It stores a named environment with either an HTTPS origin or an SSH target.
The desktop record contains only the display name, origin/SSH alias, remote
backend port, executable name, pairing state, and preferred local port. It
never stores an SSH private key, provider credential, or pairing credential.

For an SSH environment, the desktop:

1. launches the fixed remote command
   `aldunis-code serve --remote ssh --host 127.0.0.1 --port <remote-port>`;
2. opens a local forward equivalent to
   `127.0.0.1:<local-port> -> 127.0.0.1:<remote-port>`;
3. probes `/api/remote/descriptor` through that forward;
4. invokes `aldunis-code auth pairing create` through the host-verified SSH
   connection when a new device proof is needed; and
5. loads the forwarded origin in the desktop renderer.

The desktop-managed SSH backend defaults to remote port **4177**, keeping the
development UI on **4174** and the split development host on **4175**. The
client-side forward uses an operating-system allocated port on first use and
remembers that port as a preference so the browser origin remains stable across
reconnects when it is available. The [T3 Code remote guide][] documents backend
port **3773**; T3 Code is not an Aldunis-compatible backend and must not be
selected as an Aldunis executable.

SSH launches use an argument vector, `BatchMode=yes`, the user's normal
`known_hosts` verification, `ExitOnForwardFailure=yes`, and no shell-supplied
extra arguments. Password-prompt-only SSH configurations fail with a visible
diagnostic; configure an SSH key or agent before using the desktop flow.

If a future HTTPS transport is approved, require TLS 1.3 with normal hostname
validation, `wss` for streaming, no bearer credentials in URLs, and no
mutation in TLS 0-RTT. TLS 1.3 does not guarantee non-replay for early data,
so approval and mutation requests must wait for the handshake and retain
application-level replay protection. See [RFC 8446][]. An HTTPS application
must not load insecure remote HTTP resources; browsers classify such requests
as mixed content. See [MDN mixed content][].

## Compatibility and updates

The handshake exchanges:

- protocol major and minor versions;
- minimum and maximum compatible versions;
- host instance ID and public-key fingerprint;
- server capabilities and required security features;
- client capabilities, with sensitive features omitted until authenticated.

An incompatible major version fails closed before repository metadata is
returned. Minor-version compatibility is capability-negotiated; unknown event,
permission, or mutation types are rejected rather than coerced. The UI shows
which side must update and retains the loopback-only recovery path.

The desktop and remote host own their updates independently. Neither side may
upload and execute an update on the other. Each follows its platform's signed
package and rollback policy. A compatibility window can be promised only
after protocol fixtures test the oldest and newest supported combinations.
Tenkai delivery state does not control workbench binary updates.

## Threat model and required controls

| Threat | Required control and deterministic evidence |
| --- | --- |
| Stolen or phished pairing code | At least 128 bits of secret entropy, short expiry, single atomic redemption, attempt rate limits, bilateral host/device confirmation, and tests for reuse, expiry, guessing limits, and concurrent redemption. |
| Stolen bearer or replayed request | Device-key proof, audience and instance binding, server challenge, request ID, timestamp window, action/body digest, replay cache, and fixtures for duplicate, delayed, altered, and cross-host requests. Never send mutations in TLS 0-RTT. |
| Lost or stolen client device | Independent device grants, remote-shell listing and revocation, immediate connection closure, OS-protected non-exportable key where available, visible last-use data, and recovery tests with every client revoked. |
| Compromised remote host | Treat repository, provider credentials, conversations, and pending operations as compromised. Stop connecting, preserve sanitized evidence, rotate the instance identity, revoke all device grants, repair or rebuild the host, and re-pair. No transport can make a compromised execution host trustworthy. |
| Malicious site reaching loopback | Exact origin allowlist, unguessable connection bootstrap, application authentication, CSRF defenses for HTTP endpoints, WebSocket `Origin` validation, no permissive CORS, and browser tests from allowed and hostile origins. |
| Private-network peer probing the host | Keep loopback binding in the SSH model. Any later network listener also requires TLS, authentication before metadata, rate limits, bounded requests, and tests showing network membership grants no authority. |
| Approval confusion or reconnect replay | Show host, repository/worktree, command or typed action, scope, and expiry. Bind approval to one action digest and event sequence. Deny stale, changed, unknown, or already-consumed approvals. |
| Credential leakage | Refer to SSH aliases and provider profiles; never return keys or raw environment values to the browser. Redact logs and errors. Scan fixtures and changed paths for secrets, repository contents, transcripts, databases, and private absolute paths. |
| Browser mixed content or origin confusion | Use a local tunneled origin in the SSH model. Require `https`/`wss` and exact origins for any later remote web model. Reject caller-selected origins, redirects, and host headers outside the configured set. |
| Version downgrade or unknown message | Authenticate version negotiation, require security-critical capabilities, fail closed on incompatible majors and unknown mutations, and test downgrade, omission, and reordering cases. |
| SSH launcher argument injection | Spawn a fixed executable with an argument vector; accept only a selected host alias and allocated ports; do not invoke a shell. Test hostile aliases, configuration failures, host-key changes, cancellation, and orphan cleanup. |

## Recovery

- **Tunnel loss:** mark the connection offline, do not infer cancellation, and
  reconcile from the last verified remote event sequence after reconnect.
- **Pairing failure:** expire the secret and grant, remove incomplete state on
  both sides, and restart pairing. Never downgrade to an unauthenticated mode.
- **Lost device:** revoke its grant through the authenticated remote shell. If
  that is impossible, stop the host, remove all grants, rotate the instance
  identity, and re-pair trusted devices.
- **Remote compromise:** stop provider processes where safe, disconnect
  clients, preserve sanitized incident evidence, rotate host and provider
  credentials through their owners, rebuild, and re-pair.
- **Incompatible update:** update the older side through its normal signed
  channel or roll it back using its package policy. Do not bypass negotiation.
- **Remote unavailable:** the desktop remains usable with local loopback
  projects. Remote metadata is visibly stale and never becomes local authority.

## Impact and ownership

| Surface | Evidence from this recommendation | Required future change or check | Owner | Risk |
| --- | --- | --- | --- | --- |
| Repository and persistence | Execution authority and authoritative history move together to the remote host. | Remote-root canonicalization and event-store recovery tests; no implicit local cache authority. | Aldunis Code | High |
| Provider lifecycle | Provider runs where the repository is available. | Adapter fixtures for launch, stream, cancel, failure, reconnect, and unknown events across the protocol. | Aldunis Code | High |
| Permissions | Approval crosses a device boundary but is enforced remotely. | Signed, scoped, expiring approval protocol with deny, replay, alteration, and reconnect tests. | Aldunis Code | Critical |
| Transport and credentials | SSH supplies the first transport; paired device proof supplies application identity. | Threat-model Discussion, launcher isolation tests, key storage, revocation, redaction, and protocol review. | Aldunis Code | Critical |
| Delivery | Remote connection does not create delivery authority. | Authenticated, versioned clients only if delivery projections are added. | Tenkai | Medium |
| Packaging and operations | Desktop and remote host update independently. | Signed packages, compatibility matrix, clean install, upgrade, downgrade rejection, and rollback evidence. | Aldunis Code | High |

There is no data migration in this research PR. A future implementation must
not reinterpret existing local projects as remote projects. Rollback removes
the remote connection capability while leaving each remote host's repository
and event store intact and recoverable through that host.

## Accepted implementation boundary

The explicit no-go is: **do not add a public listener, treat LAN or Tailnet
membership as application authority, or weaken proof-key-bound remote
sessions.**

The accepted direction on issue #32 fixes the initial transport, pairing,
device-key, revocation, and approval boundary. The desktop-managed SSH
environment path is now implemented on top of that boundary. Remaining
follow-up work may add:

1. a versioned authenticated remote-workbench protocol and adversarial
   fixtures, without a network listener;
2. remote host instance identity, one-time pairing, device grants, revocation,
   and recovery commands;
3. bilateral host-key/device confirmation UI, richer approval context, and
   reconnect reconciliation evidence;
4. signed remote-host packaging, compatibility testing, update guidance, and
   rollback evidence.

Every later transport must reuse the application protocol rather than
weakening it.

[NIST SP 800-207]: https://csrc.nist.gov/pubs/sp/800/207/final
[RFC 6455]: https://www.rfc-editor.org/rfc/rfc6455
[RFC 8628]: https://www.rfc-editor.org/rfc/rfc8628
[RFC 8446]: https://www.rfc-editor.org/rfc/rfc8446
[RFC 9449]: https://www.rfc-editor.org/rfc/rfc9449
[MDN mixed content]: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content
[T3 Code remote guide]: https://github.com/pingdotgg/t3code/blob/main/REMOTE.md
