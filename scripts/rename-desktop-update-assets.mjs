import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump, load } from "js-yaml";

const [, , directory, suffix] = process.argv;

if (!directory || !suffix) {
  throw new Error("Usage: node scripts/rename-desktop-update-assets.mjs <release-directory> <architecture>");
}

const entries = await readdir(directory, { withFileTypes: true });
const manifestName = "latest-mac.yml";
const manifestPath = join(directory, manifestName);
const manifest = load(await readFile(manifestPath, "utf8"));
const renameable = entries
  .filter((entry) => entry.isFile() && /\.(?:dmg|zip|blockmap)$/.test(entry.name))
  .map((entry) => entry.name);
const assetNames = new Map();

for (const name of renameable) {
  const match = name.match(/^(.*?)(\.(?:dmg|zip|blockmap))$/);
  if (!match) continue;
  const nextName = `${match[1]}-${suffix}${match[2]}`;
  assetNames.set(name, nextName);
  await rename(join(directory, name), join(directory, nextName));
}

function rewriteReferences(value) {
  if (typeof value === "string") return assetNames.get(value) ?? value;
  if (Array.isArray(value)) return value.map(rewriteReferences);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteReferences(entry)]));
}

const rewritten = rewriteReferences(manifest);
await writeFile(manifestPath, dump(rewritten, { lineWidth: -1, noRefs: true }), "utf8");
await rename(manifestPath, join(directory, `latest-mac-${suffix}.yml`));
