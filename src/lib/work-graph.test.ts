import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../types";
import { buildWorkGraph, hasWorkGraphEvidence } from "./work-graph";

test("work graph keeps provider intent separate from observed activity", () => {
  const events = [
    {
      kind: "plan_updated",
      artifact: {
        id: "plan-1",
        provider: "codex-cli",
        title: "Refresh the session boundary",
        steps: [
          { content: "Inspect the current services", status: "completed" },
          { content: "Update the session wiring", status: "active" },
        ],
      },
    },
    { kind: "tool_started", toolCallId: "call-1", name: "read_file" },
    { kind: "tool_finished", toolCallId: "call-1", failed: false },
    { kind: "approval_pending", id: "approval-1", toolName: "edit_file", state: "pending" },
    { kind: "turn_completed", sessionId: "session-1", costUsd: null },
  ] as ProviderEvent[];

  const graph = buildWorkGraph(events);

  assert.equal(graph.title, "Refresh the session boundary");
  assert.equal(graph.provider, "codex-cli");
  assert.equal(graph.plannedCount, 2);
  assert.equal(graph.observedCount, 3);
  assert.equal(graph.hasPlan, true);
  assert.equal(graph.hasObservedActivity, true);
  assert.deepEqual(
    graph.nodes.filter((node) => node.source === "plan").map((node) => node.label),
    ["Provider plan", "Inspect the current services", "Update the session wiring"],
  );
  assert.deepEqual(
    graph.nodes
      .filter((node) => node.source === "observed")
      .map((node) => [node.label, node.status]),
    [
      ["Observed execution", "completed"],
      ["Read file", "completed"],
      ["Approval · Edit file", "waiting"],
      ["Turn completed", "completed"],
    ],
  );
});

test("latest terminal outcome overrides a recoverable activity failure", () => {
  const graph = buildWorkGraph([
    { kind: "tool_started", toolCallId: "call-1", name: "edit_file" },
    { kind: "tool_finished", toolCallId: "call-1", failed: true },
    { kind: "turn_completed", sessionId: "session-1", costUsd: null },
  ] as ProviderEvent[]);

  assert.equal(graph.nodes[0]?.status, "completed");
  assert.equal(graph.nodes[1]?.status, "completed");
  assert.equal(graph.nodes[2]?.status, "failed");
});

test("plan step state contributes to aggregate status without observed events", () => {
  const active = buildWorkGraph([
    {
      kind: "plan_updated",
      artifact: {
        id: "plan-1",
        provider: "codex-cli",
        steps: [{ content: "Run the migration", status: "active" }],
      },
    },
  ] as ProviderEvent[]);
  const completed = buildWorkGraph([
    {
      kind: "plan_updated",
      artifact: {
        id: "plan-2",
        provider: "codex-cli",
        steps: [{ content: "Run the migration", status: "completed" }],
      },
    },
  ] as ProviderEvent[]);

  assert.equal(active.nodes[0]?.status, "active");
  assert.equal(completed.nodes[0]?.status, "completed");
});

test("work graph can represent observed activity without a provider plan", () => {
  const events = [
    { kind: "tool_started", toolCallId: "call-1", name: "grep" },
    { kind: "tool_finished", toolCallId: "call-1", failed: true },
    { kind: "failed", message: "sensitive provider detail" },
  ] as ProviderEvent[];

  const graph = buildWorkGraph(events);

  assert.equal(graph.hasPlan, false);
  assert.equal(graph.hasObservedActivity, true);
  assert.equal(graph.nodes[0]?.detail, "Observed activity only");
  assert.equal(
    graph.nodes.some((node) => node.label.includes("sensitive")),
    false,
  );
  assert.equal(graph.nodes.at(-1)?.label, "Provider failed");
});

test("work graph keeps a resolved input as observed evidence", () => {
  const graph = buildWorkGraph([
    { kind: "input_resolved", id: "input-1", state: "cancelled" },
  ] as ProviderEvent[]);

  assert.equal(graph.hasObservedActivity, true);
  assert.equal(graph.observedCount, 1);
  assert.deepEqual(
    graph.nodes
      .filter((node) => node.source === "observed")
      .map((node) => [node.label, node.status]),
    [
      ["Observed execution", "failed"],
      ["Input resolved", "failed"],
    ],
  );
});

test("work graph evidence ignores ordinary text and private provider observations", () => {
  assert.equal(
    hasWorkGraphEvidence([
      { kind: "assistant_text", text: "A plan-shaped paragraph" },
      { kind: "thinking", text: "private reasoning" },
      {
        kind: "browser_observation",
        provider: "codex-cli",
        observationId: "frame-1",
        imageData: "data:image/png;base64,AA==",
        mediaType: "image/png",
      },
    ]),
    false,
  );
  assert.equal(
    hasWorkGraphEvidence([{ kind: "tool_started", toolCallId: "call-1", name: "read_file" }]),
    true,
  );
});
