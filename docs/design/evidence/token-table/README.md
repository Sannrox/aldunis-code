# Token table evidence (Issue #81)

Additive semantic token table in `src/styles.css`. No existing rule
consumes the new names, so dark and light must be pixel-identical before
and after.

## Proof

| Theme | Surface sample | Pixels |
| --- | --- | --- |
| dark | identical | identical |
| light | identical | identical |

- `before-{theme}.png` / `after-{theme}.png` — workbench shell at 1440×900
- `before-{theme}.json` / `after-{theme}.json` — computed styles of key
  surfaces and legacy token values
- `capture.mjs` — reproducible Playwright capture (requires a local
  `playwright` install and a running dev server)

Re-run:

```bash
node docs/design/evidence/token-table/capture.mjs before http://127.0.0.1:4180/
# apply change, then
node docs/design/evidence/token-table/capture.mjs after http://127.0.0.1:4180/
```
