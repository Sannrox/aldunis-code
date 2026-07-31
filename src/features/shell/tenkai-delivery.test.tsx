import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseDeliverySession } from "../../types";
import {
  nextReleaseAction,
  releaseSessionForView,
  TenkaiDeliveryPanel,
} from "./tenkai-delivery";

test("Tenkai delivery renders the staged local authority boundary", () => {
  const html = renderToStaticMarkup(
    <TenkaiDeliveryPanel
      repository={{
        projectId: "project-1",
        name: "widget",
        root: "/repo",
        selectedWorktree: "/repo",
        worktrees: [],
      }}
      projectId="project-1"
      chiseiBound
    />,
  );
  assert.match(html, /Candidate ledger/);
  assert.match(html, /Release delivery stages/);
  assert.match(html, /Tenkai manifest/);
  assert.match(html, /not an operating-system sandbox/);
  assert.match(html, /exposes no general terminal/);
});

test("workflow action routing never skips an authority stage", () => {
  const session = (state: string) => ({ state } as ReleaseDeliverySession);
  assert.equal(nextReleaseAction(null), "prepare");
  assert.equal(nextReleaseAction(session("candidate_ready")), "evaluate");
  assert.equal(nextReleaseAction(session("governance_allowed")), "publish");
  assert.equal(nextReleaseAction(session("publication_unknown")), "reconcile");
  assert.equal(nextReleaseAction(session("published")), "promote");
  assert.equal(nextReleaseAction(session("promoted")), "plan");
  assert.equal(nextReleaseAction(session("planned")), "apply");
  assert.equal(nextReleaseAction(session("unknown")), "reconcile");
  assert.equal(nextReleaseAction(session("stale")), null);
});

test("starting a new candidate does not reuse the selected historical session", () => {
  const historical = { id: "session-1", state: "completed" } as ReleaseDeliverySession;
  assert.equal(releaseSessionForView([historical], historical.id, false), historical);
  assert.equal(releaseSessionForView([historical], historical.id, true), null);
  assert.equal(nextReleaseAction(releaseSessionForView([historical], historical.id, true)), "prepare");
});
