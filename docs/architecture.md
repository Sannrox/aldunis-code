# Architecture

## Purpose

Aldunis Code is a local-first workbench for agent-assisted software
development. Its core interaction is a structured conversation attached to an
explicit repository and worktree, with inspectable tool activity, approvals,
and diffs.

## Topology

```text
local browser UI  (loopback)
    |
local Aldunis Code host
    |-- repository and worktree adapter
    |-- normalized conversation / event store
    |-- permission broker
    |-- scheduled automations (timer → existing conversation)
    |-- product availability (Code always; planes if configured)
    `-- provider adapters
            |-- Claude Code (profiles)
            |-- Codex CLI
            |-- Shikigami (harness; optional Chisei governance)
            `-- declarative ACP (Kiro, Grok Build, OpenCode, …)

optional product clients (projections only)
    |-- Sekai / Chisei: knowledge + governance APIs
    `-- Tenkai: delivery APIs
```

The browser never receives provider credentials or unrestricted filesystem
access. The local host binds to loopback by default and resolves every
repository operation against an explicitly opened root.

**Governed agent path (product direction):** UI surfaces for governance show
**Chisei projections** only. The local harness for plane-governed work is
**Shikigami**, which invokes tools and Chisei contracts. Direct Claude/Codex/ACP
routes remain available without claiming Chisei coverage.

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
- Chisei project views follow the
  [server-owned projection decision](decisions/chisei-project-projections.md):
  the host derives namespace authority from a loopback-administered local
  project binding, keeps endpoint credentials server-side, and exposes only a
  bounded read projection.
- Tool calls are typed, rendered before approval, and audited locally without
  storing secrets.
- Approval scope is no broader than one described action unless the user
  explicitly creates a durable rule.
- Delegated parent controls follow the
  [delegated human control decision](decisions/delegated-human-control.md):
  explicit parent-to-child relationships form an acyclic forest, and the parent
  is a beta-gated control surface while approval and input authority remain
  single-use and bound to the originating child.
- Unknown provider events and incompatible contract versions fail closed.
- Local candidate-to-release delivery follows the accepted capability-linked
  handoff: Code owns only the content-bound candidate and correlation ledger;
  Chisei owns evaluation and signed provenance; Tenkai owns release, plan,
  apply, health, rollback, and recovery truth. Every mutation has a single-use
  preview and every foreign identifier is reconciled before the workflow
  advances.
- No integrated general-purpose terminal is exposed.
- Repository selection follows the split accepted for
  [Issue #35](https://github.com/Sannrox/aldunis-code/issues/35): a path-only
  native desktop picker or a
  server-backed local web browser. Web browsing starts from explicit canonical
  roots, returns directory metadata only, rejects symlinks and mount crossings,
  and enforces depth, entry, latency, cancellation, and concurrency limits.
  Remote clients receive no filesystem enumeration capability until an
  authenticated directory-grant design is accepted.
- Context-package folder pins follow the bounded v1 decision recorded in
  [Issue #322](https://github.com/Sannrox/aldunis-code/issues/322):
  the host resolves at most 100 non-ignored files and 2 MiB per turn, rejects
  symlinks and repository boundaries, and stores immutable metadata receipts
  rather than duplicate source content. Pins are conversation-scoped. Remote
  folder pinning stays unavailable until an authenticated repository grant
  supplies that authority.

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

## Provider surface (shipped)

| Kind | Providers |
| --- | --- |
| Native profiles | Claude Code |
| Native discovery | Codex CLI |
| First-class harness | Shikigami (PermissionBroker pre-exec in Build) |
| Reviewed ACP packages | Kiro CLI, Grok Build CLI, OpenCode |

See [providers.md](providers.md) for operator detail and
[decisions/](decisions/README.md) for adapter and harness decisions.

## Delivery sequence (historical)

1. Navigable application shell and domain information architecture.
2. Local host with repository/worktree discovery and constrained file access.
3. Claude Code adapter with normalized streaming events.
4. Permission broker and changed-file/diff workflows.
5. Multi-provider: Codex, declarative ACP, Shikigami.
6. Automations, checkpoints, remote workbench, desktop shell.
7. Sekai / Chisei / Tenkai product clients via authenticated contracts (in progress;
   planes disabled in the switcher until configured).
8. Optional Aldunis enterprise session and tenant composition.

## Related guides

- [Getting started](getting-started.md)
- [Local data](local-data.md)
- [Automations](automations.md)
- [Remote workbench](remote-workbench.md)
- [Workspace checkpoints](workspace-checkpoints.md)
