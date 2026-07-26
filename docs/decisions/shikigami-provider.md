# Shikigami as an Aldunis Code provider

- Status: Accepted
- Date: 2026-07-26

## Context

Shikigami is the Aldunis headless agent harness (library + CLI). Aldunis Code is
the local workbench UI and owns conversations, worktrees, approvals chrome, and
provider subprocess lifecycle. Code must not embed shikigami’s turn loop or own
plane policy.

Providers already include Claude Code (native), Codex CLI (native protocol), and
declarative ACP adapters (Kiro, Grok Build). Shikigami does not speak ACP today.

## Decision

Integrate shikigami as a **first-class subprocess provider** (`provider: "shikigami"`):

1. Discover via `shikigami version` (major `1.x` required).
2. Start runs by spawning `shikigami --config … --state … run …` with a
   generated local config (workspace = selected worktree; tools filtered by
   ask/plan/build mode).
3. Stream harness progress from the `stderr` event sink
   (`[shikigami] {json}`) into Code’s normalized `ProviderEvent` stream.
4. Prefer model adapter `http` when an API key is present (`OPENAI_API_KEY` or
   `SHIKIGAMI_API_KEY_ENV`); otherwise offline `scripted` for readiness demos.
5. Do **not** require an ACP surface or in-process Rust embed for the first
   integration.
6. **No mutating tools in v1** of the adapter. Shikigami does not pause for
   Code’s PermissionBroker mid-turn; enabling write/edit/apply_patch would
   bypass the workbench approval contract. Read/search/report/todo only until
   a pre-exec approval bridge exists.
7. **Each Code message is a new harness run** (not checkpoint `--resume`).
   Park recovery remains CLI-side for now.
8. Governance defaults to `local`; operators may set `SHIKIGAMI_GOVERNANCE_ADAPTER`
   / `SHIKIGAMI_FAIL_CLOSED` (and plane endpoint env) for governed profiles.

## Consequences

- Operators need the `shikigami` binary on `PATH` (tenkai/GitHub Release).
- Park/resume is reported as a failed terminal with CLI resume guidance until
  Code grows a park-answer UX.
- Mutating coding work still prefers Claude/Codex until shikigami approval is
  wired; this path proves conversation + harness event integration first.
- MCP and ACP remain available later if product needs them; they are not the
  default Code path.
- Freeze-core for shikigami stays in the shikigami crate; Code only depends on
  the CLI + stderr event contract.
