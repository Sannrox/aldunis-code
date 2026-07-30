import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateDesktopReleaseTag(tag: string, version: string): void {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(
      `Desktop release tag ${JSON.stringify(tag)} must exactly match package version ${JSON.stringify(expected)}.`,
    );
  }
}

async function main(): Promise<void> {
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json must contain a non-empty string version.");
  }

  validateDesktopReleaseTag(tag, packageJson.version);
  process.stdout.write(`Desktop release evidence is bound to ${tag}.\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
