# Shikigami as an Aldunis Code provider

- Status: Accepted
- Date: 2026-07-26
- Updated: 2026-07-30 (#208 governed direct-run correlation)

## Context

Shikigami is the Aldunis headless agent harness (library + CLI). Aldunis Code is
the local workbench UI and owns conversations, worktrees, approvals chrome, and
provider subprocess lifecycle. Code must not embed shikigami’s turn loop or own
plane policy.

Providers already include Claude Code (native), Codex CLI (native protocol), and
declarative ACP adapters (Kiro, Grok Build). Shikigami does not speak ACP today.

## Decision

Integrate shikigami as a **first-class subprocess provider** (`provider: "shikigami"`):

1. Discover via `shikigami version` (**1.0.2+** required: `inplace` workspace + `--task-file`).
2. Start runs by spawning `shikigami --config … --state … run …` with a
   generated local config (workspace = selected worktree; tools filtered by
   ask/plan/build mode).
3. Stream harness progress from the `stderr` event sink
   (`[shikigami] {json}`) into Code’s normalized `ProviderEvent` stream.
4. Prefer model adapter `http` when an API key is present (`OPENAI_API_KEY` or
   `SHIKIGAMI_API_KEY_ENV`); otherwise offline `scripted` for readiness demos.
5. Do **not** require an ACP surface or in-process Rust embed for the first
   integration.
6. **Mutating tools require PermissionBroker pre-exec.** Build mode may enable
   `write_file`, `edit`, `multi_edit`, `apply_patch`, `bash`, and
   `bash_background`. Each invocation is gated by a fail-closed shikigami
   `pre_tool` hook that calls Code’s local permission request endpoint (same
   allow-once / deny / cancel / expiry contract as Claude). Ask and Plan stay
   non-mutating. Mode selection alone is not a substitute for approval.
7. **Each Code message is a new harness run** (not checkpoint `--resume`).
   Park recovery remains CLI-side for now.
8. Pass the user prompt via `run --task-file` (file under the host run state dir),
   not argv, so prompts do not appear in the process table.
9. Governance defaults to `local`; operators may set `SHIKIGAMI_GOVERNANCE_ADAPTER`
   / `SHIKIGAMI_FAIL_CLOSED` (and plane endpoint env) for governed profiles.
10. When the effective governance adapter is `sekai-chisei`, Code waits for
    Shikigami's provider-confirmed run UUID and persists a metadata-only direct
    correlation with `operation_id = run_id`. It is labeled **direct governed**,
    never admitted or claimed. Conflicting or malformed identities fail visibly.

## Consequences

- Operators need the `shikigami` binary on `PATH` (tenkai/GitHub Release).
- Park/resume is reported as a failed terminal with CLI resume guidance until
  Code grows a park-answer UX.
- Pre-tool approval waits are capped by shikigami’s hook `timeout_ms` max (120s).
- MCP and ACP remain available later if product needs them; they are not the
  default Code path.
- Freeze-core for shikigami stays in the shikigami crate; Code only depends on
  the CLI + stderr event contract + settings hooks.
- Correlation receipts retain only provider, thread/turn, run/operation IDs,
  governance mode, and creation time. Conversation and project deletion remove
  them with the owning history.
