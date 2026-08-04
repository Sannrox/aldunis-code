# Design system

## Purpose

This document defines the durable interaction and visual rules for the
workbench. It explains which states receive emphasis, how thread lifecycle and
permissions appear, and where the implementation sources of truth live.

A working mock of these decisions is in
[design/workbench-mock.html](design/workbench-mock.html); see
[design/README.md](design/README.md) for what it does and does not cover.

## Implementation model

The shipped interface uses:

- Semantic color and typography tokens shared by light and dark themes.
- Reusable primitives under `src/components/ui/` for common controls.
- `@base-ui/react` primitives for accessible dialogs, popovers, selects, and
  tooltips.
- Feature components under `src/features/` for domain-specific behavior.

Do not add component-specific theme patches when a semantic token can express
the state. Do not put domain behavior into a generic UI primitive.

## Color

**Primary is monochrome.** `--primary` is near-black on light and near-white
on dark, with the opposite as `--primary-foreground`. It appears in about
seven places: brand mark, new thread, the single primary action per view,
send, the current user's avatar, and the focus ring.

The acid lime `#c5ff52` was tried as `--primary` and dropped. It works
against dark surfaces but collides with the amber status hue in dark theme
(both are yellow-family), and reads loud against light surfaces. A brand
color that has to be defended against the status palette is the wrong
primary.

**Color is reserved for what blocks the operator.** A saturated hue means
something wants a decision, or something failed. It is never applied to
things that are merely in progress or merely finished.

| Meaning | Treatment |
| --- | --- |
| Pending approval | amber label |
| Awaiting input | indigo label |
| Failed | red label |
| Working | muted spinner, no label |
| Completed | faint check, no label |
| Diff added / removed | green / red, retained |

Diff coloring stays even under a monochrome system. Glyphs and tinted rows
do some of the work, but scanning a long diff without hue is measurably
slower, and that is the one place color is load-bearing.

Nothing renders to report that things are fine. There is no "connected"
badge, no green health dot, and no success chrome.

## Thread rows

Thread rows use three lines:

```
[folder] project              status | time
Thread title
branch                        provider
```

Status occupies the top-right slot when a thread blocks the operator; elapsed
time occupies it otherwise, so the two never compete. Blocking and active
rows carry full-strength titles; everything else is muted.

Two lines were tried first and rejected: project, branch, provider, and time
compete for one 272px line, and the branch is what gets truncated. The branch
is the field the operator most needs before opening a thread.

## Settle

Settling moves a finished thread to a collapsed `Settled (N)` shelf at the
bottom of the sidebar, sorted by when the work ended rather than when the
thread was touched. It is reversible: `Unsettle` returns the thread to the
list. Settling is a sidebar state and nothing more.

The workbench sidebar can be collapsed from its header or with `Mod+B` (`⌘B` on
macOS, `Ctrl+B` on Windows/Linux). The preference is local to the current
browser or desktop profile, and the collapsed state removes the sidebar from
the layout while leaving the main conversation surface available. The same
control is used in the web renderer and Electron desktop shell.

**Settling does not release the worktree.** Aldunis Code enforces a managed
worktree limit (`server/worktrees.ts`), so settled conversations can continue
to consume that finite local resource.

The interface therefore makes the cost visible rather than changing the
semantics:

The post-turn completion notice is a compact elevated popover anchored to the
composer. It stays close to the next lifecycle decision without taking over
the conversation transcript; the worktree path is truncated visually but
remains available as the control's title text.

- A worktree meter in the shelf, `n / limit`.
- A marker on each settled row still holding a worktree.
- A line in the completion card stating that settling keeps the worktree and
  how many remain, so the choice is made before settling rather than
  discovered at the limit.
- `Settle and release worktree` as a separate action.

Releasing a worktree never deletes the conversation.

## Permission scope

The composer states the permission posture before a prompt is sent: model,
profile, and a **single mode control** that shows both the interaction mode
(Ask / Plan / Build) and the tool scope (Read-only / Plan only / Worktree
write). The control uses a lock glyph and a warning hue when the scope is
anything other than read-only.

A separate “Access” chip next to “Mode” was tried and dropped: both opened the
same menu, and “Access Read-only” read like conversation privacy rather than
agent tool authority.

This is the product's core claim — `AGENTS.md` requires explicit, scoped
approval for mutating provider tools — and it previously appeared only after
the fact, inside an approval card. Stating it before the prompt is sent puts
it where the decision is actually made.

## Voice input

Voice input is a secondary action in the conversation composer. The microphone
stays quiet at rest, becomes visibly active while listening, and never replaces
the primary send control. Finalized speech is appended to the current draft;
interim speech is shown as it arrives and remains editable after listening
stops. Manual typing stops the active dictation session so a late recognition
event cannot overwrite the operator's edit.

The feature uses the browser's speech-recognition capability only. Aldunis Code
does not receive, persist, or forward microphone audio; the browser or operating
system speech implementation may apply its own service and privacy policy. An
unsupported browser, blocked microphone, missing device, or unavailable speech
service is shown inline and leaves ordinary text input available.

The active conversation pane can also toggle dictation with `⌘⇧M` on macOS or
`Ctrl+Shift+M` on Windows/Linux. The shortcut is ignored while a modal dialog is
open and does not repeat while the key is held.

## Settings

Anything not touched during work belongs in Settings, not in the chrome.
Theme is the clearest case: nobody changes theme mid-approval.

Settings group installation-level concerns into General, Providers, Worktrees,
Approvals, Access, Keybindings, Diagnostics, and Archived threads.

Two constraints that previously existed only as error messages are surfaced
here: the managed worktree limit, and `MAX_THREADS_PER_PROJECT`.

## Cross-product pages

Four products share one shell: Code, Sekai (knowledge plane), Chisei
(governance plane), Tenkai (delivery plane).

**Switching happens on the brand mark**, plus keyboard shortcuts. This adds
no chrome — the mark is already present and already identifies the app.

Each cross-product page reuses the same sidebar and list components; only the
mark letter, the section list, and the plane label change.

The boundary note on each page states what the operator must not conclude,
rather than a generic disclaimer:

- Chisei: approvals granted locally are not policy decisions.
- Tenkai: a merged worktree is not a release.
- Sekai: these are routes that would be projected once a contract is
  attached.

The failure mode is not a user mistaking placeholder data for real data. It
is a user mistaking a local action for an authoritative one.

## Implementation sources

Use the live application and automated checks as the source of truth:

| Concern | Source |
| --- | --- |
| Semantic tokens and component styling | `src/styles.css` |
| Shell layout | `src/mock-shell.css` |
| Shared UI primitives | `src/components/ui/` |
| Sidebar and settled shelf | `src/features/code/sidebar.tsx` |
| Preferences and worktree limits | `src/features/dialogs/preferences-dialog.tsx` |
| Structural style checks | `src/styles.verification.test.ts` |
| Exploratory reference mock | `docs/design/workbench-mock.html` |

The HTML mock is design evidence, not a runtime contract. When it differs from
the shipped application, update or annotate the mock rather than documenting
the mock as shipped behavior.

## Verification

`src/styles.verification.test.ts` enforces structural constraints that are
cheap and deterministic, including:

- Semantic token tables exist for light and dark themes.
- Custom properties do not refer circularly to themselves.
- Shared primitive classes exist.
- Styles do not load remote Google Fonts.
- Critical controls retain their minimum hit sizes.
- Narrow and dual-pane layouts keep the conversation usable.

Also verify keyboard navigation, visible focus, reduced motion, narrow layouts,
and both themes in the live UI whenever a change affects interaction or layout.

## Open

- What finishing review unlocks. `Mark reviewed` and `Settle thread` are
  currently unrelated; reviewing every file is plausibly the moment settling
  and worktree release become safe.
- What cross-product pages look like once connected. This needs a real
  contract to design against.
- Whether the thread list should scroll at six threads, which is roughly the
  steady state for concurrent sessions.
