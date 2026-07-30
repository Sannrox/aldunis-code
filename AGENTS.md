# Repository guidelines

`aldunis-code` is the local-first agentic development workbench in the Aldunis
product family. Keep the repository suitable for open-source collaboration:
clear boundaries, no secrets in tree, and verifiable changes.

## Product boundary

- This repository owns the local application shell, repository and worktree
  coordination, provider subprocess adapters, conversations, tool presentation,
  local approval UX, changed-file/diff views, and timer-only automations.
- Provider-specific behavior stays behind adapters. Claude Code, Codex CLI,
  Shikigami, and declarative ACP packages must not distort the core conversation
  model.
- There is no integrated general-purpose terminal. Provider tools may execute
  commands through explicit, inspectable permission flows.
- Public `Sannrox/sekai-chisei` owns governance, policy, evidence, provenance,
  routing, usage, and audit.
- Public `Sannrox/tenkai` owns releases, environments, delivery plans,
  deployments, rollback, and recovery.
- Cross-product screens are clients of authenticated contracts. They never
  share databases, accept caller-selected tenant authority, or turn cached
  projections into domain authority.
- Product switcher: Code is always available; Sekai / Chisei / Tenkai stay
  disabled until endpoints are configured (`ALDUNIS_*_ENDPOINT`).

Read [docs/architecture.md](docs/architecture.md) and
[docs/work-lifecycle.md](docs/work-lifecycle.md) before changing a boundary.

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
- Prefer documentation updates in the same change when behavior shifts.

## Work lifecycle

GitHub Issues are the backlog. Use exactly one status label:
`status:triage`, `status:ready`, or `status:blocked`. Keep one Issue aligned
with one PR and one observable outcome. Cross-repository dependencies use
fully qualified references.

### Verified commits on GitHub

Prefer publishing PR branch tips with GitHub-signed commits so GitHub shows
**Verified**:

1. Implement and commit locally as usual (`commit.gpgsign` may still apply).
2. Publish the branch tip with `scripts/gh-verified-push.sh` instead of a plain
   `git push` when you want the hosted commit Verified (OpenClaw-style GraphQL
   `createCommitOnBranch`). That path creates one server-side commit with the
   local `HEAD` tree; committer is typically **GitHub**.
3. New branch:
   `scripts/gh-verified-push.sh --create-branch-from origin/main --branch <topic> --sync-local`
4. Existing PR branch:
   `scripts/gh-verified-push.sh --branch <topic> --sync-local`
   (uses the current remote tip as `expectedHeadOid`).
5. Never pass `--no-gpg-sign` for local commits; if GPG fails, stop and fix it.
6. After publish, confirm `verification.verified=true` (the script prints this).

When merging PRs, prefer **squash** (`gh pr merge --squash --delete-branch`) so
the land commit on `main` is also GitHub-signed/Verified and history stays
linear. Avoid GitHub **rebase** merges when Verified history matters. Delete
merged branches. Branches created by agents use the `codex/` prefix.

## Documentation map

- [docs/README.md](docs/README.md) — index
- [docs/getting-started.md](docs/getting-started.md) — run locally
- [docs/providers.md](docs/providers.md) — provider matrix
- [docs/decisions/README.md](docs/decisions/README.md) — ADRs
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor guide

## Repository skills

- `route-code-work` — route work to Aldunis Code or the owning product.
- `assess-code-impact` — map provider, local-data, UX, contract, and security impact.
- `deliver-ready-issue` — deliver one dependency-ready Issue through a PR.
- `verify-code-change` — run proportionate UI, provider, contract, and security checks.
- `capture-code-decision` — preserve accepted architecture outcomes.

Before committing work delivered through `deliver-ready-issue`, run the **global**
`autoreview` helper when available (for example
`$HOME/.grok/skills/autoreview/scripts/autoreview`, with
`$HOME/.agents/...` or `$HOME/.claude/...` as fallbacks). Do not vendor
`autoreview` into this repository. Deterministic verify and live UI stress
complement it; they do not replace it.
