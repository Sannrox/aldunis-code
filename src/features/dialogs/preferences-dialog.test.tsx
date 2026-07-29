import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  preferenceSectionHasEditableFields,
  preferencesHaveUnsavedChanges,
  PreferencesDialog,
  ProviderSettingsLinks,
} from "./preferences-dialog";
import { DEFAULT_PREFERENCES } from "../../preferences";

test("preferences dialog wires provider recovery destinations", () => {
  const html = renderToStaticMarkup(
    <ProviderSettingsLinks
      onOpenProviderManagement={() => undefined}
    />,
  );

  assert.match(html, /Open provider management/);
  assert.match(html, /adapter package trust/);
  assert.match(html, /mutation APIs remain separate/);
});

test("preferences dialog keeps its exit separate from scrollable sections", () => {
  const html = renderToStaticMarkup(
    <PreferencesDialog
      open
      preferences={DEFAULT_PREFERENCES}
      recovered={false}
      onClose={() => undefined}
      onSave={async () => undefined}
      onOpenProviderManagement={() => undefined}
    />,
  );

  assert.match(
    html,
    /class="sback"[^>]*>← Back to threads<\/button><div class="snav-sections">/,
  );
  assert.match(html, /class="snav-i on" aria-current="true">General/);
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
      onOpenProviderManagement={() => undefined}
    />,
  );
  assert.match(html, /disabled/);
  assert.match(html, /Save or cancel your preference changes/);
});
