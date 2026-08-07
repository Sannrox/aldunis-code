# Portable UX from T3 Code

Status: Partial implementation (#542 snooze, #545 context meter, #548 message copy, #551 PR rows)

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

| Pattern                                   | Fit    | Notes                                                                                |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| **Time-based thread snooze**              | High   | Implemented in #542. Visibility-only hide with presets; attention override.          |
| **Context window meter**                  | High   | Implemented in #545. Codex/ACP usage → ephemeral composer ring; not durable history. |
| **Message copy actions**                  | Medium | Implemented in #548. Hover/focus copy for prompts and answers.                       |
| **PR status on thread rows**              | Medium | Implemented in #551. GitHub `gh pr view` projection; soft-fail without gh.           |
| Previous-worktree seed in new-thread flow | Medium | Composer workspace selector could offer last non-current worktree.                   |
| Composer draft stash                      | Medium | Local draft recovery across threads without server transcripts.                      |

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
2. Context window meter (#545) — surface dropped usage events per provider.
3. Message copy (#548) — prompt/answer clipboard actions.
4. PR row indicators (#551) — GitHub PR state on conversation rows.
5. Previous worktree + draft stash — composer polish.

Do not port T3 architecture (Effect event sourcing, multi-environment
orchestration) wholesale; keep Aldunis ownership boundaries and design system.
