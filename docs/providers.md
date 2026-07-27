# Providers

Aldunis Code runs coding agents as **local subprocesses**. Each provider is
adapted into a shared conversation, approval, and history model. Threads are
bound to a provider: you cannot silently resume a Claude conversation as Codex.

## Authority modes

Conversations use **Ask**, **Plan**, or **Build**:

| Mode | Mutations |
| --- | --- |
| Ask | Read-oriented; mutations declined |
| Plan | Planning; mutations declined |
| Build | Mutating tools require **explicit, scoped approval** |

Approvals are allow-once, bound to conversation, repository, worktree, and tool
call. There is no integrated general-purpose terminal.

## First-class providers

### Claude Code

- Discovered / configured via **named profiles** (Settings).
- First run seeds a default profile that resolves `claude` from `PATH`.
- Optional `CLAUDE_CONFIG_DIR` and sensitive environment variables are stored in
  the host secret store (write-only in the UI).
- Deleting a profile removes Aldunis-owned secrets only—never Claude’s own
  credential directory.
- Unknown protocol events and unsupported major versions **fail closed**.

### Codex CLI

- Discovered from `PATH` as `codex` (no profile store).
- Reports install, authentication readiness, version, models, and reasoning
  efforts.
- Build-mode network and file mutations pause for scoped approval; sandbox
  escapes that cannot be confined to the selected worktree are declined.

### Shikigami

First-class harness provider (`provider: "shikigami"`). Requires **shikigami
1.0.2+** on `PATH` (`inplace` workspace + `--task-file`).

- Code generates a run config with the selected worktree as workspace.
- Progress is streamed from stderr events (`[shikigami] {…}`).
- Build-mode mutating tools are gated by a fail-closed `pre_tool` hook into the
  PermissionBroker (same allow-once contract as other providers).
- Governance defaults to `local`; operators may point
  `SHIKIGAMI_GOVERNANCE_ADAPTER` at `sekai-chisei` for plane-governed runs.
- Design record: [decisions/shikigami-provider.md](decisions/shikigami-provider.md).

## Reviewed declarative ACP adapters

Version 1 adapters are **code-free manifests** pinned by SHA-256 digest.
Install from **Provider adapters → Reviewed adapters**. You still need the
provider binary on `PATH`. Aldunis does not bundle provider credentials or
rewrite provider-owned config.

| Package | Launch | Notes |
| --- | --- | --- |
| `kiro-cli` | `kiro-cli acp` | Direct-only ACP |
| `grok-build-cli` | `grok agent stdio` | Direct-only ACP |
| `opencode-cli` | `opencode acp` | Direct-only ACP |

Rules shared by reviewed ACP adapters:

- No `--trust-all-tools` / always-approve flags.
- Mutating tool calls stay on the PermissionBroker path.
- Optional proprietary ACP extensions are ignored unless the runtime explicitly
  supports them; unknown core methods fail closed.
- Advanced import remains available for custom manifests (user-approved trust).

Design notes:

- [opencode-declarative-adapter.md](decisions/opencode-declarative-adapter.md)
- Architecture section on [adapter trust](architecture.md#declarative-provider-adapter-trust)

## Cross-provider forks

Continuing work on another provider requires an **explicit conversation fork**
with a reviewed allowlisted context transfer—not silent session rebinding.
See [decisions/cross-provider-conversation-forks.md](decisions/cross-provider-conversation-forks.md).

## Credentials and secrets

| Data | Where it lives |
| --- | --- |
| Provider login / OAuth | Provider-owned local store |
| Profile env secrets | Aldunis host secret store (owner-only files) |
| Browser | Redacted presence markers only |

Never commit credentials, provider transcripts, or unredacted logs.

## Failure posture

- Incompatible provider versions → visible failure, no silent downgrade.
- Unknown protocol messages → fail closed.
- Adapter admin is **disabled** while remote mode is active; return to loopback
  to install or update adapters.
