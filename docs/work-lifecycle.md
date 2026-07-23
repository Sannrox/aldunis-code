# Work lifecycle

## Sources of truth

- Issues define executable outcomes and dependencies.
- Discussions resolve difficult-to-reverse architecture, trust, and product decisions.
- Pull requests contain implementation and current verification evidence.
- Accepted decisions and procedures become repository documentation.

## Flow

```text
idea -> status:triage -> shaped and dependency-ready -> status:ready
     -> one branch and PR -> review and verification -> rebase merge
```

Use one status label: `status:triage`, `status:ready`, or `status:blocked`.
Assignment means active ownership. Keep one observable outcome per Issue and
one Issue per PR.

Changes to provider trust, filesystem scope, approval authority, credential
handling, remote tenant context, or product ownership require a Discussion
before implementation.

Every PR records checks actually run and explicitly identifies skipped
provider, platform, accessibility, packaging, or security evidence.

