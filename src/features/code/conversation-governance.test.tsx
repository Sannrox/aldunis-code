import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GovernanceCorrelationSummary } from "./conversation";

test("governed Shikigami correlation is labeled direct and exposes persisted inspection", () => {
  const html = renderToStaticMarkup(
    <GovernanceCorrelationSummary
      correlation={{
        kind: "governance_correlation",
        governance: "sekai-chisei",
        runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        operationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        correlationId: "receipt-1",
      }}
    />,
  );
  assert.match(html, /Direct governed/);
  assert.match(html, /Shikigami run/);
  assert.match(html, /Inspect in Chisei/);
  assert.doesNotMatch(html, /admitted|claimed/i);
  assert.doesNotMatch(html, /disabled/);
});

test("unpersisted live correlation does not offer an unsafe inspect action", () => {
  const html = renderToStaticMarkup(
    <GovernanceCorrelationSummary
      correlation={{
        kind: "governance_correlation",
        governance: "sekai-chisei",
        runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        operationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }}
    />,
  );
  assert.match(html, /disabled/);
});
