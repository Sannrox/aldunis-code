import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWorkspaceMode,
  NEW_CONVERSATION_WORKSPACE_MODES,
  WORKSPACE_MODE_COPY,
  workspaceModeLabel,
} from "./workspace-mode";

test("new conversations default to an Aldunis-managed workspace for every intent", () => {
  assert.equal(defaultWorkspaceMode("build", undefined), "aldunis-managed");
  assert.equal(defaultWorkspaceMode("ask", undefined), "aldunis-managed");
  assert.equal(defaultWorkspaceMode("plan", undefined), "aldunis-managed");
});
test("an explicit workspace mode survives interaction-mode defaults", () => {
  assert.equal(defaultWorkspaceMode("ask", "aldunis-managed"), "aldunis-managed");
  assert.equal(defaultWorkspaceMode("build", "shared"), "shared");
});

test("workspace labels describe the ownership boundary", () => {
  assert.equal(workspaceModeLabel("shared"), "Shared checkout");
  assert.equal(workspaceModeLabel("aldunis-managed"), "Aldunis worktree");
  assert.equal(workspaceModeLabel("provider-native"), "Provider-native");
  assert.match(WORKSPACE_MODE_COPY["provider-native"].detail, /adapter/);
});

test("new conversation UI exposes create and reuse strategies", () => {
  assert.deepEqual(NEW_CONVERSATION_WORKSPACE_MODES, [
    "aldunis-managed",
    "shared",
    "provider-native",
  ]);
  assert.equal(NEW_CONVERSATION_WORKSPACE_MODES.includes("shared"), true);
});
