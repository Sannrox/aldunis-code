# Workspace panel selector research

Issue [#363](https://github.com/Sannrox/aldunis-code/issues/363) asks whether
Files, Preview, and Changes should share one navigation and state model.

## Decision

**Revise, then proceed.** Use one direct three-destination selector and one
per-pane `none | files | preview | changes` state. Do not force the three
destinations into one visual container: Files and Preview remain contained
conversation overlays, while Changes retains its review dock and responsive
dual-pane behavior.

This reduces accidental navigation and state complexity without merging the
destinations' data, security, or authority boundaries. Implementation is
separately scoped in
[#367](https://github.com/Sannrox/aldunis-code/issues/367), which remains blocked
until this decision lands.

## Product contract

The workbench must provide direct, per-pane access to repository files, the
approved loopback preview, and changed-file review. The following constraints
are fixed:

- repository and worktree authority remains host-owned and explicitly scoped;
- preview retains its start approval, loopback-origin, and content restrictions;
- Changes retains diff, annotation, approval, and delivery semantics;
- change counts, active or failed preview state, and unavailable destinations
  remain visible;
- keyboard access, visible focus, reduced motion, narrow layouts, and two
  independently mounted conversation panes cannot regress.

Sharing navigation does not make the underlying capabilities interchangeable.

## Current model

Each conversation pane currently has three separate top-bar buttons:

| Control | State owner | Open presentation | Close/switch rule | Status shown closed |
| --- | --- | --- | --- | --- |
| Browse | `PaneConversation.filesOpen` | Overlay contained by `.conv` | Its click closes Preview and Changes | Active pressed state only |
| Preview | local `Conversation.previewOpen` | Overlay contained by `.conv` | Its click closes Files and Changes | Active pressed state only |
| Changes | `PaneConversation.changesOpen` | Review dock beside `.conv` | Its click closes Files and Preview | Change count and active pressed state |

The pointer handlers intend mutual exclusion, so the valid visible states are
None, Files, Preview, and Changes. Three booleans nevertheless represent eight
combinations. The external `showFilesSignal` and `showChangesSignal` effects
open their target directly and do not close the other states, so invalid stacked
combinations remain representable outside the top-bar click path.

At ordinary widths, opening or switching destinations takes one activation.
Closing takes one activation. The proposal must preserve that action count.

Changes is structurally different from the overlays. Its `.split.with-review`
layout, minimum-width regression rules, and the workbench's existing active-pane
fallback preserve readable review in dual-pane mode. A uniform container would
discard those proven responsive rules or recreate them behind a more complex
generic abstraction.

## Proposed selector model

Use a labeled toggle-button group with three directly visible destinations:

```text
Workspace:  [Files]  [Preview • running]  [Changes 12]
             active panel content uses its existing presentation
```

- One activation switches directly to any destination. Activating the current
  destination closes it, preserving today's toggle behavior.
- Each button exposes `aria-pressed`; zero or one button may be pressed. The
  active destination has visible chrome. Roving focus lets Arrow keys move
  among available destinations, while Tab enters and leaves the group once.
- Changes always retains its numeric badge. Loading or failure adds a concise
  status marker and accessible description without replacing the count.
- Preview shows inactive, starting, running, or failed status when known. The
  panel remains the owner of preview approval and recovery.
- Files remains visibly available whenever a repository is open. A destination
  that is unavailable stays visible but disabled with an accessible reason.
- At narrow widths, visible labels may shorten after the established breakpoint,
  but the accessible names and minimum hit targets remain. No animation is
  required, so reduced-motion behavior is unchanged.
- Each pane owns its selector state. When Changes invokes the existing
  responsive single-visible-pane fallback, the workbench pane switcher remains
  the way to change conversations; it is not merged with this selector.
- Closing or switching returns focus to the corresponding selector control when
  panel-owned focus would otherwise disappear.

## Complexity ledger

| Burden | Payer | Evidence | Class | Decision |
| --- | --- | --- | --- | --- |
| Three independent open booleans | Developers and tests | `pane-conversation.tsx` and `conversation.tsx` | Accidental | Replace with one enum |
| Eight representable combinations for four valid states | Recovery and external signal paths | Signal effects bypass click-handler exclusion | Accidental | Make invalid combinations unrepresentable |
| Three direct destinations | Users | All three capabilities are frequent and distinct | Essential | Keep as one direct selector |
| Destination-specific rendering | UI implementation | Overlays and review dock have different responsive duties | Essential | Keep behind one state |
| Visible change count | Reviewers | Current Changes button exposes it before opening | Essential | Preserve as badge |
| Preview lifecycle and errors | Operators | `PreviewPanel` owns approval, running, frame, and failure state | Essential | Project concise status into selector; keep authority in panel |
| Separate pane switcher | Dual-pane users | It selects conversations, not workspace tools | Essential | Keep separate |
| A single dropdown labeled “Panel” | Keyboard and repeat users | Adds an open-menu step and hides status | Accidental | Reject |
| One generic panel renderer | Developers and narrow-layout users | Would absorb overlay, dock, preview, and review exceptions | Transferred complexity | Reject |

## Comparison

| Measure | Current | Revised proposal | Dividend |
| --- | ---: | ---: | ---: |
| Direct destination controls | 3 | 3 grouped | 0; discoverability preserved |
| Actions to open or switch | 1 | 1 | 0 |
| Open-state variables | 3 booleans | 1 enum | -2 |
| Representable panel states | 8 | 4 | -4 |
| Invalid stacked combinations | 4 | 0 | -4 |
| Top-bar/external transition paths | Separate toggle and signal branches | One transition function | Fewer recovery branches |
| Content/authority interfaces merged | 0 | 0 | No boundary transfer |
| Responsive presentation variants | Overlay and review dock | Overlay and review dock | 0; proven behavior retained |

The one-time cost is a focused client-state migration, selector accessibility,
focus restoration, and status projection. There is no persisted state migration
because panel-open state is currently component-local. The change is reversible
and does not alter server contracts.

## Verification plan and guardrails

Implementation must cover:

- pointer open, close, and direct switching for all destinations;
- tab entry, arrow-key movement, activation, Escape or close behavior, and
  visible focus;
- external Files and Changes signals using the same transition;
- change-count, loading, preview-running, error, and unavailable indicators;
- the supported minimum and default desktop widths;
- two independently mounted panes and the existing Changes responsive fallback;
- reduced motion, which should require no special animation path;
- unchanged preview approval/security and repository/diff authority.

Preview lifecycle state must be available as a read-only projection while the
panel is closed so running and failure status remain visible. `PreviewPanel`
continues to own start, stop, approval, frame, and recovery actions; lifting the
host's existing preview status response into per-pane presentation state must
not create a second mutation or lifecycle authority.
