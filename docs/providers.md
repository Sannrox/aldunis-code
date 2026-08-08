# Providers

Aldunis Code runs coding agents as **local subprocesses**. Each provider is
adapted into a shared conversation, approval, and history model. Threads are
bound to a provider: you cannot silently resume a Claude conversation as Codex.

## Authority modes

Conversations use **Ask**, **Plan**, or **Build**:

| Mode  | Mutations                                            |
| ----- | ---------------------------------------------------- |
| Ask   | Read-oriented; mutations declined                    |
| Plan  | Planning; mutations declined                         |
| Build | Mutating tools require **explicit, scoped approval** |

Approvals are allow-once, bound to conversation, repository, worktree, and tool
call. There is no integrated general-purpose terminal.

From a beta-enabled parent conversation, a human can start an independent
child with a focused prompt. The child uses the selected provider adapter and
its own provider session. A new managed worktree is the default and is
required for Build; Ask and Plan may explicitly share the parent worktree.
This is a host/UI operation, not an autonomous provider capability, and no
parent transcript or provider state is transferred.

## First-class providers

### Provider profiles

Every first-class provider and every **installed** declarative adapter has a
stable **default profile** (Settings → Provider profiles). Defaults may be
empty: binary on `PATH`, no home override, no env. Deleting a default re-seeds
it on the next list. Installing or updating an adapter creates
`default:adapter:<package-id>` with required/sensitive env slots from the
manifest (values remain empty until you set them).

The Electron desktop hydrates a bounded, non-secret environment from the
user's login shell before starting the local host. This keeps provider
discovery and provider subprocesses aligned with the CLI environment when the
desktop app is launched outside a shell. A profile may still use an absolute
binary path when a provider is installed in a non-standard location.

Sensitive environment values live in the host secret store (write-only in the UI).

### Composer commands, skills, and files

The composer keeps these entry types distinct, matching the selected provider:

- "/" lists Aldunis built-in commands and commands in the selected provider capability projection, grouped as **Built-in** and **Provider**. Claude Code currently advertises provider commands; other providers show built-ins until their adapter exposes normalized command metadata.
- "$" lists enabled provider skills.
- "@" searches bounded repository files that can be attached as conversation context.

Selecting an entry only inserts the typed prompt token or adds a local context
pin. It never executes a general-purpose terminal command; provider tools remain
inside the normal inspectable approval flow.

Provider-emitted thinking is normalized at the adapter boundary but hidden by
default. Settings → General can enable its live display for the current
in-memory timeline; thinking is not persisted, restored, or transferred across
provider forks.

### Work Graph (Beta)

When a conversation has a provider-reported plan or normalized provider
activity, the conversation top bar exposes an opt-in **Graph β** panel. It is a
read-only derived view with two explicit lanes: provider-reported plan intent
and Aldunis-observed tools, approvals, inputs, and terminal outcomes. It does
not infer hidden provider reasoning, execute graph nodes, or change approval,
filesystem, provider, or persistence authority. Missing relationships remain
explicitly approximate while the feature is in beta; the ordinary Plan card
remains the source for provider plan content.

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
- In the desktop application, Codex can use the Aldunis shared loopback
  browser. The MCP server is injected into the Codex app-server process only
  for that conversation; the operator must open the shared browser and enable
  **Allow agent control** before mutations are accepted.

### Shikigami

First-class harness provider (`provider: "shikigami"`). Seeds
`default:shikigami`. Requires **shikigami 1.0.2+** on `PATH`
(`inplace` workspace + `--task-file`).

Parked Shikigami questions normalize to a bounded Aldunis input request.
With Shikigami **1.0.5+**, Code resumes the provider-confirmed parked run with
native `--resume <run-id> --answer-file <protected-file>`. Code binds the
request to the exact conversation, turn, run UUID, repository, worktree, and
baseline checkpoint; the answer is transient and never copied into durable
history or parent context. Resume starts a fresh PermissionBroker scope, so
approvals are never replayed. If the installed binary cannot prove native
resume support, or the host restarts before the resume starts, Code shows an
explicit unavailable state rather than tracking an unowned process. The
child-conversation and parent-coordination cards use the same route.

Shikigami 1.0.5+ is required for live model catalog discovery. Aldunis Code
invokes the read-only 'doctor --models --json' command for governed profiles
and presents the models currently advertised by Sekai-Chisei, including the
synthetic 'auto' route. Older Shikigami versions or unavailable governance
leave the configured model visible as a bounded fallback.

- The built-in Shikigami profile uses Shikigami's native config resolution:
  `SHIKIGAMI_CONFIG`, `$SHIKIGAMI_STATE/shikigami.toml`, then the selected
  worktree's `shikigami.toml`. A user-created Shikigami profile may provide an
  explicit config path. Code never edits the source config; it creates a
  private per-run overlay that preserves model, governance, network, context,
  and other provider settings while enforcing the selected worktree, Code's
  mode tool allow-list, stderr events, bounded turns, and the local approval
  hook. Native MCP definitions are not imported implicitly.
- Progress is streamed from stderr events (`[shikigami] {…}`).
- Build-mode mutating tools are gated by a fail-closed `pre_tool` hook into the
  PermissionBroker (same allow-once contract as other providers).
- Discovery reports an operator-facing readiness `detail` when the binary is
  missing, the version is unsupported, or a forced HTTP model adapter has no
  API key. The composer surfaces that copy instead of a generic “not ready”.
- Parked questions remain actionable in the child conversation and, when beta
  delegation is enabled, from the exact parent-child coordination card.
- With no native config, governance defaults to `local`; operators may point
  `SHIKIGAMI_GOVERNANCE_ADAPTER` at `sekai-chisei` for plane-governed runs.
- Governed direct runs display a **Direct governed** correlation after
  Shikigami confirms its run UUID. Code enforces `operation_id = run_id`; this
  is inspection metadata, not evidence of Action admission or effect claim.
- Design record: [decisions/shikigami-provider.md](decisions/shikigami-provider.md).

### Enterprise-managed hosted Shikigami

The explicit managed hosted profile is separate from local Shikigami
configuration. It requires Shikigami **1.0.5+** and is selected by the Code
host only after the gateway assertion and operator configuration pass
validation. The browser receives no provider, profile, model, mode, adapter,
executable, endpoint, credential, or arbitrary repository controls.

Every managed run is Build with:

```toml
[profile]
name = "aldunis-code-managed"

[model]
adapter = "plane"
model = "<operator-approved logical model>"

[governance]
adapter = "sekai-chisei"
fail_closed = true
endpoint = "<operator-controlled Chisei endpoint>"
principal = "<managed Shikigami service principal>"
namespace = "<operator namespace>"
token_env = "SEKAI_TOKEN"
```

The managed subprocess receives only a deterministic runtime environment,
the configured Chisei token, and dedicated run directories. It does not
inherit provider, platform, source-control, proxy, or unrelated host-home
credentials. Its Build allowlist retains read/report/file-mutation tools but
excludes shell and background-shell tools so the governance token cannot be
read by an agent-controlled command. The hosted alpha preserves the existing
streamed Shikigami status/tool/approval/cancel/checkpoint/diff flow, but it is
not an OS sandbox.
See [the managed hosted workbench decision](decisions/managed-hosted-workbench.md).

## Reviewed declarative ACP adapters

Version 1 adapters are **code-free manifests** pinned by SHA-256 digest.
Install from **Provider adapters → Reviewed adapters**. You still need the
provider binary on `PATH`. Aldunis does not bundle provider credentials or
rewrite provider-owned config.

| Package          | Launch             | Notes                                                   |
| ---------------- | ------------------ | ------------------------------------------------------- |
| `kiro-cli`       | `kiro-cli acp`     | Direct-only ACP                                         |
| `grok-build-cli` | `grok agent stdio` | Direct-only ACP; reviewed shared-browser MCP capability |
| `opencode-cli`   | `opencode acp`     | Direct-only ACP                                         |

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
- The reviewed Grok package can receive the same Aldunis shared loopback
  browser MCP server as Codex. Aldunis supplies it through the ACP session
  `mcpServers` list; other reviewed adapters retain their provider-owned MCP
  configuration and do not receive browser control.

Design notes:

- [opencode-declarative-adapter.md](decisions/opencode-declarative-adapter.md)
- Architecture section on [adapter trust](architecture.md#declarative-provider-adapter-trust)

## Cross-provider forks

Continuing work on another provider requires an **explicit conversation fork**
with a reviewed allowlisted context transfer—not silent session rebinding.
See [decisions/cross-provider-conversation-forks.md](decisions/cross-provider-conversation-forks.md).

## Model selection boundary

The browser model menu is presentation only. Before creating a turn, fork,
checkpoint, or provider process, the host rechecks the requested model against
the provider's current capability: Claude aliases normalize to the supported
canonical model list, Codex and Shikigami use their live readiness models, and
reviewed ACP adapters are probed for their current `session/new` model list.
`default` follows the provider-owned default path (Claude keeps its implicit
default; other providers use their advertised default) and the effective model
selection is stored on the conversation before launch. A stale selection or
unavailable capability returns a bounded refreshable conflict; the host never
silently falls back to a different model. Automation and provider continuation
use the same run boundary, so a persisted selection cannot bypass a later
capability change.

## Credentials and secrets

| Data                   | Where it lives                               |
| ---------------------- | -------------------------------------------- |
| Provider login / OAuth | Provider-owned local store                   |
| Profile env secrets    | Aldunis host secret store (owner-only files) |
| Browser                | Redacted presence markers only               |

Never commit credentials, provider transcripts, or unredacted logs.

## Failure posture

- Incompatible provider versions → visible failure, no silent downgrade.
- Unknown protocol messages → fail closed.
- Adapter admin is **disabled** while remote mode is active; return to loopback
  to install or update adapters.
