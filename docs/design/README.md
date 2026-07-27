# Design mocks

Design-system prose lives in [../design-system.md](../design-system.md). Full
documentation map: [../README.md](../README.md).

## workbench-mock.html

A single-file, self-contained mock of the workbench. Open it directly in a
browser; it has no build step and no local dependencies.

It renders the decisions recorded in [../design-system.md](../design-system.md)
so they can be looked at rather than read.

### What it covers

- Thread list with the three-line row, status pills, and the `woke`/`unread`
  distinction.
- Settle: the hover action, the `Settled (N)` shelf, unsettle, and the
  worktree meter with per-row release.
- The review panel, with per-file review state and inline annotations.
- The project switcher and the new-thread draft.
- Settings, including the constraints that previously existed only as error
  messages.
- Product switching from the brand mark, and cross-product pages for Sekai,
  Chisei, and Tenkai with contract-grounded sub-pages.

### Interacting with it

Most of it is live. `Settle` moves a thread to the shelf and back; the
worktree meter updates. `Toggle theme` is in Settings → General, not in the
chrome, by design. The product switcher is the brand mark in the top-left.

### What it is not

- Not a component library. It is ~900 lines of hand-written CSS in one file
  and does not map one-to-one onto the token-and-primitive model the design
  system describes.
- Not complete. Failure, empty, loading, and first-run states are largely
  undesigned, and it has only been laid out at 1440px.
- Not accessible-verified. Contrast and keyboard navigation are asserted in
  the design system, not measured here.
- Not real data. Cross-product pages use field names taken from
  `sekai-chisei/proto/*.proto` and Tenkai's documented model, but the values
  are illustrative.

It loads fonts from Google Fonts, which the shipped application must not do.
See the local-first note in the design system.

### Live workbench parity

The shipped workbench shell uses the same chrome patterns as this HTML mock
(tokenized via `src/mock-shell.css`). The app always uses real local data —
open a repository to populate threads, review, and delivery. There is no
in-app fixture mode or `?mock` URL flag.

### History

Only the final state exists. Earlier explorations — an inbox, an operations
watchtower, a code-with-margin-conversation layout, a summoned command
palette — were overwritten during iteration and are not recoverable.
