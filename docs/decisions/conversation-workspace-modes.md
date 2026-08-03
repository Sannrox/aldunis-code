# Conversation workspace modes

Status: Accepted
Source: Maintainer direction following [Issue #26](https://github.com/Sannrox/aldunis-code/issues/26)
Extends: [Managed conversation worktrees](managed-conversation-worktrees.md)

## Decision

Every conversation has one persisted workspace mode and one canonical
worktree binding. The new-conversation path first selects the work context
(host, project, workspace strategy, and branch/worktree), then starts the
conversation from the normal composer. It presents two user-facing workspace
strategies:

- `aldunis-managed`: create a dedicated Aldunis-owned worktree and branch
  through the existing preview-and-approve flow. This is the default for every
  new conversation intent.
- `provider-native`: allow a provider adapter to prepare its own isolated
  workspace only when that adapter declares the capability and returns the
  canonical path before the conversation is started. The host still validates
  and binds that path; a provider cannot silently rebind an existing thread.

`shared` remains a persisted compatibility mode for legacy conversations and
server-owned flows, but it is not presented as a third primary choice in the
new-chat setup. Multiple conversations may share a selected checkout only when
that existing mode is already bound or an owning flow explicitly permits it.

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
- The create-chat UI keeps Ask / Plan / Build as the interaction mode control
  and keeps workspace strategy separate from provider and model selection.
- Native-provider worktrees remain an adapter capability, not a permission
  bypass. An adapter must provide a reviewed creation/preparation contract,
  canonical path, and failure behavior before it can be enabled.
- Legacy local history without a workspace mode migrates to `shared`; its
  existing canonical worktree is never changed.
