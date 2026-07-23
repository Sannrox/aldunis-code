import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PREFERENCES, PreferencesStore } from "./preferences.ts";

test("preferences are versioned, persisted atomically, and survive restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-preferences-"));
  try {
    const saved = await new PreferencesStore(directory).save({
      ...DEFAULT_PREFERENCES,
      theme: "light",
      density: "compact",
      zoom: 1.1,
    });
    assert.equal(saved.theme, "light");
    const restarted = await new PreferencesStore(directory).load();
    assert.deepEqual(restarted, { preferences: saved, recovered: false });
    assert.equal((await readFile(join(directory, "preferences.v1.json"), "utf8")).includes("\"schemaVersion\": 1"), true);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("invalid preferences recover visibly to safe defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-preferences-"));
  try {
    await writeFile(join(directory, "preferences.v1.json"), "{\"schemaVersion\":99}");
    assert.deepEqual(await new PreferencesStore(directory).load(), {
      preferences: DEFAULT_PREFERENCES,
      recovered: true,
    });
    await assert.rejects(
      () => new PreferencesStore(directory).save({ ...DEFAULT_PREFERENCES, zoom: 4 }),
      /invalid value/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
