import { readFile, writeFile } from "node:fs/promises";
import { dump, load } from "js-yaml";

const [, , output, ...inputs] = process.argv;

if (!output || inputs.length < 1) {
  throw new Error("Usage: node scripts/merge-desktop-update-manifest.mjs <output> <manifest...>");
}

const manifests = await Promise.all(inputs.map(async (input) => {
  const value = load(await readFile(input, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Update manifest is not an object: ${input}`);
  }
  return value;
}));

const versions = new Set(manifests.map((manifest) => manifest.version).filter(Boolean));
if (versions.size > 1) throw new Error("Cannot merge update manifests with different versions.");

const files = new Map();
for (const manifest of manifests) {
  const manifestFiles = Array.isArray(manifest.files)
    ? manifest.files
    : (typeof manifest.path === "string" ? [{
      url: manifest.path,
      ...(typeof manifest.sha512 === "string" ? { sha512: manifest.sha512 } : {}),
      ...(typeof manifest.size === "number" ? { size: manifest.size } : {}),
    }] : []);
  for (const file of manifestFiles) {
    const fileName = typeof file?.url === "string" ? file.url : file?.path;
    if (typeof fileName !== "string") throw new Error("Update manifest contains a file without a URL or path.");
    const previous = files.get(fileName);
    if (previous && JSON.stringify(previous) !== JSON.stringify(file)) {
      throw new Error(`Conflicting update metadata for ${fileName}.`);
    }
    files.set(fileName, file);
  }
}

const merged = { ...manifests[0] };
delete merged.path;
delete merged.sha512;
delete merged.size;
merged.files = [...files.values()].sort((left, right) => {
  const leftName = left.url ?? left.path;
  const rightName = right.url ?? right.path;
  return leftName.localeCompare(rightName);
});

await writeFile(output, dump(merged, { lineWidth: -1, noRefs: true }), "utf8");
