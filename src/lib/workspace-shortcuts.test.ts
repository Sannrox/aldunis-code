import assert from "node:assert/strict";
import test from "node:test";
import { matchesModifierShortcut } from "./workspace-shortcuts";

test("configurable shortcuts accept either platform modifier", () => {
  assert.equal(matchesModifierShortcut({ key: "F", metaKey: true, ctrlKey: false, shiftKey: true }, "mod+shift+f"), true);
  assert.equal(matchesModifierShortcut({ key: "f", metaKey: false, ctrlKey: true, shiftKey: true }, "mod+shift+f"), true);
});

test("configurable shortcuts reject collisions and extra modifiers", () => {
  assert.equal(matchesModifierShortcut({ key: "f", metaKey: true, ctrlKey: false, shiftKey: false }, "mod+shift+f"), false);
  assert.equal(matchesModifierShortcut({ key: "f", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true }, "mod+shift+f"), false);
  assert.equal(matchesModifierShortcut({ key: "o", metaKey: true, ctrlKey: false, shiftKey: true }, "mod+shift+f"), false);
});
