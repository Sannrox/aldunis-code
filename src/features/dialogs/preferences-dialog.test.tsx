import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  preferenceSectionHasEditableFields,
  preferencesHaveUnsavedChanges,
  ProviderSettingsLinks,
} from "./preferences-dialog";
import { DEFAULT_PREFERENCES } from "../../preferences";

test("preferences dialog wires provider recovery destinations", () => {
  const html = renderToStaticMarkup(
    <ProviderSettingsLinks
      onOpenProviderSettings={() => undefined}
      onOpenAdapterSettings={() => undefined}
    />,
  );

  assert.match(html, /Manage provider profiles/);
  assert.match(html, /Manage provider adapters/);
  assert.match(html, /without leaving this recovery path/);
});

test("informational settings sections do not imply unsaved changes", () => {
  assert.equal(preferenceSectionHasEditableFields("General"), true);
  assert.equal(preferenceSectionHasEditableFields("Worktrees"), true);
  assert.equal(preferenceSectionHasEditableFields("Keybindings"), true);
  assert.equal(preferenceSectionHasEditableFields("Providers"), false);
  assert.equal(preferenceSectionHasEditableFields("Approvals"), false);
  assert.equal(preferenceSectionHasEditableFields("Access"), false);
  assert.equal(preferenceSectionHasEditableFields("Diagnostics"), false);
  assert.equal(preferenceSectionHasEditableFields("Archived"), false);
});

test("preference drafts expose unsaved changes before cross-dialog navigation", () => {
  assert.equal(preferencesHaveUnsavedChanges(DEFAULT_PREFERENCES, DEFAULT_PREFERENCES), false);
  assert.equal(
    preferencesHaveUnsavedChanges(
      { ...DEFAULT_PREFERENCES, theme: DEFAULT_PREFERENCES.theme === "dark" ? "light" : "dark" },
      DEFAULT_PREFERENCES,
    ),
    true,
  );

  const html = renderToStaticMarkup(
    <ProviderSettingsLinks
      disabled
      onOpenProviderSettings={() => undefined}
      onOpenAdapterSettings={() => undefined}
    />,
  );
  assert.match(html, /disabled/);
  assert.match(html, /Save or cancel your preference changes/);
});
