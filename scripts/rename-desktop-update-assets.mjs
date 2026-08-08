import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dump, load } from "js-yaml";

const [, , directory, suffix, channel = "latest"] = process.argv;

if (!directory || !suffix) {
  throw new Error(
    "Usage: node scripts/rename-desktop-update-assets.mjs <release-directory> <architecture> [latest|nightly]",
  );
}

if (channel !== "latest" && channel !== "nightly") {
  throw new Error("Update channel must be latest or nightly.");
}

const entries = await readdir(directory, { withFileTypes: true });
const manifestName = `${channel}-mac.yml`;
const manifestPath = join(directory, manifestName);
const manifest = load(await readFile(manifestPath, "utf8"));
const renameable = entries
  .filter((entry) => entry.isFile() && /\.(?:dmg|zip|blockmap)$/.test(entry.name))
  .map((entry) => entry.name);
const assetNames = new Map();

function publishableAssetName(name) {
  // GitHub normalizes spaces in uploaded release asset names to dots. Apply
  // the same stable spelling before publishing so update metadata and assets
  // retain identical URLs after upload.
  return name.replace(/\s+/gu, ".");
}

for (const name of renameable) {
  const publishableName = publishableAssetName(name);
  const match = publishableName.match(/^(.*?)(\.(?:dmg|zip|blockmap))$/);
  if (!match) continue;
  const nextName = `${match[1]}-${suffix}${match[2]}`;
  assetNames.set(name, nextName);
  await rename(join(directory, name), join(directory, nextName));
}

function normalizedAssetName(name) {
  const extensionMatch = name.match(/(\.(?:dmg|zip|blockmap))$/iu);
  if (!extensionMatch) return name.replace(/[.\s_-]+/gu, "-").toLowerCase();
  const stem = name
    .slice(0, -extensionMatch[1].length)
    .replace(/[.\s_-]+/gu, "-")
    .toLowerCase();
  return `${stem}${extensionMatch[1].toLowerCase()}`;
}

function assetReference(value, normalizedAssets) {
  if (typeof value !== "string") return null;
  const name = basename(value);
  const exact = assetNames.get(value) ?? assetNames.get(name);
  if (exact) return { name, replacement: exact };
  const matches = normalizedAssets.get(normalizedAssetName(name)) ?? [];
  if (matches.length > 1) {
    throw new Error(`Manifest asset reference is ambiguous: ${value}`);
  }
  return matches[0] ? { name, replacement: matches[0] } : null;
}

const normalizedAssets = new Map();
for (const [source, target] of assetNames) {
  const key = normalizedAssetName(source);
  const matches = normalizedAssets.get(key) ?? [];
  matches.push(target);
  normalizedAssets.set(key, matches);
}

function rewriteReferences(value) {
  if (typeof value === "string") {
    const reference = assetReference(value, normalizedAssets);
    if (!reference) return value;
    return `${value.slice(0, -reference.name.length)}${reference.replacement}`;
  }
  if (Array.isArray(value)) return value.map(rewriteReferences);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rewriteReferences(entry)]),
  );
}

function manifestAssetReferences(value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  const references = files.flatMap((file) => {
    if (typeof file !== "object" || file === null) return [];
    const reference = typeof file.url === "string" ? file.url : file.path;
    return typeof reference === "string" ? [reference] : [];
  });
  if (typeof value?.path === "string") references.push(value.path);
  return references;
}

const rewritten = rewriteReferences(manifest);
const renamedAssets = new Set(assetNames.values());
for (const reference of manifestAssetReferences(rewritten)) {
  if (!renamedAssets.has(basename(reference))) {
    throw new Error(`Manifest references missing macOS asset: ${reference}`);
  }
}

await writeFile(manifestPath, dump(rewritten, { lineWidth: -1, noRefs: true }), "utf8");
await rename(manifestPath, join(directory, `${channel}-mac-${suffix}.yml`));
