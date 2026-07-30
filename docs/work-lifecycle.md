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
