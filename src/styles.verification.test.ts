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
