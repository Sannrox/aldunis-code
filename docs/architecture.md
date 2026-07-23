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

Remote workbench access is not an exception to the loopback default. The
[remote workbench recommendation](remote-workbench.md) permits only a future,
explicitly launched SSH-forwarded design after an architecture/security
Discussion accepts its pairing, approval, revocation, and recovery boundaries.
Direct remote HTTP, private-network trust, and a public workbench listener are
not approved.

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
- Tool calls are typed, rendered before approval, and audited locally without
  storing secrets.
- Approval scope is no broader than one described action unless the user
  explicitly creates a durable rule.
- Unknown provider events and incompatible contract versions fail closed.
- No integrated general-purpose terminal is exposed.

## Delivery sequence

1. Original navigable application shell and domain information architecture.
2. Local host with repository/worktree discovery and constrained file access.
3. Claude Code adapter with normalized streaming events.
4. Permission broker and changed-file/diff workflows.
5. Sekai Chisei read-only evidence and policy integration.
6. Tenkai delivery views through its authenticated API.
7. Optional Aldunis enterprise session and tenant composition.
