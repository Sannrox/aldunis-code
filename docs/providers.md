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

### Provider profiles

Every first-class provider and every **installed** declarative adapter has a
stable **default profile** (Settings → Provider profiles). Defaults may be
empty: binary on `PATH`, no home override, no env. Deleting a default re-seeds
it on the next list. Installing or updating an adapter creates
`default:adapter:<package-id>` with required/sensitive env slots from the
manifest (values remain empty until you set them).

Sensitive environment values live in the host secret store (write-only in the UI).

### Claude Code

- Uses named profiles for binary, optional `CLAUDE_CONFIG_DIR`, and env.
- First run seeds `default:claude-code` resolving `claude` from `PATH`.
- Deleting a profile removes Aldunis-owned secrets only—never Claude’s own
  credential directory.
- Unknown protocol events and unsupported major versions **fail closed**.

### Codex CLI

- Seeds `default:codex-cli` (binary `codex`); discovery still uses `PATH`.
- Keeps one app-server process alive per conversation and starts follow-up turns
  on the resident provider thread. After host or process restart, Code resumes
  from the persisted thread id; a missing provider thread falls back to a fresh
  provider thread while preserving the Aldunis conversation history.
- Accepts Codex CLI **0.80+** on the 0.x app-server line (not an exact minor
  pin). Major 1.x is fail-closed until validated.
- Reports install, authentication readiness, version, models, and reasoning
  efforts. Installed-but-not-signed-in Codex stays selectable so the composer
  can show sign-in guidance.
- Build-mode network and file mutations pause for scoped approval; sandbox
  escapes that cannot be confined to the selected worktree are declined.
- A single non-secret `request_user_input` question is normalized and resumed
  through the original app-server JSON-RPC request. Multi-question and secret
  requests fail closed until the normalized UI can preserve their distinct
  answer semantics.

### Shikigami

First-class harness provider (`provider: "shikigami"`). Seeds
`default:shikigami`. Requires **shikigami 1.0.2+** on `PATH`
(`inplace` workspace + `--task-file`).

Parked Shikigami questions normalize to a bounded Aldunis input request.
Because the current adapter does not keep a parked subprocess resumable, an
answer starts an explicitly identified follow-up turn in the same child
conversation. The answer is never copied into the parent provider context.

- Code generates a run config with the selected worktree as workspace.
- Progress is streamed from stderr events (`[shikigami] {…}`).
- Build-mode mutating tools are gated by a fail-closed `pre_tool` hook into the
  PermissionBroker (same allow-once contract as other providers).
- Discovery reports an operator-facing readiness `detail` when the binary is
  missing, the version is unsupported, or a forced HTTP model adapter has no
  API key. The composer surfaces that copy instead of a generic “not ready”.
- Parked questions remain actionable in the child conversation and, when beta
  delegation is enabled, from the exact parent-child coordination card.
- Governance defaults to `local`; operators may point
  `SHIKIGAMI_GOVERNANCE_ADAPTER` at `sekai-chisei` for plane-governed runs.
- Governed direct runs display a **Direct governed** correlation after
  Shikigami confirms its run UUID. Code enforces `operation_id = run_id`; this
  is inspection metadata, not evidence of Action admission or effect claim.
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
- **Models**: discovery probes ACP `session/new` for `models.availableModels`
  (and `configOptions` with `category: "model"`). The composer model menu lists
  those options; the selected model is applied with `session/set_model` before
  the first prompt.

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
