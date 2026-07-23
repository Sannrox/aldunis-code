import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PREFERENCES, readPreferencesResponse } from "./preferences";

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
