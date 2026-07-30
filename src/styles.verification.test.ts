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

test("Aldunis brand mark follows the resolved application theme", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.aldunis-brand-mark__dark\s*\{[^}]*display:\s*none/s);
  assert.match(
    shell,
    /\[data-theme="dark"\]\s+\.aldunis-brand-mark__light\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    shell,
    /\[data-theme="dark"\]\s+\.aldunis-brand-mark__dark\s*\{[^}]*display:\s*block/s,
  );
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
  // collapsed the conversation to 0px. Dock must shrink and .conv keeps room.
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.doesNotMatch(shell, /\.review-dock,\s*\.rv\s*\{[^}]*flex:\s*0\s+0\s+42vh/s);
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.review-dock,\s*\.rv\s*\{[^}]*flex:\s*0\s+1\s+min\(50vh,\s*55%\)/s,
  );
  assert.match(
    shell,
    /\.split\.with-review\s*>\s*\.conv\s*\{[^}]*min-height:\s*100px/s,
  );
});

test("review dock contains overflow; short docks use one scroll stream", () => {
  // Stacked dual-pane left .rv-files ~8px and .review-workspace ~14px when both
  // competed for a ~60px body. Desktop: workspace scrolls; mobile: body scrolls.
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.rv,\s*\.review-dock\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(
    shell,
    /\.review-workspace\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.review-dock\s+\.changes-body[\s\S]*?overflow-y:\s*auto/s,
  );
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.review-dock\s+\.rv-files[\s\S]*?max-height:\s*none/s,
  );
});

test("pane-switcher tabs have usable hit targets and active chrome", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.pane-switcher\s*>\s*button\s*\{[^}]*min-height:\s*32px/s);
  assert.match(shell, /\.pane-switcher\s*>\s*button\.active/s);
  assert.match(shell, /\.pane-switcher\s*>\s*button\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("workspace panel selector groups status-bearing controls and compacts at narrow widths", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.workspace-panel-selector\s*\{[^}]*display:\s*flex[^}]*border:\s*1px solid var\(--border\)/s);
  assert.match(shell, /\.workspace-panel-count\s*\{[^}]*min-width:\s*18px/s);
  assert.match(
    shell,
    /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.workspace-panel-label\s*\{[^}]*display:\s*none/s,
  );
  assert.match(css, /\.preview-panel\[hidden\]\s*\{[^}]*display:\s*none/s);
});

test("minimum desktop width shows one active conversation so review stays readable", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /@media\s*\(max-width:\s*1100px\)\s*\{[\s\S]*?\.split-workspace\.split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/s,
  );
  assert.match(
    shell,
    /\.conversation-workspace\[data-active-pane="primary"\]\s+\.split-workspace\.split\s*>\s*\.secondary-pane,[\s\S]*?\.conversation-workspace\[data-active-pane="secondary"\]\s+\.split-workspace\.split\s*>\s*\.primary-pane,[\s\S]*?\.split-workspace\.split\s*>\s*\.split-divider\s*\{[^}]*display:\s*none\s*!important/s,
  );
});

test("default desktop width shows only the active pane while review is open", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /@media\s*\(min-width:\s*1101px\)\s*and\s*\(max-width:\s*1440px\)\s*\{[\s\S]*?\.conversation-workspace:has\(\.review-dock\)\s+\.split-workspace\.split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important/s,
  );
  assert.match(
    shell,
    /\.conversation-workspace:has\(\.review-dock\)\[data-active-pane="primary"\]\s+\.split-workspace\.split\s*>\s*\.secondary-pane,[\s\S]*?\.conversation-workspace:has\(\.review-dock\)\[data-active-pane="secondary"\]\s+\.split-workspace\.split\s*>\s*\.primary-pane,[\s\S]*?\.conversation-workspace:has\(\.review-dock\)\s+\.split-workspace\.split\s*>\s*\.split-divider\s*\{[^}]*display:\s*none\s*!important/s,
  );
});

test("staging checkbox hit target is expanded via label", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.changed-file-select\s*\{[^}]*min-width:\s*28px[^}]*min-height:\s*28px/s);
});

test("thread row and settled-shelf actions meet minimum hit size", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  // Dense 22px / 20px targets failed residual stress; require ≥28px.
  assert.match(shell, /\.settle,\s*\.beside,\s*\.row-more\s*\{[^}]*min-height:\s*28px/s);
  assert.match(shell, /\.sbtn\s*\{[^}]*min-height:\s*28px/s);
});

test("command palette search field has a usable min-height", () => {
  assert.match(css, /\.quick-search\s*>\s*input\s*\{[^}]*min-height:\s*32px/s);
});

test("keyboard-active quick results remain visibly highlighted", () => {
  assert.match(
    css,
    /\.quick-results\s*>\s*button:hover,[\s\S]*?\.quick-results\s*>\s*button:focus-visible,[\s\S]*?\.quick-results\s*>\s*button\.active\s*\{[^}]*background:\s*var\(--accent\)/s,
  );
});

test("bare .ui-input (including native selects) defaults to md height", () => {
  // Automations dialog used <select class="ui-input"> without --md; base rule
  // must supply min-height so selects are not ~21px tall.
  assert.match(css, /\.ui-input\s*\{[^}]*min-height:\s*36px/s);
});

test("automations dialog keeps content inset and independently scrollable", () => {
  const dialogPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "features/dialogs/automations-dialog.tsx",
  );
  const dialog = readFileSync(dialogPath, "utf8");
  assert.match(dialog, /className="automations-dialog-body"/);
  assert.match(
    css,
    /\.automations-dialog-body\s*\{[^}]*overflow-y:\s*auto[^}]*padding:\s*16px/s,
  );
});

test("adapter catalog docs links and advanced toggle meet min hit size", () => {
  assert.match(css, /\.adapter-catalog-meta\s+a\s*\{[^}]*min-height:\s*28px/s);
  assert.match(css, /\.adapter-advanced-toggle\s*\{[^}]*min-height:\s*28px/s);
});

test("native single-line selects default to usable min-height", () => {
  // Fork dialog selects had no class and measured ~21px.
  assert.match(css, /select:not\(\[multiple\]\):not\(\[size\]\)\s*\{[^}]*min-height:\s*36px/s);
});

test("settled shelf open-row control meets min hit size", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.srow-main\s*\{[^}]*min-height:\s*28px/s);
});

test("composer context chip remove controls meet min hit size", () => {
  // Attachment remove (×) was ~13×7 bare text.
  assert.match(
    css,
    /\.context-chips\s*>\s*span\s*>\s*button\s*\{[^}]*min-width:\s*28px[^}]*min-height:\s*28px/s,
  );
});

test("shell .btn-xs meets minimum hit size", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.btn-xs\s*\{[^}]*min-height:\s*28px/s);
});

test("diff and file comment controls meet shell hit size", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /\.diff-comment-button,\s*\.file-comment-button\s*\{[^}]*min-width:\s*28px[^}]*min-height:\s*28px/s,
  );
});

test("preferences segment buttons meet min hit size", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.seg\s+button\s*\{[^}]*min-height:\s*28px/s);
});

test("preferences collapse to a scrollable single-column layout on narrow viewports", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.settings\s*\{[^}]*flex-direction:\s*column\s*!important/s,
  );
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.snav\s*\{[^}]*flex-direction:\s*row\s*!important[^}]*overflow:\s*hidden\s*!important/s,
  );
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.snav-sections\s*\{[^}]*flex:\s*1\s+1\s+auto[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s,
  );
  assert.match(
    shell,
    /@media\s*\(max-width:\s*680px\)\s*\{[\s\S]*?\.preferences-form\s+\.field\s*\{[^}]*flex-direction:\s*column\s*!important/s,
  );
});

test("provider management keeps one bounded shell and stacks navigation narrowly", () => {
  assert.match(
    css,
    /\.provider-management-dialog\s*\{[^}]*width:\s*min\(1120px[^}]*height:\s*min\(780px[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\.provider-management-layout\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/s,
  );
  assert.match(
    css,
    /\.provider-management-layout\s*>\s*nav\s+button\s*\{[^}]*min-height:\s*56px/s,
  );
});

test("annotation resolve and ui-button--xs meet min hit size", () => {
  assert.match(css, /\.ui-button--xs\s*\{[^}]*min-height:\s*28px/s);
  assert.match(css, /\.annotation-resolve\s*\{[^}]*min-height:\s*28px/s);
});

test("split-divider expands hit target without growing layout column", () => {
  // Layout column stays 6px; ::before overhang expands pointer grab area.
  assert.match(css, /\.split-divider\s*\{[^}]*width:\s*6px[^}]*flex:\s*0\s+0\s+6px/s);
  assert.match(css, /\.split-divider::before\s*\{[^}]*inset:\s*0\s+-5px/s);
});

test("completion settle actions wrap in narrow dual-pane columns", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.done\s*\{[^}]*min-width:\s*0/s);
  assert.match(shell, /\.done \.acts\s*\{[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/s);
});

test("conversation prose wraps long unbroken prompts", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.turn p\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("composer crow chips ellipsize in narrow dual-pane columns", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(shell, /\.crow \.cc\s*\{[^}]*max-width:[^}]*text-overflow:\s*ellipsis/s);
});

test("composer grows within its established desktop height bounds", () => {
  const shellPath = join(dirname(fileURLToPath(import.meta.url)), "mock-shell.css");
  const shell = readFileSync(shellPath, "utf8");
  assert.match(
    shell,
    /\.composer-input\s*\{[^}]*min-height:\s*44px[^}]*max-height:\s*160px/s,
  );
});

test("index.html must not load remote Google Fonts (local-first)", () => {
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.html");
  const html = readFileSync(indexPath, "utf8");
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/i);
});
