import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PREFERENCES, readPreferencesResponse, resolveTheme } from "./preferences";

test("resolveTheme follows the operating system when set to system", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("resolveTheme honors an explicit theme regardless of the system preference", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("preferences response accepts the current validated contract", () => {
  assert.deepEqual(readPreferencesResponse({
    preferences: DEFAULT_PREFERENCES,
    recovered: false,
  }), {
    preferences: DEFAULT_PREFERENCES,
    recovered: false,
  });
});

test("preferences response rejects missing and incompatible payloads", () => {
  assert.equal(readPreferencesResponse({ error: "API route not found." }), null);
  assert.equal(readPreferencesResponse({
    preferences: { ...DEFAULT_PREFERENCES, schemaVersion: 2 },
    recovered: false,
  }), null);
  assert.equal(readPreferencesResponse({
    preferences: { ...DEFAULT_PREFERENCES, commandPaletteShortcut: undefined },
    recovered: false,
  }), null);
});

test("preferences response migrates the version-one worktree limit default", () => {
  const { managedWorktreeLimit: _managedWorktreeLimit, ...legacy } = DEFAULT_PREFERENCES;
  assert.equal(readPreferencesResponse({
    preferences: legacy,
    recovered: false,
  })?.preferences.managedWorktreeLimit, 10);
});
