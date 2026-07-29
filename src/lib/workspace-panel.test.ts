import assert from "node:assert/strict";
import test from "node:test";
import {
  moveWorkspacePanelFocus,
  toggleWorkspacePanel,
  workspacePanelTabStop,
  type WorkspacePanel,
} from "./workspace-panel";

test("workspace panel activation opens, switches, and closes one destination", () => {
  let active: WorkspacePanel = "none";
  active = toggleWorkspacePanel(active, "files");
  assert.equal(active, "files");
  active = toggleWorkspacePanel(active, "preview");
  assert.equal(active, "preview");
  active = toggleWorkspacePanel(active, "changes");
  assert.equal(active, "changes");
  active = toggleWorkspacePanel(active, "changes");
  assert.equal(active, "none");
});

test("external panel signals select one state without preserving an invalid combination", () => {
  let active: WorkspacePanel = "preview";
  active = "files";
  assert.equal(active, "files");
  active = "changes";
  assert.equal(active, "changes");
});

test("workspace panel roving focus prefers active, wraps, and skips unavailable destinations", () => {
  assert.equal(workspacePanelTabStop("preview", ["files", "preview", "changes"]), "preview");
  assert.equal(workspacePanelTabStop("none", ["files", "changes"]), "files");
  assert.equal(workspacePanelTabStop("preview", ["files", "changes"]), "files");
  assert.equal(workspacePanelTabStop("none", []), null);

  assert.equal(moveWorkspacePanelFocus("files", "next", ["files", "changes"]), "changes");
  assert.equal(moveWorkspacePanelFocus("changes", "next", ["files", "changes"]), "files");
  assert.equal(moveWorkspacePanelFocus("files", "previous", ["files", "changes"]), "changes");
  assert.equal(moveWorkspacePanelFocus("changes", "first", ["files", "changes"]), "files");
  assert.equal(moveWorkspacePanelFocus("files", "last", ["files", "changes"]), "changes");
});
