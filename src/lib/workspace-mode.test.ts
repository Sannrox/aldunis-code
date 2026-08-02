import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultWorkspaceMode,
  WORKSPACE_MODE_COPY,
  workspaceModeLabel,
} from "./workspace-mode";

test("Build defaults to an Aldunis-managed workspace while Ask and Plan stay shared", () => {
  assert.equal(defaultWorkspaceMode("build", undefined), "aldunis-managed");
  assert.equal(defaultWorkspaceMode("ask", undefined), "shared");
  assert.equal(defaultWorkspaceMode("plan", undefined), "shared");
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
