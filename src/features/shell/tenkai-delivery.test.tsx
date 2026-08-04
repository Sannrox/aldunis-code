import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReleaseDeliverySession } from "../../types";
import {
  nextReleaseAction,
  repairPromptForOutcome,
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
        defaultBranch: "main",
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

test("repair handoff contains bounded evidence without provider output or local paths", () => {
  const prompt = repairPromptForOutcome(
    {
      candidate: {
        identity: `sha256:${"a".repeat(64)}`,
        document: { commit: { oid: "a".repeat(40) } },
      },
    } as ReleaseDeliverySession,
    {
      eventId: "tenkai:outcome:v2:event-1",
      schema: "tenkai.terminal_outcome.v1",
      deploymentId: "tenkai:deployment:local:widget:1",
      planId: "tenkai:plan:local:1",
      releaseId: "tenkai:release:widget:1.2.3",
      product: "widget",
      environmentId: "tenkai:environment:local",
      configurationId: "tenkai:configuration:local",
      terminalState: "deployment_failed",
      observedAt: new Date(1_000).toISOString(),
      bindingDigest: `sha256:${"b".repeat(64)}`,
      releaseDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      configurationDigest: `sha256:${"e".repeat(64)}`,
      deliveryState: "delivered",
      attempts: 1,
      nextAttemptAt: new Date(1_000).toISOString(),
      deliveredAt: new Date(1_010).toISOString(),
      claimUntil: null,
      deliveryLagMs: 10,
    },
  );
  assert.match(prompt, /event_id=tenkai:outcome:v2:event-1/);
  assert.match(prompt, /binding_digest=sha256:/);
  assert.doesNotMatch(prompt, /payload|raw output|\/Users\/|tenkai\.db/);
});
