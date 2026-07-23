---
name: capture-code-decision
description: Promote an accepted Aldunis Code design or delivery outcome into the smallest durable repository artifact. Use after a Discussion, accepted architectural choice, or merged change establishes a rule future contributors must preserve.
---

# Capture Code Decision

Preserve only knowledge that must remain true after the work closes.

## Procedure

1. Confirm the decision is accepted through a Discussion, merged PR, or
   explicit maintainer direction. Do not convert an unresolved proposal into
   policy.
2. Read the source evidence, `AGENTS.md`, architecture, lifecycle, and affected
   implementation.
3. Choose the smallest durable destination:
   - `AGENTS.md` for short repository-wide constraints;
   - `docs/architecture.md` for ownership and runtime invariants;
   - a focused decision record for alternatives and consequences;
   - a repository skill for repeatable operational procedure;
   - tests or configuration when executable evidence is stronger than prose.
4. Link the source and state supersession rather than rewriting history.
   Remove contradictory temporary guidance in the same change.
5. Verify links, commands, and skill syntax.

## Output

Report the source decision, artifact changed, invariant preserved,
superseded guidance, verification, and unresolved follow-up. Do not create a
decision record for routine implementation detail.

