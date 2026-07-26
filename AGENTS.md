# Repository guidelines

`aldunis-code` is the local-first agentic development workbench in the Aldunis
product family. It is private during early development but must remain suitable
for later open-source publication.

## Product boundary

- This repository owns the local application shell, repository and worktree
  coordination, provider subprocess adapters, conversations, tool presentation,
  local approval UX, and changed-file/diff views.
- Claude Code is the first provider. Provider-specific behavior stays behind a
  provider adapter; Codex CLI and other providers must not distort the core
  conversation model.
- There is no integrated general-purpose terminal. Provider tools may execute
  commands through explicit, inspectable permission flows.
- Public `Sannrox/sekai-chisei` owns governance, policy, evidence, provenance,
  routing, usage, and audit.
- Public `Sannrox/tenkai` owns releases, environments, delivery plans,
  deployments, rollback, and recovery.
- Private `Sannrox/aldunis-platform` owns enterprise tenant identity, sessions,
  commercial behavior, and browser-facing composition.
- Cross-product screens are clients of authenticated contracts. They never
  share databases, accept caller-selected tenant authority, or turn cached
  projections into domain authority.

Read `docs/architecture.md` and `docs/work-lifecycle.md` before changing a
boundary.

## Engineering rules

- Keep the application loopback-only by default.
- Never commit credentials, provider transcripts, customer code, repository
  contents, unredacted logs, local databases, or generated runtime state.
- Treat repository paths, source text, prompts, tool inputs, tool outputs, and
  diffs as sensitive local data.
- Require explicit, scoped approval for mutating provider tools. Do not hide
  command execution behind generic loading states.
- Keep provider adapters replaceable and normalize events at the boundary.
- Prefer semantic HTML, keyboard navigation, visible focus, reduced-motion
  support, and deterministic tests.
- Preserve the no-terminal product constraint.

## Work lifecycle

GitHub Issues are the backlog. Use exactly one status label:
`status:triage`, `status:ready`, or `status:blocked`. Keep one Issue aligned
with one PR and one observable outcome. Cross-repository dependencies use
fully qualified references.

Use rebase merges and delete merged branches. Branches created by agents use
the `codex/` prefix.

## Reference repos

- Open-source T3 Code repo: https://github.com/pingdotgg/t3code

Use these as implementation references when designing protocol handling, UX
flows, and operational safeguards.

## Repository skills

- `route-code-work` — route work to Aldunis Code or the owning product.
- `assess-code-impact` — map provider, local-data, UX, contract, and security impact.
- `deliver-code-issue` — deliver one dependency-ready Issue through a PR.
- `verify-code-change` — run proportionate UI, provider, contract, and security checks.
- `capture-code-decision` — preserve accepted architecture outcomes.

Before committing work delivered through `deliver-code-issue`, run the **global**
`autoreview` helper (for example
`$HOME/.grok/skills/autoreview/scripts/autoreview`, with
`$HOME/.agents/...` or `$HOME/.claude/...` as fallbacks). Do not vendor
`autoreview` into this repository. Deterministic verify and live UI stress
complement it; they do not replace it.

