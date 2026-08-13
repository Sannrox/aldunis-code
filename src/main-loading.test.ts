import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./main.tsx", import.meta.url)), "utf8");

test("optional control dialogs stay behind renderer intent boundaries", () => {
  const dialogs = ["activity", "automations", "autonomy", "connections", "preferences"];
  for (const dialog of dialogs) {
    const path = `./features/dialogs/${dialog}-dialog`;
    assert.doesNotMatch(source, new RegExp(`import\\s+(?!type\\b)[^;]+from ["']${path}["']`));
    assert.match(source, new RegExp(`import\\(["']${path}["']\\)`));
  }
  assert.match(source, /<Suspense fallback=\{null\}>/);
});
