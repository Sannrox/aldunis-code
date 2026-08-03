import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandPalette } from "./command-palette";

test("command palette exposes one generic provider management action", () => {
  const html = renderToStaticMarkup(
    <CommandPalette
      open
      onClose={() => undefined}
      onOpenRepository={() => undefined}
      onSearch={() => undefined}
      onPreferences={() => undefined}
      onProviderManagement={() => undefined}
      onManageWorktrees={() => undefined}
      onAutomations={() => undefined}
      onAutonomy={() => undefined}
    />,
  );

  assert.match(html, /Provider management/);
  assert.match(html, /Profiles, adapter package trust, and readiness diagnostics/);
  assert.doesNotMatch(html, /Provider settings/);
  assert.doesNotMatch(html, /Provider adapters/);
});
