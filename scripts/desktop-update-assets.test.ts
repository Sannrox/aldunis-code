import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dump, load } from "js-yaml";

const execFileAsync = promisify(execFile);
const renameScript = fileURLToPath(new URL("./rename-desktop-update-assets.mjs", import.meta.url));

async function runRename(directory: string, suffix = "arm64") {
  return execFileAsync(process.execPath, [renameScript, directory, suffix, "nightly"]);
}

async function writeManifest(directory: string, files: string[], path?: string) {
  const manifest: { version: string; files: Array<{ url: string; sha512: string; size: number }>; path?: string } = {
    version: "0.1.0-nightly.20260807.8",
    files: files.map((url) => ({ url, sha512: "fixture", size: 1 })),
  };
  if (path) manifest.path = path;
  await writeFile(
    join(directory, "nightly-mac.yml"),
    dump(manifest, { lineWidth: -1, noRefs: true }),
    "utf8",
  );
}

test("macOS asset renaming reconciles builder filename punctuation and validates output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-update-assets-"));
  const sourceDmg = "Aldunis.Code-0.1.0-arm64.dmg";
  const sourceZip = "Aldunis.Code-0.1.0-nightly.20260807.8-arm64-mac.zip";
  const sourceBlockmap = `${sourceZip}.blockmap`;
  try {
    await writeManifest(directory, [
      "Aldunis-Code-0.1.0-arm64.dmg",
      "Aldunis-Code-0.1.0-nightly.20260807.8-arm64-mac.zip",
    ]);
    for (const asset of [sourceDmg, sourceZip, sourceBlockmap]) {
      await writeFile(join(directory, asset), "fixture", "utf8");
    }

    await runRename(directory);

    const manifest = load(await readFile(join(directory, "nightly-mac-arm64.yml"), "utf8")) as {
      files: Array<{ url: string }>;
    };
    const renamedDmg = "Aldunis.Code-0.1.0-arm64-arm64.dmg";
    const renamedZip = "Aldunis.Code-0.1.0-nightly.20260807.8-arm64-mac-arm64.zip";
    const renamedBlockmap = sourceBlockmap.replace(".blockmap", "-arm64.blockmap");
    assert.deepEqual(manifest.files.map((file) => file.url), [renamedDmg, renamedZip]);
    await readFile(join(directory, renamedDmg));
    await readFile(join(directory, renamedZip));
    await readFile(join(directory, renamedBlockmap));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS asset renaming reconciles Intel builder artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-update-assets-"));
  const sourceDmg = "Aldunis.Code-0.1.0.dmg";
  const sourceZip = "Aldunis.Code-0.1.0-nightly.20260807.8-mac.zip";
  const sourceBlockmap = `${sourceZip}.blockmap`;
  try {
    await writeManifest(directory, [
      "Aldunis-Code-0.1.0.dmg",
      "Aldunis-Code-0.1.0-nightly.20260807.8-mac.zip",
    ]);
    for (const asset of [sourceDmg, sourceZip, sourceBlockmap]) {
      await writeFile(join(directory, asset), "fixture", "utf8");
    }

    await runRename(directory, "x64");

    const manifest = load(await readFile(join(directory, "nightly-mac-x64.yml"), "utf8")) as {
      files: Array<{ url: string }>;
    };
    const renamedDmg = "Aldunis.Code-0.1.0-x64.dmg";
    const renamedZip = "Aldunis.Code-0.1.0-nightly.20260807.8-mac-x64.zip";
    const renamedBlockmap = sourceBlockmap.replace(".blockmap", "-x64.blockmap");
    assert.deepEqual(manifest.files.map((file) => file.url), [renamedDmg, renamedZip]);
    await readFile(join(directory, renamedDmg));
    await readFile(join(directory, renamedZip));
    await readFile(join(directory, renamedBlockmap));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS asset renaming rejects manifests that reference missing artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-update-assets-"));
  try {
    await writeManifest(directory, ["Aldunis-Code-0.1.0-arm64.dmg"]);
    await writeFile(join(directory, "Aldunis.Code-0.1.0-x64.dmg"), "fixture", "utf8");

    await assert.rejects(
      () => runRename(directory),
      (error: unknown) => {
        const stderr = typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
        assert.match(stderr, /Manifest references missing macOS asset/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS asset renaming validates legacy path alongside files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-update-assets-"));
  try {
    await writeManifest(
      directory,
      ["Aldunis-Code-0.1.0-arm64.dmg"],
      "Aldunis-Code-0.1.0-nightly.20260807.8-mac.zip",
    );
    await writeFile(join(directory, "Aldunis.Code-0.1.0-arm64.dmg"), "fixture", "utf8");

    await assert.rejects(
      () => runRename(directory),
      (error: unknown) => {
        const stderr = typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
        assert.match(stderr, /Manifest references missing macOS asset/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
