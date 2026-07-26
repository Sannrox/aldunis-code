# Architecture

## Purpose

Aldunis Code is a local-first workbench for agent-assisted software
development. Its core interaction is a structured conversation attached to an
explicit repository and worktree, with inspectable tool activity, approvals,
and diffs.

## Initial topology

```text
local browser UI
    |
local Aldunis Code host
    |-- repository and worktree adapter
    |-- normalized conversation/event store
    |-- permission broker
    |-- scheduled automations (timer → existing conversation)
    `-- provider adapter
            `-- Claude Code subprocess

optional authenticated clients
    |-- Sekai Chisei API: policy, evidence, provenance, audit
    |-- Tenkai API: releases, plans, deployments, recovery
    `-- Aldunis gateway: enterprise identity and tenant context
```

The browser never receives provider credentials or unrestricted filesystem
access. The local host binds to loopback by default and resolves every
repository operation against an explicitly opened root.

Timer-only automations (interval or cron into an existing conversation) run
inside the host process. See
[scheduled automations](decisions/scheduled-automations.md). The host must stay
running for schedules to fire; there is no external trigger surface in v1.

Remote workbench access is not an exception to the loopback default. The
[remote workbench recommendation](remote-workbench.md) permits a separate,
explicitly launched authenticated server on either a selected private LAN
HTTPS listener with explicitly supplied key material or loopback behind Tailscale
Serve. Proof-key-bound revocable device sessions supply application authority. Direct public HTTP, ambient
private-network trust, and a public workbench listener are not approved.

## Ownership

| Concern | Authority |
| --- | --- |
| Local projects, worktrees, provider sessions, approvals, diffs | Aldunis Code |
| Governance, policy, evidence, provenance, usage, audit | Sekai Chisei |
| Releases, environments, plans, deployments, rollback | Tenkai |
| Enterprise tenants, sessions, commercial access, composition | Aldunis Platform |

Displayed remote data is a projection. Mutations go to the owning service
through a versioned authenticated contract.

## Security invariants

- Loopback is the default and no network bind is implicit.
- Provider and product credentials remain server-side or in the provider's
  supported local credential store.
- Named provider profiles may store sensitive environment values in Aldunis
  Code's restricted server-side secret store. Persisted profile metadata and
  browser responses contain only redacted presence markers. Claude
  authentication remains owned by Claude Code; deleting a profile removes
  Aldunis-owned environment secrets but never deletes Claude-owned credentials
  or configuration directories.
- A repository root is explicit; paths are canonicalized and constrained to it.
- Conversation worktrees are coordinated by the local host through a
  [typed preview-and-approve boundary](decisions/managed-conversation-worktrees.md);
  providers cannot silently create or rebind them.
- Cross-provider continuation uses an
  [explicit conversation fork](decisions/cross-provider-conversation-forks.md);
  native sessions remain provider-bound and only a reviewed allowlisted
  manifest crosses the boundary.
- Tool calls are typed, rendered before approval, and audited locally without
  storing secrets.
- Approval scope is no broader than one described action unless the user
  explicitly creates a durable rule.
- Unknown provider events and incompatible contract versions fail closed.
- No integrated general-purpose terminal is exposed.
- Repository selection follows the split accepted for
  [Issue #35](https://github.com/Sannrox/aldunis-code/issues/35): a path-only
  native desktop picker or a
  server-backed local web browser. Web browsing starts from explicit canonical
  roots, returns directory metadata only, rejects symlinks and mount crossings,
  and enforces depth, entry, latency, cancellation, and concurrency limits.
  Remote clients receive no filesystem enumeration capability until an
  authenticated directory-grant design is accepted.

## Declarative provider adapter trust

The [accepted adapter decision](https://github.com/Sannrox/aldunis-code/issues/49#issuecomment-5062009517)
separates user-selected trust from Aldunis-enforced integrity. The user decides
whether to trust an adapter source, its claimed publisher, and its provider
executable. Aldunis does not endorse that publisher.

Version 1 adapter packages are code-free manifests pinned to the SHA-256 digest
shown during approval. Aldunis validates the complete schema, compatibility,
fixed arguments, named environment references, and executable discovery rules;
unknown fields, generic interpreters, command launchers, positional arguments,
argument values, and inline code fail closed. Version 1 fixed arguments are
option flags only. Material updates require a new explicit approval and retain
one prior validated manifest for rollback.
Because Aldunis threads are multi-turn, version 1 adapters and the negotiated
ACP runtime must support session resume; incompatible providers fail visibly.

Adapters run only through Aldunis-owned, versioned ACP JSON-RPC stdio handling.
The host launches an explicit or safely discovered provider executable without a
shell, with the canonical conversation worktree as its working directory and a
bounded environment. The native provider process still runs with the local OS
user's authority and is not an operating-system sandbox; installation approval
therefore names this unrestricted process boundary explicitly. Users must trust
the selected provider executable, not only its adapter manifest.
Declared capabilities are descriptive inputs to the runtime and cannot grant
filesystem, terminal, network, credential, MCP, or tool authority. Disabling,
rollback, and uninstall modify only Aldunis-owned adapter metadata and never
provider-owned binaries, credentials, configuration, or conversation history.
Adapter administration is disabled for the entire host while remote mode is
active. The user returns to the default loopback-only mode to install, update,
enable, disable, roll back, or uninstall adapters.

## Delivery sequence

1. Original navigable application shell and domain information architecture.
2. Local host with repository/worktree discovery and constrained file access.
3. Claude Code adapter with normalized streaming events.
4. Permission broker and changed-file/diff workflows.
5. Sekai Chisei read-only evidence and policy integration.
6. Tenkai delivery views through its authenticated API.
7. Optional Aldunis enterprise session and tenant composition.
