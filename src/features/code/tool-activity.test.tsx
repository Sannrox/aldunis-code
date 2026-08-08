import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolActivity } from "./tool-activity";

test("ToolActivity keeps the latest call visible and groups older calls behind disclosure", () => {
  const html = renderToStaticMarkup(
    <ToolActivity
      providerLabel="Codex CLI"
      groupId="current-tools-0"
      rows={[
        { toolCallId: "call-read", name: "read_file", status: "done" },
        { toolCallId: "call-search", name: "search_replace", status: "done" },
        { toolCallId: "call-run", name: "run_terminal_command", status: "running" },
      ]}
    />,
  );

  assert.match(html, /Run terminal command/);
  assert.match(html, /\+2 previous tool calls/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /tool-log-status-spinner/);
  assert.doesNotMatch(html, /read_file/);
  assert.doesNotMatch(html, /search_replace/);
});

test("ToolActivity does not add disclosure chrome for one call", () => {
  const html = renderToStaticMarkup(
    <ToolActivity
      providerLabel="Claude Code"
      groupId="archived-tools-0"
      rows={[{ toolCallId: "call-read", name: "read_file", status: "done" }]}
    />,
  );

  assert.match(html, /Read file/);
  assert.doesNotMatch(html, /tool-log-toggle/);
  assert.match(html, /tool-log-status-done/);
});

test("ToolActivity counts failures only among hidden calls", () => {
  const html = renderToStaticMarkup(
    <ToolActivity
      providerLabel="Codex CLI"
      groupId="current-tools-1"
      rows={[
        { toolCallId: "call-read", name: "read_file", status: "done" },
        { toolCallId: "call-search", name: "search_replace", status: "failed" },
        { toolCallId: "call-run", name: "run_terminal_command", status: "failed" },
      ]}
    />,
  );

  assert.match(html, /\+2 previous tool calls · 1 failed/);
});
