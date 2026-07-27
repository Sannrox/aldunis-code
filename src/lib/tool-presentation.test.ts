import assert from "node:assert/strict";
import test from "node:test";
import { presentToolRows, shortToolCallId } from "./tool-presentation";

test("shortToolCallId prefers hex body after call- prefix", () => {
  assert.equal(
    shortToolCallId("call-932a26ba-4650-4a56-b662-90ef5e54e39e-0"),
    "932a26-0",
  );
  assert.equal(
    shortToolCallId("call-932a26ba-4650-4a56-b662-90ef5e54e39e-3"),
    "932a26-3",
  );
  assert.equal(
    shortToolCallId("call-390fe8eb-783e-4bd3-b2fd-9bfb88266c29-4"),
    "390fe8-4",
  );
  assert.equal(shortToolCallId("tool-1"), "tool-1");
});

test("presentToolRows pairs start/finish and keeps names", () => {
  const rows = presentToolRows([
    { kind: "tool_started", toolCallId: "call-aaa111-0", name: "read_file" },
    { kind: "tool_started", toolCallId: "call-bbb222-1", name: "grep" },
    { kind: "tool_finished", toolCallId: "call-aaa111-0", failed: false },
    { kind: "tool_finished", toolCallId: "call-bbb222-1", failed: true },
  ]);
  assert.deepEqual(rows, [
    { toolCallId: "call-aaa111-0", name: "read_file", status: "done" },
    { toolCallId: "call-bbb222-1", name: "grep", status: "failed" },
  ]);
});

test("presentToolRows keeps running tools without a finish event", () => {
  const rows = presentToolRows([
    { kind: "tool_started", toolCallId: "call-ccc333", name: "list_dir" },
  ]);
  assert.deepEqual(rows, [
    { toolCallId: "call-ccc333", name: "list_dir", status: "running" },
  ]);
});
