import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SIDEBAR_OPEN,
  readSidebarOpenPreference,
  resolveSidebarOpenPreference,
  SIDEBAR_OPEN_STORAGE_KEY,
  writeSidebarOpenPreference,
} from "./sidebar-state";

test("sidebar preference defaults to open and only accepts explicit false", () => {
  assert.equal(resolveSidebarOpenPreference(null), DEFAULT_SIDEBAR_OPEN);
  assert.equal(resolveSidebarOpenPreference("true"), true);
  assert.equal(resolveSidebarOpenPreference("false"), false);
  assert.equal(resolveSidebarOpenPreference("unexpected"), DEFAULT_SIDEBAR_OPEN);
});

test("sidebar preference persists through the browser storage boundary", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(readSidebarOpenPreference(storage), true);
  writeSidebarOpenPreference(storage, false);
  assert.equal(values.get(SIDEBAR_OPEN_STORAGE_KEY), "false");
  assert.equal(readSidebarOpenPreference(storage), false);
});

test("sidebar preference fails open when storage is unavailable", () => {
  assert.equal(readSidebarOpenPreference({
    getItem: () => { throw new Error("storage unavailable"); },
  }), DEFAULT_SIDEBAR_OPEN);
});
