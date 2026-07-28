import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../types";
import { presentAssistantTimeline } from "./conversation-timeline";
import { latestPlanFromEvents } from "./provider-plan";

test("presentAssistantTimeline keeps tools between assistant text segments", () => {
  const events: ProviderEvent[] = [
    { kind: "assistant_text", text: "First answer." },
    { kind: "tool_started", toolCallId: "call-abc12345", name: "Read" },
    { kind: "tool_finished", toolCallId: "call-abc12345", failed: false },
    { kind: "assistant_text", text: "Second answer." },
  ];

  assert.deepEqual(presentAssistantTimeline(events), [
    { kind: "text", text: "First answer." },
    {
      kind: "tools",
      rows: [{ toolCallId: "call-abc12345", name: "Read", status: "done" }],
    },
    { kind: "text", text: "Second answer." },
  ]);
});

test("presentAssistantTimeline updates a tool in its original group after later text", () => {
  const events: ProviderEvent[] = [
    { kind: "tool_started", toolCallId: "call-abc12345", name: "Command" },
    { kind: "assistant_text", text: "Working…" },
    { kind: "tool_finished", toolCallId: "call-abc12345", failed: false },
  ];

  assert.deepEqual(presentAssistantTimeline(events), [
    {
      kind: "tools",
      rows: [{ toolCallId: "call-abc12345", name: "Command", status: "done" }],
    },
    { kind: "text", text: "Working…" },
  ]);
});

test("presentAssistantTimeline marks unfinished tools cancelled for an interrupted turn", () => {
  const events: ProviderEvent[] = [
    { kind: "tool_started", toolCallId: "call-abc12345", name: "Agent" },
    { kind: "tool_started", toolCallId: "call-def67890", name: "Read" },
    { kind: "tool_finished", toolCallId: "call-def67890", failed: true },
  ];

  assert.deepEqual(presentAssistantTimeline(events, "cancelled"), [
    {
      kind: "tools",
      rows: [
        { toolCallId: "call-abc12345", name: "Agent", status: "cancelled" },
        { toolCallId: "call-def67890", name: "Read", status: "failed" },
      ],
    },
  ]);
});

test("plan updates stay at their first timeline position and replace the same card", () => {
  const events: ProviderEvent[] = [
    { kind: "assistant_text", text: "Before." },
    {
      kind: "plan_updated",
      artifact: { id: "turn:1", provider: "codex-cli", body: "Draft" },
    },
    { kind: "assistant_text", text: "After." },
    {
      kind: "plan_updated",
      artifact: {
        id: "turn:1",
        provider: "codex-cli",
        body: "Final",
        steps: [{ content: "Verify", status: "active" }],
      },
    },
  ];

  assert.deepEqual(presentAssistantTimeline(events), [
    { kind: "text", text: "Before." },
    {
      kind: "plan",
      artifact: {
        id: "turn:1",
        provider: "codex-cli",
        body: "Final",
        steps: [{ content: "Verify", status: "active" }],
      },
    },
    { kind: "text", text: "After." },
  ]);
});

test("streamed plan deltas append without creating duplicate cards", () => {
  const events: ProviderEvent[] = [
    {
      kind: "plan_updated",
      artifact: { id: "item:1", provider: "codex-cli", body: "One" },
      bodyMode: "append",
    },
    {
      kind: "plan_updated",
      artifact: { id: "item:1", provider: "codex-cli", body: " two" },
      bodyMode: "append",
    },
  ];
  assert.deepEqual(presentAssistantTimeline(events), [{
    kind: "plan",
    artifact: { id: "item:1", provider: "codex-cli", body: "One two" },
  }]);
});

test("latest plan uses last-update time without moving anchored restored cards", () => {
  const restored: ProviderEvent[] = [
    {
      kind: "plan_updated",
      artifact: {
        id: "plan-a",
        provider: "codex-cli",
        body: "A final",
        updatedAt: "2026-07-28T12:03:00.000Z",
      },
    },
    {
      kind: "plan_updated",
      artifact: {
        id: "plan-b",
        provider: "codex-cli",
        body: "B stale",
        updatedAt: "2026-07-28T12:02:00.000Z",
      },
    },
  ];
  assert.equal(latestPlanFromEvents([restored])?.id, "plan-a");
  assert.equal(latestPlanFromEvents([restored, [{
    kind: "plan_updated",
    artifact: { id: "plan-b", provider: "codex-cli", body: "B live" },
  }]])?.body, "B live");
});
