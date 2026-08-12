import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_PREFERENCES,
  MAX_PREFERENCES_FILE_BYTES,
  PreferencesStore,
} from "./preferences.ts";

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
    assert.equal(saved.managedWorktreeLimit, 10);
    assert.equal(saved.orchestrationThreadsBeta, false);
    assert.equal(saved.showThinking, false);
    assert.equal(saved.conversationOpenScroll, "latest");
    assert.equal(saved.conversationSearchShortcut, "mod+shift+f");
    const restarted = await new PreferencesStore(directory).load();
    assert.deepEqual(restarted, { preferences: saved, recovered: false });
    assert.equal(
      (await readFile(join(directory, "preferences.v1.json"), "utf8")).includes(
        '"schemaVersion": 1',
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("invalid preferences recover visibly to safe defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-preferences-"));
  try {
    await writeFile(join(directory, "preferences.v1.json"), '{"schemaVersion":99}');
    assert.deepEqual(await new PreferencesStore(directory).load(), {
      preferences: DEFAULT_PREFERENCES,
      recovered: true,
    });
    await assert.rejects(
      () => new PreferencesStore(directory).save({ ...DEFAULT_PREFERENCES, zoom: 4 }),
      /invalid value/,
    );
    await assert.rejects(
      () =>
        new PreferencesStore(directory).save({ ...DEFAULT_PREFERENCES, managedWorktreeLimit: 0 }),
      /invalid value/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("preferences discard unknown keys before returning or persisting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-preferences-"));
  try {
    const saved = await new PreferencesStore(directory).save({
      ...DEFAULT_PREFERENCES,
      padding: "not part of the preferences schema",
    });
    assert.equal("padding" in saved, false);
    assert.equal(
      (await readFile(join(directory, "preferences.v1.json"), "utf8")).includes("padding"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("oversized preferences recover before reading file content", async () => {
  let reads = 0;
  let closed = false;
  const store = new PreferencesStore("/state", {
    async open() {
      return {
        async stat() {
          return { size: MAX_PREFERENCES_FILE_BYTES + 1 };
        },
        async read() {
          reads += 1;
          return { bytesRead: 0 };
        },
        async close() {
          closed = true;
        },
      };
    },
  });

  assert.deepEqual(await store.load(), {
    preferences: DEFAULT_PREFERENCES,
    recovered: true,
  });
  assert.equal(reads, 0);
  assert.equal(closed, true);
});

test("legacy version-one preferences gain safe beta and managed-worktree defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-preferences-"));
  try {
    const {
      managedWorktreeLimit: _managedWorktreeLimit,
      orchestrationThreadsBeta: _orchestrationThreadsBeta,
      showThinking: _showThinking,
      conversationOpenScroll: _conversationOpenScroll,
      ...legacy
    } = DEFAULT_PREFERENCES;
    await writeFile(join(directory, "preferences.v1.json"), JSON.stringify(legacy));
    const loaded = (await new PreferencesStore(directory).load()).preferences;
    assert.equal(loaded.managedWorktreeLimit, 10);
    assert.equal(loaded.orchestrationThreadsBeta, false);
    assert.equal(loaded.showThinking, false);
    assert.equal(loaded.conversationOpenScroll, "latest");
    assert.equal(loaded.conversationSearchShortcut, "mod+shift+f");
  } finally {
    await rm(directory, { recursive: true });
  }
});
