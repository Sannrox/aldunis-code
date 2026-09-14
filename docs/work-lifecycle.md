# Work lifecycle

## Sources of truth

- Issues define executable outcomes and dependencies.
- Discussions resolve difficult-to-reverse architecture, trust, and product decisions.
- Pull requests contain implementation and current verification evidence.
- Accepted decisions and procedures become repository documentation.

## Flow

```text
idea -> status:triage -> shaped and dependency-ready -> status:ready
     -> one branch -> verify-code-change + autoreview -> PR
     -> human/CI review -> squash merge
```

Use one status label: `status:triage`, `status:ready`, or `status:blocked`.
Assignment means active ownership. Keep one observable outcome per Issue and
one Issue per PR.

Changes to provider trust, filesystem scope, approval authority, credential
handling, remote tenant context, or product ownership require an accepted
durable decision before implementation. Use a Discussion by default; explicit
maintainer direction may instead be captured in a focused decision record.

Every PR records checks actually run and explicitly identifies skipped
provider, platform, accessibility, packaging, or security evidence. Agent
delivery closeout also records structured `autoreview` via the global helper
(command, mode, and clean/accepted findings). Deterministic verify and live UI
stress are not a substitute. Do not vendor `autoreview` into this repository.

Prefer squash merge and delete the merged branch so `main` remains linear.
When a Verified branch tip is required, follow the publishing workflow in
[AGENTS.md](../AGENTS.md#verified-commits-on-github).

## Parallel delivery lanes

A delivery lane is one Issue, one branch, one isolated checkout, one Pull
Request, and one owner. Several agents may deliver several Issues at the same
time, on one machine or on many, only as separate lanes. One Issue is never
split across lanes, and one lane never carries a second Issue.

### Claims live on GitHub

Machines cannot see each other's worktrees, so a claim is only what GitHub
shows. An Issue is claimed, and therefore active, when any of the following
exists:

1. an open Pull Request, draft or ready, that references the Issue;
2. a branch `<type>/<issue>`, or any branch matching `*/<issue>-*`;
3. the authenticated login assigned to the Issue less than six hours ago.

An assignment older than six hours with neither branch nor Pull Request is an
ownership hint, not a veto: report it and ask the maintainer before claiming.
A claim is stale once its Issue is closed or its Pull Request has merged; its
owner or the maintainer removes it. Any other takeover first preserves the
existing branch, Pull Request, and evidence and requires the maintainer's
confirmation, unless the lead of the same parallel run owns the stalled lane.

A lane claims before it implements, under Publish or Land authority or with an
explicit claim authorization under Implement, using
`.agents/skills/deliver-ready-issue/scripts/issue-lane.sh claim <issue>`:

- the branch `<type>/<issue>` is created on GitHub from the default branch by
  an atomic ref creation, so when two machines race exactly one claim
  succeeds and the other sees `claimed`;
- the authenticated login is assigned to the Issue, which shows the claim in
  the Issue list and timestamps it in the Issue timeline.

`<type>` is derived deterministically so that every machine computes the same
branch: the Conventional Commit type in the Issue title, with `bug` mapped to
`fix`; otherwise the type label (`bug` → `fix`, `enhancement` → `feat`,
`documentation` → `docs`); otherwise `chore`. Lane branches carry no slug
because the name is the claim; the Pull Request title carries the description.
Human topic branches may keep `<type>/<issue>-<slug>` and are detected as
claims by the same rule, as are legacy `codex/<issue>-<slug>` branches.

An Implement-only lane cannot claim and is invisible to other machines. Say so
in the report, or ask for claim authority before starting.

### Isolation on each machine

Local isolation protects lanes that share a machine; it is not a claim.

- Each lane checks out its claim branch in `.worktrees/issue-<issue>` inside
  the repository, ignored by Git. A fresh clone dedicated to the lane, as on a
  cloud agent, is equivalent. The base SHA is recorded in the lane report.
- The primary checkout belongs to the maintainer. Agents never switch its
  branch, reset it, stash it, or run long jobs in it while another lane is
  active.
- A worktree serves exactly one Issue. Finished lanes are removed; a worktree is
  never reused for a different Issue or renamed to hide its origin.
- Shared Git state is mutated in short, serialized slots: `git fetch --prune`,
  worktree creation and removal, local branch deletion, and merging belong to
  the lead of a parallel run or happen one lane at a time on a shared machine.
  A lane commits and publishes its own branch from its own worktree; that is
  not a shared mutation. Nobody holds a slot across implementation, test runs,
  or a remote wait.

### Limits, collisions, and landing

The three-lane limit counts claims visible on GitHub per repository: open
implementation Pull Requests plus claim branches without one. Assigned or
planned work with neither is not a running lane.

Parallel lanes must not collide. Collision surfaces in this repository are
local persistence and worktrees, provider adapters, tool-approval UX, and
authenticated Sekai, Tenkai, or Aldunis contracts. Lanes that would both
change one of these surfaces run in sequence, not in parallel.

A lane publishes its first Verified commit to the claim branch as a draft Pull
Request that closes the Issue and carries the lane brief: agent, machine, base
SHA, and authority ceiling. It marks the Pull Request ready when verification
and review are complete. Immediately before publishing, the lane fetches and
confirms that the default branch is an ancestor of its head; it refreshes onto
`main` only for a conflict, a failing gate, an explicit request, or a sibling
landing on a shared surface, not merely because `main` advanced.

Landing is sequential. After each merge, fetch, re-list open `status:ready`
Issues, and let the remaining lanes recheck `mergeable` against the new `main`.
A failed or timed-out merge response may still have merged; reconcile the
remote state before retrying.

The lead of a parallel run keeps a ledger per lane: Issue, branch, machine and
checkout, base SHA, owner, state, Pull Request, evidence, blockers, and
cleanup. Report verified outcomes, not launched work. The executable lead
procedure is `.agents/skills/deliver-ready-issue/references/parallel-delivery.md`.
