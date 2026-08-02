# Design decisions

Short accepted records for choices that future changes must preserve. Prefer a
new file over rewriting history: amend only for factual corrections.

## Index

| Decision | Summary |
| --- | --- |
| [conversation-workspace-modes.md](conversation-workspace-modes.md) | Two new-chat workspace strategies with persisted shared compatibility mode |
| [managed-conversation-worktrees.md](managed-conversation-worktrees.md) | Host-owned worktree create/remove; providers cannot rebind silently |
| [cross-provider-conversation-forks.md](cross-provider-conversation-forks.md) | Explicit fork + allowlisted context transfer across providers |
| [conversation-automations.md](conversation-automations.md) | Timer-only automations into existing threads |
| [delegated-human-control.md](delegated-human-control.md) | Parent UI controls reuse child-bound approval and input authority |
| [chisei-project-projections.md](chisei-project-projections.md) | Server-owned project binding and bounded read-only Chisei projection |
| [shikigami-provider.md](shikigami-provider.md) | First-class shikigami harness provider + PermissionBroker pre-exec |
| [managed-hosted-workbench.md](managed-hosted-workbench.md) | Gateway-issued single-tenant hosted mode with fixed Shikigami Build |
| [opencode-declarative-adapter.md](opencode-declarative-adapter.md) | Reviewed OpenCode ACP package (`opencode acp`) |
| [shared-browser-ownership.md](shared-browser-ownership.md) | Aldunis-owned loopback browser shared by provider and operator |

## When to add one

Write a decision when you change:

- provider trust or approval authority
- filesystem / worktree boundaries
- credential or secret handling
- cross-product contracts (Chisei, Tenkai, Platform)
- persistence schemas that external tools might depend on

Template:

```markdown
# Title

- Status: Accepted | Superseded
- Date: YYYY-MM-DD
- Issue: #N (optional)

## Context
## Decision
## Consequences
## Non-goals (optional)
```

Use the `capture-code-decision` skill when promoting an accepted outcome from a
Discussion or merged PR.
