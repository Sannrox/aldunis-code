# Shikigami as an Aldunis Code provider

- Status: Accepted
- Date: 2026-07-26
- Updated: 2026-08-03 (native parked-run resume in Code)

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
   private per-run overlay. The built-in `default:shikigami` profile reads
   Shikigami's native config search order; a user-created Shikigami profile
   may provide an explicit config path. The overlay never edits the source
   file and preserves provider-owned model, governance, network, context, and
   run settings while Code owns the selected inplace workspace, mode tool
   allow-list, stderr events, bounded turns, and PermissionBroker hook.
3. Stream harness progress from the `stderr` event sink
   (`[shikigami] {json}`) into Code’s normalized `ProviderEvent` stream.
4. Respect the native model adapter and its configured model/API-key settings;
   environment variables remain the higher-precedence override. With no native
   model configuration, prefer `http` when an API key is present
   (`OPENAI_API_KEY` or `SHIKIGAMI_API_KEY_ENV`); otherwise use offline
   `scripted` for readiness demos.
5. Do **not** require an ACP surface or in-process Rust embed for the first
   integration.
6. **Mutating tools require PermissionBroker pre-exec.** Build mode may enable
   `write_file`, `edit`, `multi_edit`, `apply_patch`, `bash`, and
   `bash_background`. Each invocation is gated by a fail-closed shikigami
   `pre_tool` hook that calls Code’s local permission request endpoint (same
   allow-once / deny / cancel / expiry contract as Claude). Ask and Plan stay
   non-mutating. Mode selection alone is not a substitute for approval.
7. **Each ordinary Code message is a new harness run.** Parked input is the
   exception: with Shikigami **1.0.5+**, Code uses the native checkpoint
   `--resume <run-id> --answer-file <protected-file>` operation only after
   binding the exact request, conversation, turn, worktree, and baseline
   checkpoint. Answers remain transient, fresh PermissionBroker approvals are
   required, and missing or stale capability fails closed as an explicit
   unavailable state.
8. Pass the user prompt via `run --task-file` (file under the host run state dir),
   not argv, so prompts do not appear in the process table.
9. Preserve native governance/profile settings. With no native config,
   governance defaults to `local`; operators may set
   `SHIKIGAMI_GOVERNANCE_ADAPTER` / `SHIKIGAMI_FAIL_CLOSED` (and plane endpoint
   env) for governed profiles.
10. When the effective governance adapter is `sekai-chisei`, Code waits for
    Shikigami's provider-confirmed run UUID and persists a metadata-only direct
    correlation with `operation_id = run_id`. It is labeled **direct governed**,
    never admitted or claimed. Conflicting or malformed identities fail visibly.

## Consequences

- Operators need the `shikigami` binary on `PATH` (tenkai/GitHub Release).
- Native parked-run resume requires Shikigami 1.0.5+ and a provider-confirmed
  run UUID. Code never tracks an unowned process after restart; the UI reports
  unavailable and the operator can start a fresh run.
- Pre-tool approval waits are capped by shikigami’s hook `timeout_ms` max (120s).
- MCP and ACP remain available later if product needs them; they are not the
  default Code path.
- Freeze-core for shikigami stays in the shikigami crate; Code only depends on
  the CLI + stderr event contract + settings hooks.
- Correlation receipts retain only provider, thread/turn, run/operation IDs,
  governance mode, and creation time. Conversation and project deletion remove
  them with the owning history.
