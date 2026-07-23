---
name: assess-code-impact
description: Assess a proposed or implemented Aldunis Code change across local data, filesystem scope, provider processes, permissions, UX, product contracts, packaging, and operations. Use while shaping an Issue, before implementation, or during review.
---

# Assess Code Impact

Trace consequences before implementation commits to the wrong boundary.

## Procedure

1. Read the request or Issue, `AGENTS.md`, `docs/architecture.md`, affected code,
   and direct callers or adapters.
2. Map applicable surfaces:
   - repository roots, worktrees, files, diffs, and local persistence;
   - provider subprocess lifecycle, event normalization, cancellation, and
     credential handling;
   - tool permissions, approval duration, audit, and secret redaction;
   - keyboard, accessibility, failure, offline, and recovery UX;
   - Sekai Chisei, Tenkai, and Aldunis authenticated contracts;
   - packaging, updates, loopback binding, logs, and support evidence.
3. Assign every responsibility to its authority. A displayed projection does
   not transfer ownership.
4. Map each material risk to a deterministic check or name the residual
   uncertainty. Require a Discussion for a new trust or authority boundary.

## Output

Return a compact matrix of surface, evidence, required change/check, owner, and
risk. Then state scope boundaries, blockers, migration or rollback duties, and
the smallest safe PR split. This is not a security audit.

