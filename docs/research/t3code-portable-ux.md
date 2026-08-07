# Portable UX from T3 Code

Status: Partial implementation (Issue #542)

Source: Comparison of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
against Aldunis Code product boundaries and design system.

## Already present in Aldunis Code

| T3 pattern                              | Aldunis equivalent                                 |
| --------------------------------------- | -------------------------------------------------- |
| Multi-provider agent control surface    | Provider adapters + composer                       |
| Worktrees + branch toolbar              | Managed / shared / provider-native workspace modes |
| Diff review + delivery (commit/push/PR) | Changes panel + delivery broker                    |
| Settle shelf                            | Settled shelf with worktree meter                  |
| Attention grouping                      | Needs attention group                              |
| Command palette / thread search         | Palette + conversation search                      |
| Keybindings settings section            | Preferences → Keybindings                          |
| Project registry                        | Saved projects                                     |
| Desktop + remote access                 | Electron shell + remote workbench                  |
| Diff +/− chips                          | Environment control + turn change stats            |

## Portable and in scope for Code

| Pattern                                   | Fit    | Notes                                                                                                                                                                       |
| ----------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time-based thread snooze**              | High   | Implemented in #542. Visibility-only hide with presets; attention override.                                                                                                 |
| Context window meter                      | High   | Codex `thread/tokenUsage/updated` and ACP `usage_update` are currently dropped as informational. Ephemeral ring meter near composer would match T3 without durable history. |
| Message copy actions                      | Medium | Open PR pattern already exists; keep keyboard/touch/a11y explicit.                                                                                                          |
| PR status on thread rows                  | Medium | Needs VCS status projection; delivery already drafts PRs.                                                                                                                   |
| Previous-worktree seed in new-thread flow | Medium | Composer workspace selector could offer last non-current worktree.                                                                                                          |
| Composer draft stash                      | Medium | Local draft recovery across threads without server transcripts.                                                                                                             |

## Out of scope or constrained

| Pattern                      | Why not (here)                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| Integrated terminal          | Product constraint: no general-purpose terminal in Code.               |
| Mobile remote client         | Separate product surface; remote web already covers access.            |
| Theme editor / token inspect | Design system is monochrome + status hues; not mid-work chrome.        |
| Green connection health dots | Design system: nothing renders to report that things are fine.         |
| Project script runner shell  | Conflicts with no-terminal and approval model unless tightly brokered. |
| T3 Connect / public tunnel   | Code remains loopback-default; remote is explicit authenticated modes. |

## Implementation order

1. Thread snooze (#542) — pure local lifecycle UX, no provider protocol change.
2. Context window meter — surface dropped usage events per provider.
3. PR row indicators — once delivery/VCS status is cheap to project.
4. Previous worktree + draft stash — composer polish.

Do not port T3 architecture (Effect event sourcing, multi-environment
orchestration) wholesale; keep Aldunis ownership boundaries and design system.
