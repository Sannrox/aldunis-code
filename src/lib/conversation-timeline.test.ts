import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../types";
import { presentAssistantTimeline } from "./conversation-timeline";

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
