---
name: deliver-ready-issue
description: >
  Deliver one explicitly selected, dependency-ready Aldunis Code Issue through
  implementation and a ready pull request in an isolated worktree lane. Use
  when asked to build or publish one local workbench outcome, or to run several
  ready Issues as parallel lanes.
---

# Deliver Ready Issue

Keep the Issue as planning truth and the PR as implementation truth.

One run of this Skill is one delivery lane: one Issue, one claim branch
`<type>/<issue>` on GitHub, one worktree, one Pull Request, one owner. Claims
live on GitHub because lanes may run on different machines; worktrees only
isolate lanes that share a machine. To deliver several ready Issues at once,
the lead follows [references/parallel-delivery.md](references/parallel-delivery.md)
and runs this Skill once per lane. [scripts/issue-lane.sh](scripts/issue-lane.sh)
inspects, claims, and releases a lane deterministically.

## Procedure

1. Read `AGENTS.md`, the selected Issue, its dependency section, linked
   decisions, and live overlapping PRs in every referenced repository. Stop if
   a predecessor is unresolved or implementation overlaps.
2. Check the claim state on GitHub, the only state other machines share:

   ```sh
   bash .agents/skills/deliver-ready-issue/scripts/issue-lane.sh check <issue>
   ```

   It reports open Pull Requests referencing the Issue, claim branches
   (`<type>/<issue>`, `*/<issue>-*`), assignees with the assignment age, and
   a verdict; exit code 3 is `claimed`. A claim means another lane owns the
   Issue: continue only when the user directs the takeover, and preserve the
   existing branch, Pull Request, and evidence first. Never work around a lost
   claim race with a differently named branch.

3. Inspect `git status -sb` and `git worktree list`. Preserve every unrelated
   change, branch, worktree, and running process. Never switch, reset, stash,
   or clean the primary checkout or another lane's worktree. Claim the Issue
   on GitHub, then check the claim branch out in the lane worktree:

   ```sh
   bash .agents/skills/deliver-ready-issue/scripts/issue-lane.sh claim <issue>
   git fetch --prune origin
   git worktree add --track -b <type>/<issue> .worktrees/issue-<issue> origin/<type>/<issue>
   git -C .worktrees/issue-<issue> rev-parse HEAD
   ```

   Do all further work inside that worktree. Exit code 3 from `claim` means
   another machine won the race: stop and report.

4. Use `assess-code-impact`; translate acceptance evidence into UI, provider,
   permission, local-data, contract, packaging, security, and recovery duties.
5. Implement one outcome within Aldunis Code's authority. Keep provider
   behavior behind adapters and remote product behavior behind authenticated
   clients. Preserve loopback defaults and the no-terminal constraint.
6. Verify and review before any commit:
   1. Run `verify-code-change` and retain exact commands, results, skips, and
      residual uncertainty.
   2. Inspect the final diff for secrets, provider transcripts, customer code,
      absolute private paths, local databases, and unredacted logs.
   3. Run structured `autoreview` before committing (see below). Fix accepted
      findings and rerun the relevant checks until no material finding remains
      or a documented blocker requires maintainer judgment.
7. Stage only intended paths and create a narrow imperative commit. Never use
   `--no-gpg-sign`; if signing fails, stop and fix GPG. Immediately before
   publishing, run `git fetch --prune origin` and
   `git merge-base --is-ancestor origin/main HEAD`.
8. Publish to the existing claim branch with **GitHub-verified** commits via
   `scripts/gh-verified-push.sh` (GraphQL `createCommitOnBranch`), not a plain
   `git push`, unless the user explicitly asks for git-protocol push:
   - Existing claim branch:
     `scripts/gh-verified-push.sh --branch <type>/<issue> --sync-local`
   - Confirm `verification.verified=true` and hosted blob content matches local
     `HEAD`.
     Open the Pull Request as a draft with the first published commit, then mark
     it ready (`gh pr ready`) when verification and review are complete. The PR
     closes the Issue and records exact verification evidence, autoreview
     outcome, skipped checks, and the lane brief (agent, machine, base SHA,
     authority ceiling).
9. When the user authorizes land: re-publish review fixes with
   `scripts/gh-verified-push.sh`, then prefer
   `gh pr merge --squash --delete-branch` (do not use GitHub rebase-merge when
   Verified history matters). After the merge, remove the local lane:

   ```sh
   git worktree remove .worktrees/issue-<issue>
   git branch -D <type>/<issue>
   git worktree prune
   ```

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

| Work state                         | Command                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Uncommitted local edits            | `"$AUTOREVIEW" --mode local`                                                                                                       |
| Committed branch / open PR         | Resolve PR base (`gh pr view --json baseRefName`), then `"$AUTOREVIEW" --mode branch --base origin/<base>` (default `origin/main`) |
| Already on clean `main` after land | `"$AUTOREVIEW" --mode commit --commit HEAD`                                                                                        |

Default engine is Codex. Do not skip autoreview because UI stress, unit tests,
or self-review already ran — those are complementary, not substitutes. Treat
helper output as advisory: verify each accepted finding in the real code, fix
scoped bugs, and rerun until the helper exits 0 with no accepted/actionable
findings (or document a conscious rejection).

If no global helper is installed, stop and report that autoreview is unavailable
rather than inventing a substitute review.

## Output

Report the Issue, claim branch, worktree, base SHA, commit, PR, outcome,
verification commands, autoreview command and result, blockers, and remaining
uncertainty. This skill does not authorize merging, releases, publishing
packages, or changing another repository unless the user explicitly raises the
authority ceiling to land.

## Boundaries

- Deliver only the selected Issue; do not choose project priority.
- Work only inside your lane worktree. Never switch, reset, stash, or clean the
  primary checkout or another lane's worktree, and never delete a worktree or
  branch you do not own.
- Never work around a lost claim race with a differently named branch, a
  forced ref update, or by removing another lane's assignment.
