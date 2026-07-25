/**
 * Capture dark/light screenshots and computed-style samples for the
 * additive token-table change. Usage:
 *   node docs/design/evidence/token-table/capture.mjs <before|after> [url]
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const phase = process.argv[2] || "before";
const url = process.argv[3] || "http://127.0.0.1:4176/";
const outDir = dirname(fileURLToPath(import.meta.url));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await page.waitForSelector(".app, body", { timeout: 30_000 });
await page.waitForTimeout(800);

async function capture(theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(300);
  const imagePath = resolve(outDir, `${phase}-${theme}.png`);
  await page.screenshot({ path: imagePath, fullPage: false });
  const sample = await page.evaluate(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel) || document.documentElement;
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of props) out[p] = cs.getPropertyValue(p);
      return out;
    };
    const tokens = {};
    const root = getComputedStyle(document.documentElement);
    for (const name of [
      "--line",
      "--muted",
      "--panel",
      "--panel-2",
      "--acid",
      "--shadow-pop",
      "--shadow-modal",
    ]) {
      tokens[name] = root.getPropertyValue(name).trim();
    }
    return {
      theme: document.documentElement.dataset.theme,
      tokens,
      body: pick("body", ["color", "background-color", "font-family"]),
      app: pick(".app", ["background-color", "color"]),
      header: pick(".page-header", ["background-color", "border-bottom-color"]),
      sidebar: pick(".context-sidebar", ["background-color", "border-right-color"]),
      conversation: pick(".conversation", ["background-color"]),
      mark: pick(".aldunis-mark", ["color", "background-image", "border-color"]),
    };
  });
  writeFileSync(resolve(outDir, `${phase}-${theme}.json`), JSON.stringify(sample, null, 2));
  const hash = createHash("sha256").update(JSON.stringify(sample)).digest("hex").slice(0, 16);
  console.log(`${phase} ${theme}: screenshot=${imagePath} sampleHash=${hash}`);
}

await capture("dark");
await capture("light");
await browser.close();
