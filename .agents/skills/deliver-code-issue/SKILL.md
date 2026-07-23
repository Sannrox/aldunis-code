---
name: deliver-code-issue
description: Deliver one explicitly selected, dependency-ready Aldunis Code Issue through implementation and a ready pull request. Use when asked to build or publish one local workbench outcome.
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
5. Use `verify-code-change`, inspect the diff for secrets and captured local
   data, and resolve actionable review findings.
6. Stage only intended paths, commit, push, and open a ready PR that closes the
   Issue and records exact evidence and skipped checks.

## Output

Report the Issue, branch, commit, PR, outcome, verification, blockers, and
remaining uncertainty. This skill does not authorize merging, releases,
publishing packages, or changing another repository.

