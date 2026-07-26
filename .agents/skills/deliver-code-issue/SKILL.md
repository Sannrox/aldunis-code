---
name: deliver-code-issue
description: >
  Deliver one explicitly selected, dependency-ready Aldunis Code Issue through
  implementation and a ready pull request. Use when asked to build or publish
  one local workbench outcome.
---

# Deliver Code Issue

Keep the Issue as planning truth and the PR as implementation truth.

## Procedure

1. Read `AGENTS.md`, the selected Issue, its dependency section, linked
   decisions, and live overlapping PRs in every referenced repository. Stop if
   a predecessor is unresolved or implementation overlaps.
2. Start from current `main` on `codex/<issue>-<slug>`. Preserve unrelated
   changes.
3. Use `assess-code-impact`; translate acceptance evidence into UI, provider,
   permission, local-data, contract, packaging, security, and recovery duties.
4. Implement one outcome within Aldunis Code's authority. Keep provider
   behavior behind adapters and remote product behavior behind authenticated
   clients. Preserve loopback defaults and the no-terminal constraint.
5. Verify and review before any commit:
   1. Run `verify-code-change` and retain exact commands, results, skips, and
      residual uncertainty.
   2. Inspect the final diff for secrets, provider transcripts, customer code,
      absolute private paths, local databases, and unredacted logs.
   3. Run structured `autoreview` before committing (see below). Fix accepted
      findings and rerun the relevant checks until no material finding remains
      or a documented blocker requires maintainer judgment.
6. Stage only intended paths, commit, push, and open a ready PR that closes the
   Issue and records exact verification evidence, autoreview outcome, and
   skipped checks.

## Autoreview closeout (required)

Use the **global** autoreview helper. Do not vendor or copy the skill into this
repository.

Set the helper path once per session (first match wins):

```bash
export AUTOREVIEW="${AUTOREVIEW:-}"
if [ -z "$AUTOREVIEW" ]; then
  for candidate in \
    "$HOME/.grok/skills/autoreview/scripts/autoreview" \
    "$HOME/.agents/skills/autoreview/scripts/autoreview" \
    "$HOME/.claude/skills/autoreview/scripts/autoreview"
  do
    if [ -x "$candidate" ]; then
      export AUTOREVIEW="$candidate"
      break
    fi
  done
fi
```

Then run the matching mode:

| Work state | Command |
| --- | --- |
| Uncommitted local edits | `"$AUTOREVIEW" --mode local` |
| Committed branch / open PR | Resolve PR base (`gh pr view --json baseRefName`), then `"$AUTOREVIEW" --mode branch --base origin/<base>` (default `origin/main`) |
| Already on clean `main` after land | `"$AUTOREVIEW" --mode commit --commit HEAD` |

Default engine is Codex. Do not skip autoreview because UI stress, unit tests,
or self-review already ran — those are complementary, not substitutes. Treat
helper output as advisory: verify each accepted finding in the real code, fix
scoped bugs, and rerun until the helper exits 0 with no accepted/actionable
findings (or document a conscious rejection).

If no global helper is installed, stop and report that autoreview is unavailable
rather than inventing a substitute review.

## Output

Report the Issue, branch, commit, PR, outcome, verification commands, autoreview
command and result, blockers, and remaining uncertainty. This skill does not
authorize merging, releases, publishing packages, or changing another
repository unless the user explicitly raises the authority ceiling to land.
