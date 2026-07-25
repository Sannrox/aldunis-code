import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const stylesPath = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const css = readFileSync(stylesPath, "utf8");

const TYPE_FLOOR_REM = 0.6875; // 11px at 16px root
const TYPE_FLOOR_PX = 11;

function parseRules(source: string): Array<{ selector: string; body: string; isTokenBlock: boolean }> {
  const out: Array<{ selector: string; body: string; isTokenBlock: boolean }> = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    while (i < n && /\s/.test(source[i]!)) i++;
    if (i >= n) break;
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (source[i] === "@") {
      const brace = source.indexOf("{", i);
      if (brace < 0) break;
      let depth = 0;
      let j = brace;
      while (j < n) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
        j++;
      }
      const block = source.slice(i, j);
      const innerStart = block.indexOf("{");
      const inner = block.slice(innerStart + 1, -1);
      out.push(...parseRules(inner));
      i = j;
      continue;
    }
    const brace = source.indexOf("{", i);
    if (brace < 0) break;
    let depth = 0;
    let j = brace;
    while (j < n) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    const selector = source.slice(i, brace).trim();
    const body = source.slice(brace + 1, j - 1);
    const isTokenBlock =
      selector === ":root"
      || selector === '[data-theme="light"]'
      || selector === '[data-theme="dark"]'
      || selector.startsWith("[data-theme=");
    out.push({ selector, body, isTokenBlock });
    i = j;
  }
  return out;
}

test('[data-theme="light"] contains only token definitions, never component selectors', () => {
  const light = parseRules(css).filter((r) => r.selector.includes('[data-theme="light"]'));
  assert.ok(light.length >= 1, "expected a light theme token block");
  for (const rule of light) {
    assert.equal(
      rule.selector.trim(),
      '[data-theme="light"]',
      `component selector under light theme: ${rule.selector}`,
    );
    const decls = rule.body
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const decl of decls) {
      const prop = decl.split(":")[0]?.trim() ?? "";
      assert.ok(
        prop.startsWith("--") || prop === "color" || prop === "background" || prop === "color-scheme",
        `non-token declaration in light block: ${decl}`,
      );
    }
  }
});

test("styles.css contains no literal colour values outside token blocks", () => {
  const hex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
  const rgb = /rgba?\(/i;
  const hsl = /hsla?\(/i;
  const offenders: string[] = [];
  for (const rule of parseRules(css)) {
    if (rule.isTokenBlock) continue;
    if (hex.test(rule.body) || rgb.test(rule.body) || hsl.test(rule.body)) {
      offenders.push(rule.selector.slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], `literal colours outside tokens:\n${offenders.join("\n")}`);
});

test("no declared font-size is below the type floor", () => {
  const offenders: string[] = [];
  for (const rule of parseRules(css)) {
    for (const match of rule.body.matchAll(/font-size\s*:\s*([\d.]+)(rem|px)/gi)) {
      const value = Number(match[1]);
      const unit = match[2]!.toLowerCase();
      const below = unit === "rem" ? value < TYPE_FLOOR_REM : value < TYPE_FLOOR_PX;
      if (below) offenders.push(`${rule.selector}: ${match[0]}`);
    }
    for (const match of rule.body.matchAll(/font\s*:[^;{]*?\s([\d.]+)(rem|px)\b/gi)) {
      const value = Number(match[1]);
      const unit = match[2]!.toLowerCase();
      const below = unit === "rem" ? value < TYPE_FLOOR_REM : value < TYPE_FLOOR_PX;
      if (below) offenders.push(`${rule.selector}: font … ${match[1]}${match[2]}`);
    }
  }
  assert.deepEqual(offenders, [], `font-size below floor:\n${offenders.join("\n")}`);
});
