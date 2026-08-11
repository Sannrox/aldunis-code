import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MOBILE_SIDEBAR_OPEN,
  DEFAULT_SIDEBAR_OPEN,
  initialSidebarLifecycle,
  isSidebarShortcutCapturedTarget,
  MOBILE_SIDEBAR_OPEN_STORAGE_KEY,
  matchesSidebarToggleShortcut,
  readSidebarOpenPreference,
  resolveSidebarOpenPreference,
  SIDEBAR_OPEN_STORAGE_KEY,
  transitionSidebarLifecycle,
  writeSidebarOpenPreference,
} from "./sidebar-state";

test("sidebar toggle shortcut accepts platform modifiers and rejects collisions", () => {
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "B",
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
    }),
    true,
  );
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }),
    false,
  );
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: true,
    }),
    false,
  );
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "b",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: true,
    }),
    false,
  );
  assert.equal(
    matchesSidebarToggleShortcut({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
    false,
  );
});

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
  assert.equal(
    readSidebarOpenPreference({
      getItem: () => {
        throw new Error("storage unavailable");
      },
    }),
    DEFAULT_SIDEBAR_OPEN,
  );
});

test("mobile sidebar preference is independent and closed by default", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(
    readSidebarOpenPreference(
      storage,
      MOBILE_SIDEBAR_OPEN_STORAGE_KEY,
      DEFAULT_MOBILE_SIDEBAR_OPEN,
    ),
    false,
  );
  writeSidebarOpenPreference(storage, true, MOBILE_SIDEBAR_OPEN_STORAGE_KEY);
  assert.equal(values.get(MOBILE_SIDEBAR_OPEN_STORAGE_KEY), "true");
  assert.equal(
    readSidebarOpenPreference(
      storage,
      MOBILE_SIDEBAR_OPEN_STORAGE_KEY,
      DEFAULT_MOBILE_SIDEBAR_OPEN,
    ),
    true,
  );
});

test("sidebar lifecycle coordinates toggle persistence and focus", () => {
  let state = initialSidebarLifecycle(true, false);
  let transition = transitionSidebarLifecycle(state, { type: "toggle" });
  state = transition.state;
  assert.deepEqual(state, { open: false, narrowViewport: false });
  assert.deepEqual(transition.effects, [
    { type: "persist", open: false, narrowViewport: false },
    { type: "focus", target: "open_toggle" },
  ]);

  transition = transitionSidebarLifecycle(state, { type: "toggle" });
  assert.deepEqual(transition.effects, [
    { type: "persist", open: true, narrowViewport: false },
    { type: "focus", target: "collapse_toggle" },
  ]);
});

test("sidebar lifecycle keeps navigation and dialog close outcomes distinct", () => {
  const state = initialSidebarLifecycle(true, true);
  assert.deepEqual(
    transitionSidebarLifecycle(state, { type: "set_open", open: false, source: "navigation" })
      .effects,
    [
      { type: "persist", open: false, narrowViewport: true },
      { type: "focus", target: "main" },
    ],
  );
  assert.deepEqual(
    transitionSidebarLifecycle(state, { type: "set_open", open: false, source: "dialog" }).effects,
    [{ type: "persist", open: false, narrowViewport: true }],
  );
});

test("sidebar lifecycle applies independent responsive preference and safe focus escape", () => {
  const transition = transitionSidebarLifecycle(initialSidebarLifecycle(true, false), {
    type: "viewport_change",
    narrowViewport: true,
    preferredOpen: false,
  });
  assert.deepEqual(transition.state, { open: false, narrowViewport: true });
  assert.deepEqual(transition.effects, [
    { type: "persist", open: false, narrowViewport: true },
    { type: "focus", target: "escape_hidden" },
  ]);
});

test("sidebar shortcut capture excludes editors and explicit capture regions", () => {
  const target = (
    overrides: Partial<{ isContentEditable: boolean; closest: boolean; matches: boolean }>,
  ) => ({
    isContentEditable: overrides.isContentEditable ?? false,
    closest: () => (overrides.closest ? {} : null),
    matches: () => overrides.matches ?? false,
  });
  assert.equal(isSidebarShortcutCapturedTarget(target({})), false);
  assert.equal(isSidebarShortcutCapturedTarget(target({ isContentEditable: true })), true);
  assert.equal(isSidebarShortcutCapturedTarget(target({ closest: true })), true);
  assert.equal(isSidebarShortcutCapturedTarget(target({ matches: true })), true);
});
