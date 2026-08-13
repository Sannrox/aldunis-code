import assert from "node:assert/strict";
import test from "node:test";
import {
  initialWorkspacePanelLifecycle,
  transitionWorkspacePanelLifecycle,
  workspacePanelTabStop,
  workspacePanelToggleHeld,
  type WorkspacePanelLifecycleEvent,
  type WorkspacePanelLifecycleState,
} from "./workspace-panel";

function apply(state: WorkspacePanelLifecycleState, event: WorkspacePanelLifecycleEvent) {
  return transitionWorkspacePanelLifecycle(state, event);
}

test("workspace selector stays pressed while the destination chunk is pending", () => {
  assert.equal(workspacePanelToggleHeld("files", "files", true), true);
  assert.equal(workspacePanelToggleHeld("files", "files", false), false);
  assert.equal(workspacePanelToggleHeld("preview", "files", true), false);
  assert.equal(workspacePanelToggleHeld("none", "preview", true), false);
});

test("workspace lifecycle opens, switches, refreshes, closes, and restores focus", () => {
  let state = initialWorkspacePanelLifecycle();
  let transition = apply(state, { type: "toggle", destination: "files" });
  state = transition.state;
  assert.equal(state.activePanel, "files");
  assert.deepEqual(transition.effects, [{ type: "change_panel", panel: "files" }]);

  transition = apply(state, { type: "toggle", destination: "preview" });
  state = transition.state;
  assert.equal(state.previewMounted, true);
  assert.equal(state.previewFloating, false);

  transition = apply(state, { type: "open_changes", mode: "deliver" });
  state = transition.state;
  assert.equal(state.changesMode, "deliver");
  assert.deepEqual(transition.effects, [
    { type: "refresh_changes" },
    { type: "change_panel", panel: "changes" },
  ]);

  transition = apply(state, { type: "close", destination: "changes" });
  assert.equal(transition.state.activePanel, "none");
  assert.deepEqual(transition.effects, [
    { type: "change_panel", panel: "none" },
    { type: "focus_panel", destination: "changes", defer: true },
  ]);
});

test("workspace lifecycle coordinates floating preview and browser observations", () => {
  let state = initialWorkspacePanelLifecycle("preview");
  let transition = apply(state, { type: "toggle_preview_floating" });
  state = transition.state;
  assert.deepEqual(
    { active: state.activePanel, mounted: state.previewMounted, floating: state.previewFloating },
    { active: "none", mounted: true, floating: true },
  );
  transition = apply(state, { type: "browser_observation", present: true });
  state = transition.state;
  assert.equal(state.browserObservationOpen, true);
  transition = apply(state, { type: "toggle_preview_floating" });
  state = transition.state;
  assert.equal(state.activePanel, "preview");
  assert.equal(state.previewFloating, false);
  transition = apply(state, { type: "close_preview" });
  assert.equal(transition.state.browserObservationOpen, false);
  assert.equal(transition.state.previewMounted, false);
  assert.equal(transition.state.previewFloating, false);
});

test("workspace lifecycle unmounts a failed preview when dismissed", () => {
  let state = initialWorkspacePanelLifecycle("preview");
  state = apply(state, { type: "browser_observation", present: true }).state;
  const transition = apply(state, { type: "dismiss_preview" });
  assert.deepEqual(
    {
      active: transition.state.activePanel,
      mounted: transition.state.previewMounted,
      floating: transition.state.previewFloating,
      observation: transition.state.browserObservationOpen,
    },
    { active: "none", mounted: false, floating: false, observation: false },
  );
  assert.deepEqual(transition.effects, [
    { type: "change_panel", panel: "none" },
    { type: "focus_panel", destination: "preview", defer: true },
  ]);
});

test("workspace lifecycle keeps current and immutable turn review distinct", () => {
  let state = initialWorkspacePanelLifecycle("changes");
  let transition = apply(state, {
    type: "open_turn_changes",
    checkpoint: {
      id: "checkpoint-1",
      turnId: "turn-1",
      worktree: "/repo",
      baselineIdentity: "a",
      baselineIndexIdentity: "a",
      completedIdentity: "b",
      completedIndexIdentity: "b",
      state: "completed",
      message: null,
      files: [
        {
          path: "src/app.ts",
          previousPath: null,
          state: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
    },
  });
  state = transition.state;
  assert.equal(state.turnReview?.checkpointId, "checkpoint-1");
  assert.deepEqual(transition.effects, []);
  transition = apply(state, { type: "open_changes", mode: "review" });
  assert.equal(transition.state.turnReview, null);
  assert.deepEqual(transition.effects, [{ type: "refresh_changes" }]);
});

test("workspace lifecycle derives roving focus and reset decisions", () => {
  let state = initialWorkspacePanelLifecycle("preview");
  assert.equal(workspacePanelTabStop(state, ["files", "preview", "changes"]), "preview");
  const transition = apply(state, {
    type: "move_focus",
    from: "preview",
    direction: "next",
    available: ["files", "preview", "changes"],
  });
  state = transition.state;
  assert.equal(state.focusedPanel, "changes");
  assert.deepEqual(transition.effects, [
    { type: "focus_panel", destination: "changes", defer: false },
  ]);
  state = apply(state, { type: "browser_observation", present: true }).state;
  state = apply(state, { type: "workspace_reset" }).state;
  assert.equal(state.previewMounted, false);
  assert.equal(state.previewFloating, false);
  assert.equal(state.browserObservationOpen, false);
});

test("workspace lifecycle unmounts preview on close, toggle-away, and workspace reset", () => {
  let state = initialWorkspacePanelLifecycle();
  state = apply(state, { type: "toggle", destination: "preview" }).state;
  assert.equal(state.previewMounted, true);

  let transition = apply(state, { type: "close_preview" });
  assert.equal(transition.state.activePanel, "none");
  assert.equal(transition.state.previewMounted, false);

  state = apply(state, { type: "toggle", destination: "files" }).state;
  assert.equal(state.activePanel, "files");
  assert.equal(state.previewMounted, false);
  assert.equal(state.previewFloating, false);

  state = initialWorkspacePanelLifecycle("preview");
  state = apply(state, { type: "toggle_preview_floating" }).state;
  assert.equal(state.previewFloating, true);
  transition = apply(state, { type: "close_preview" });
  assert.equal(transition.state.activePanel, "none");
  assert.equal(transition.state.previewMounted, false);
  assert.equal(transition.state.previewFloating, false);

  state = initialWorkspacePanelLifecycle("preview");
  state = apply(state, { type: "toggle_preview_floating" }).state;
  transition = apply(state, { type: "toggle", destination: "files" });
  assert.equal(transition.state.activePanel, "files");
  assert.equal(transition.state.previewFloating, true);
  assert.equal(transition.state.previewMounted, true);

  state = apply(state, { type: "browser_observation", present: true }).state;
  transition = apply(state, { type: "workspace_reset" });
  assert.deepEqual(
    {
      mounted: transition.state.previewMounted,
      floating: transition.state.previewFloating,
      observation: transition.state.browserObservationOpen,
    },
    { mounted: false, floating: false, observation: false },
  );
});
