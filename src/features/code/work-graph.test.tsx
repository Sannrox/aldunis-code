import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWorkGraph } from "../../lib/work-graph";
import { WorkGraphContent } from "./work-graph";

test("work graph content exposes beta provenance and accessible node labels", () => {
  const html = renderToStaticMarkup(
    <WorkGraphContent
      graph={buildWorkGraph([
        {
          kind: "plan_updated",
          artifact: {
            id: "plan-1",
            provider: "codex-cli",
            title: "Inspect and verify",
            steps: [{ content: "Inspect files", status: "pending" }],
          },
        },
        { kind: "tool_started", toolCallId: "call-1", name: "glob" },
      ])}
    />,
  );

  assert.match(html, />BETA</);
  assert.match(html, /Read-only map of provider intent and Aldunis-observed activity/);
  assert.match(html, /Inspect files, Provider-reported, planned/);
  assert.match(html, /Find files, Aldunis-observed, active/);
  assert.match(html, /Relationships are intentionally approximate in beta/);
});

test("empty work graph content explains why the beta is unavailable", () => {
  const html = renderToStaticMarkup(<WorkGraphContent graph={buildWorkGraph([])} />);

  assert.match(html, /No graph data yet/);
  assert.match(html, /observable provider activity/);
});
