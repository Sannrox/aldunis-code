# Design system

## Purpose

Aldunis Code's interface grew without a written design language. It lives as
literal color values repeated across 565 selectors in one stylesheet, which is
why the same light-theme defect has been found and fixed five times.

This document records the design decisions taken so far, what they are based
on, and what remains open. A working mock of these decisions is in
[design/workbench-mock.html](design/workbench-mock.html); see
[design/README.md](design/README.md) for what it does and does not cover.

## Base

`pingdotgg/t3code` is the structural base. Taken from it:

- The token model: one semantic table, redefined per theme under the same
  names, with no per-component theme overrides.
- The primitive inventory and variant-driven components (`cva`-style
  `variant` × `size`), rather than styling each call site.
- The sidebar shape: search and new thread, a project scope, a thread list,
  a footer.
- Thread lifecycle vocabulary, including `settle`.
- `@base-ui/react` for dialog, popover, select, and tooltip.

Not taken from it: the blue primary. See "Color".

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

Three lines, following t3code:

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

Adopted from t3code, with one deliberate difference.

Settling moves a finished thread to a collapsed `Settled (N)` shelf at the
bottom of the sidebar, sorted by when the work ended rather than when the
thread was touched. It is reversible: `Unsettle` returns the thread to the
list. Settling is a sidebar state and nothing more.

**Settling does not release the worktree.** In t3code this is free, because
threads holding worktrees cost nothing. Aldunis Code enforces a managed
worktree limit (`server/worktrees.ts`), so a settled shelf silently
accumulates the scarce resource until dispatch fails.

The interface therefore makes the cost visible rather than changing the
semantics:

- A worktree meter in the shelf, `n / limit`.
- A marker on each settled row still holding a worktree.
- A line in the completion card stating that settling keeps the worktree and
  how many remain, so the choice is made before settling rather than
  discovered at the limit.
- `Settle and release worktree` as a separate action.

Releasing a worktree never deletes the conversation.

## Permission scope

The composer states the permission posture before a prompt is sent: model,
profile, **access scope**, and mode. Access scope is rendered with a lock and
a warning hue when it is anything other than read-only.

This is the product's core claim — `AGENTS.md` requires explicit, scoped
approval for mutating provider tools — and it previously appeared only after
the fact, inside an approval card. Stating it before the prompt is sent puts
it where the decision is actually made.

## Settings

Anything not touched during work belongs in Settings, not in the chrome.
Theme is the clearest case: nobody changes theme mid-approval.

Settings sections follow t3code's routes, mapped to this product: General,
Providers, Worktrees, Approvals, Access, Keybindings, Diagnostics, and
Archived threads.

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

## Known defect

`src/main.tsx:568` renders a provider footer that is entirely static: the
provider name is hardcoded, "Not connected" is a literal string with no state
behind it, and the `Connect` button has no handler. `server/provider.ts` and
`server/provider-adapters.ts` contain no connection concept at all, because
providers are spawned per session as subprocesses.

The shipped UI therefore claims "Not connected" while working normally. This
should be deleted rather than redesigned.

## Sequence

Each step is independently shippable and revertable.

1. Define the token table: `:root` plus a dark block redefining the same
   names. Additive; nothing changes visually.
2. Migrate `styles.css` from literal values onto tokens, deleting each
   `[data-theme="light"]` patch as its component becomes token-driven. The
   51-line block reaching zero is the completion test.
3. Delete the static provider footer.
4. Raise the type floor. 37 rendered elements are currently below 11px, 18 of
   them at 9.6px, with the smallest at 8px. The layout is spacious, so the
   small type buys no density.
5. Optionally self-host DM Sans / JetBrains Mono / Newsreader later for
   closer mock parity. Remote Google Fonts imports are already removed from
   the app shell (`index.html`, `src/styles.css`) so the workbench stays
   local-first; system stacks are the interim.
6. Extract primitives into `src/components/ui/`, starting with `Button`.
7. Replace `useDialogFocus` (`src/main.tsx:352`) with `@base-ui/react`.

## Verification

Theme defects are currently found only by looking. Before step 2 is complete:

- Assert `[data-theme="light"]` contains only token definitions, never
  component selectors. This makes the defect class structurally impossible
  rather than merely fixed.
- Assert `styles.css` contains no literal color values outside token blocks.
- Assert no declared `font-size` is below the floor.

These are cheap greps and they prevent regression permanently. They matter
more than the migration itself.

## Open

- What finishing review unlocks. `Mark reviewed` and `Settle thread` are
  currently unrelated; reviewing every file is plausibly the moment settling
  and worktree release become safe.
- Whether Sekai and Chisei remain two products, given one repository and one
  service.
- What cross-product pages look like once connected. This needs a real
  contract to design against.
- Whether the thread list should scroll at six threads, which is roughly the
  steady state for concurrent sessions.
