import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedClaudeVersion,
  ClaudeCodeAdapter,
  normalizeClaudeEvent,
  ProviderProtocolError,
} from "./provider.ts";

test("normalizes provider lifecycle, text, tools, and completion", () => {
  assert.deepEqual(normalizeClaudeEvent({
    type: "system", subtype: "init", session_id: "session-1", model: "sonnet",
  }), [{ kind: "session_started", sessionId: "session-1", model: "sonnet" }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "assistant",
    message: { content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Done." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/secret" } },
    ] },
  }), [
    { kind: "assistant_text", text: "Done." },
    { kind: "tool_started", toolCallId: "tool-1", name: "Read" },
  ]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private" }] },
  }), [{ kind: "tool_finished", toolCallId: "tool-1", failed: false }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "result", session_id: "session-1", total_cost_usd: 0.01,
  }), [{ kind: "turn_completed", sessionId: "session-1", costUsd: 0.01 }]);
});

test("unknown, malformed, and incompatible provider data fail closed", () => {
  assert.throws(() => normalizeClaudeEvent({ type: "future_event" }), ProviderProtocolError);
  assert.throws(() => normalizeClaudeEvent({ type: "assistant", message: {} }), ProviderProtocolError);
  assert.equal(assertSupportedClaudeVersion("2.1.177 (Claude Code)"), "2.1.177");
  assert.throws(() => assertSupportedClaudeVersion("3.0.0"), /Unsupported Claude Code version/);
  assert.throws(() => assertSupportedClaudeVersion("not a version"), /Unsupported Claude Code version/);
});

test("provider errors are normalized without exposing raw diagnostics", () => {
  assert.deepEqual(normalizeClaudeEvent({
    type: "result", subtype: "error_during_execution", is_error: true,
    session_id: "session-1", result: "Authentication is required.",
  }), [{ kind: "failed", message: "Authentication is required." }]);
});

test("a running provider subprocess can be cancelled deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-"));
  const executable = join(directory, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("2.1.177 (Claude Code)");
} else {
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture"}));
  setInterval(() => {}, 1000);
}
`);
  await chmod(executable, 0o700);

  const adapter = new ClaudeCodeAdapter(executable);
  const run = await adapter.start(directory, "sensitive prompt");
  const events: Array<{ kind: string }> = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.kind === "session_started") assert.equal(adapter.cancel(run.id), true);
  }
  assert.deepEqual(events.map((event) => event.kind), ["session_started", "cancelled"]);
  assert.equal(adapter.cancel(run.id), false);
});
