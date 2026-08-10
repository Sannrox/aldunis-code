# Conversation workspace modes

Status: Accepted
Source: Maintainer direction following [Issue #26](https://github.com/Sannrox/aldunis-code/issues/26)
Extends: [Managed conversation worktrees](managed-conversation-worktrees.md)

## Decision

Every conversation has one persisted workspace mode and one canonical
worktree binding. The new-conversation path first selects the work context
(host, project, workspace strategy, and branch/worktree), then starts the
conversation from the normal composer. It presents three user-facing workspace
strategies:

- `aldunis-managed` (default): create a dedicated Aldunis-owned worktree and
  branch through the preview-and-approve flow. The operator chooses the
  **start-from** base branch (repository default preselected). Existing
  worktree lists and previous-worktree seeds stay hidden on this path.
- `shared`: reuse an existing checkout. The operator picks a worktree; a
  previous-worktree seed may appear as a reuse accelerator when another recent
  conversation in the project used a different path.
- `provider-native`: allow a provider adapter to prepare its own isolated
  workspace only when that adapter declares the capability and returns the
  canonical path before the conversation is started. The host still validates
  and binds that path; a provider cannot silently rebind an existing thread.

Create and reuse are both first-class. They must not compete in the same
control set: managed create asks for a base branch; shared reuse asks for an
existing checkout.

If a new-chat managed-worktree preview reports staged index changes, the setup
surface may explicitly switch that new conversation to the selected shared
checkout as a recovery choice. Unstaged and untracked local changes remain in
the source checkout and are not copied, stashed, committed, or removed.
Managed forks do not use this fallback because a fork from an Aldunis-managed
conversation still requires a separate approved destination worktree.

Current built-in adapters do not expose the provider-native preparation
contract, so the option is visible as unavailable with an explanation. The
capability is intentionally modeled now so a future adapter can add native
isolation without changing the conversation model.

An existing conversation cannot switch modes or worktrees in place. A
reviewed fork or handoff creates a new conversation and performs any future
workspace change before that destination starts. A fork from an
Aldunis-managed conversation must approve a distinct Aldunis-managed
worktree; it never reuses the source's exclusive checkout. Closing, settling,
deleting, or retaining a conversation never removes its worktree automatically.
If a reviewed fork fails after its destination worktree was approved, the
destination remains available and the fork surface offers the normal previewed
worktree-removal flow; it is never deleted implicitly.

## Consequences

- Workspace ownership is visible and durable rather than inferred from the
  provider or the current browser selection.
- New conversations no longer contend for the repository checkout by default;
  Ask, Plan, and Build all start with a dedicated Aldunis-managed workspace.
- Operators who want shared reuse choose it explicitly and get the checkout
  picker (and previous-worktree seed) only then.
- The create-chat UI keeps Ask / Plan / Build as the interaction mode control
  and keeps workspace strategy separate from provider and model selection.
- Native-provider worktrees remain an adapter capability, not a permission
  bypass. An adapter must provide a reviewed creation/preparation contract,
  canonical path, and failure behavior before it can be enabled.
- Legacy local history without a workspace mode migrates to `shared`; its
  existing canonical worktree is never changed.
