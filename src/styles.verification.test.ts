import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const css = readFileSync(stylesPath, "utf8");

test("semantic token tables exist for light (:root) and dark themes", () => {
  assert.match(css, /:root\s*\{[\s\S]*?--primary\s*:/);
  assert.match(css, /:root\s*\{[\s\S]*?--background\s*:/);
  assert.match(css, /\[data-theme="dark"\]\s*\{[\s\S]*?--primary\s*:/);
  assert.match(css, /\[data-theme="dark"\]\s*\{[\s\S]*?--background\s*:/);
  // legacy tokens remain concrete values (not circular)
  assert.match(css, /--acid\s*:\s*#[0-9a-fA-F]{3,8}/);
  assert.match(css, /--line\s*:\s*#[0-9a-fA-F]{3,8}/);
});

test("custom properties must not be circular self-references", () => {
  const offenders: string[] = [];
  for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*var\(--([a-z0-9-]+)\)/gi)) {
    if (match[1] === match[2]) offenders.push(`--${match[1]}: var(--${match[2]})`);
  }
  assert.deepEqual(offenders, [], `circular tokens:\n${offenders.join("\n")}`);
});

test("ui primitive classes are defined against the stylesheet", () => {
  for (const name of [
    ".ui-button",
    ".ui-button--primary",
    ".ui-badge",
    ".ui-card",
    ".ui-separator",
    ".ui-spinner",
    ".ui-empty",
    ".ui-banner",
    ".ui-input",
    ".ui-textarea",
    ".ui-field",
  ]) {
    assert.ok(css.includes(name), `missing primitive rule ${name}`);
  }
});

test("icon buttons resist flex shrink in tight headers", () => {
  // Close controls in review-dock headers were crushed to ~13px under flex-shrink.
  assert.match(css, /\.ui-button--icon\s*\{[^}]*min-width:\s*32px[^}]*flex:\s*0\s+0\s+32px/s);
  assert.match(css, /\.ui-button--icon-sm\s*\{[^}]*min-width:\s*28px[^}]*flex:\s*0\s+0\s+28px/s);
});

test("styles must not load remote Google Fonts (local-first)", () => {
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/i);
  assert.doesNotMatch(css, /@import\s+url\(/i);
});

test("conversation overlays are contained by .conv (not review dock)", () => {
  // File browser and web preview are absolute under a positioned .conv so they
  // do not climb to .app (covering the product sidebar) or cover the review
  // dock sibling. Topbar is outside .conv, so Browse / Review stay clickable.
  assert.match(css, /--conv-topbar-height\s*:/);
  assert.match(css, /\.conv-root\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.conv\s*\{[^}]*position:\s*relative/s);
  assert.match(
    css,
    /\.file-browser-panel,\s*\.preview-panel\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*right:\s*0[^}]*bottom:\s*0[^}]*left:\s*0/s,
  );
});

test("review dock shrinks so dual-pane conversation stays usable", () => {
  // Fixed 430px review inside a ~500px dual-pane primary left ~70px for the
  // thread. Dock must be allowed to shrink (flex-shrink + percentage cap).
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /\.rv,\s*\.review-dock\s*\{[^}]*flex:\s*0\s+1\s+min\(430px,\s*48%\)/s,
  );
  assert.match(
    shell,
    /\.conv\s*\{[^}]*min-width:\s*min\(240px,\s*100%\)/s,
  );
});

test("narrow review dock must not use fixed 42vh basis that crushes .conv", () => {
  // At max-width 680px, flex: 0 0 42vh exceeded dual-pane column height and
  // collapsed the conversation to 0px. Dock must shrink and .conv keeps min-height.
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.doesNotMatch(shell, /\.review-dock,\s*\.rv\s*\{[^}]*flex:\s*0\s+0\s+42vh/s);
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.review-dock,\s*\.rv\s*\{[^}]*flex:\s*0\s+1\s+min\(42vh,\s*46%\)/s,
  );
  assert.match(
    shell,
    /\.split\.with-review\s*>\s*\.conv\s*\{[^}]*min-height:\s*140px/s,
  );
});

test("pane-switcher tabs have usable hit targets and active chrome", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.pane-switcher\s*>\s*button\s*\{[^}]*min-height:\s*32px/s);
  assert.match(shell, /\.pane-switcher\s*>\s*button\.active/s);
  assert.match(shell, /\.pane-switcher\s*>\s*button\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("staging checkbox hit target is expanded via label", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.changed-file-select\s*\{[^}]*min-width:\s*28px[^}]*min-height:\s*28px/s);
});

test("index.html must not load remote Google Fonts (local-first)", () => {
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/i);
});
