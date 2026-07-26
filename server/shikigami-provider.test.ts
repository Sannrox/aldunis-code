import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedShikigamiVersion,
  buildShikigamiConfig,
  normalizeShikigamiEvent,
  parseShikigamiStderrLine,
  ShikigamiAdapter,
  ShikigamiToolIdTracker,
} from "./shikigami-provider.ts";

test("assertSupportedShikigamiVersion accepts 1.0.1+ product lines", () => {
  assert.equal(assertSupportedShikigamiVersion("shikigami 1.0.1"), "1.0.1");
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 0.2.0"), /major version 1/);
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 1.0.0"), /1\.0\.1/);
});

test("normalizeShikigamiEvent maps harness events", () => {
  const tools = new ShikigamiToolIdTracker();
  const start = normalizeShikigamiEvent(
    { type: "tool_start", name: "read_file", args_json: "{}" },
    tools,
  );
  const end = normalizeShikigamiEvent(
    { type: "tool_end", name: "read_file", ok: true, detail: "ok" },
    tools,
  );
  assert.equal(start[0]?.kind, "tool_started");
  assert.equal(end[0]?.kind, "tool_finished");
  if (start[0]?.kind === "tool_started" && end[0]?.kind === "tool_finished") {
    assert.equal(start[0].toolCallId, end[0].toolCallId);
  }
  const finished = normalizeShikigamiEvent({
    type: "run_finished",
    run_id: "run-1",
    success: true,
    summary: "done",
  });
  assert.equal(finished.at(-1)?.kind, "turn_completed");
  assert.deepEqual(normalizeShikigamiEvent({ type: "future_event_type" }), []);
});

test("parseShikigamiStderrLine ignores non-event output", () => {
  assert.equal(parseShikigamiStderrLine("noise"), null);
  assert.deepEqual(
    parseShikigamiStderrLine('[shikigami] {"type":"status","status":"running"}'),
    [{ kind: "assistant_text", text: "status: running" }],
  );
});

test("buildShikigamiConfig encodes mode tool allow-lists", () => {
  const ask = buildShikigamiConfig({
    worktree: "/tmp/ws",
    mode: "ask",
    modelAdapter: "scripted",
    modelId: "scripted",
  });
  assert.match(ask, /adapter = "scripted"/);
  assert.match(ask, /"read_file"/);
  assert.doesNotMatch(ask, /"write_file"/);

  const build = buildShikigamiConfig({
    worktree: "/tmp/ws",
    mode: "build",
    modelAdapter: "http",
    modelId: "gpt-4.1-mini",
  });
  assert.match(build, /adapter = "http"/);
  // Mutating tools stay disabled until Code mid-turn approval is wired.
  assert.doesNotMatch(build, /"write_file"/);
  assert.doesNotMatch(build, /"apply_patch"/);
  assert.match(build, /"todo_write"/);
});

test("ShikigamiAdapter streams events from a fixture CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.1");
  process.exit(0);
}
if (args.includes("run")) {
  console.error('[shikigami] {"type":"tool_start","name":"report","args_json":"{}"}');
  console.error('[shikigami] {"type":"tool_end","name":"report","ok":true,"detail":"ok"}');
  console.error('[shikigami] {"type":"run_finished","run_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","success":true,"summary":"fixture complete"}');
  console.log("run aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee turns=1 success=true termination=completed summary=fixture complete");
  process.exit(0);
}
console.error("unexpected");
process.exit(1);
`);
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const readiness = await adapter.readiness(process.env);
  assert.equal(readiness.installed, true);
  assert.equal(readiness.version, "1.0.1");

  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "11111111-1111-4111-8111-111111111111",
    prompt: "demo task",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "build",
  }, process.env);
  const kinds: string[] = [];
  for await (const event of run.events) kinds.push(event.kind);
  assert.deepEqual(kinds, [
    "session_started",
    "tool_started",
    "tool_finished",
    "assistant_text",
    "turn_completed",
  ]);
});

test("ShikigamiAdapter cancel stops a long-running fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-cancel-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.1");
  process.exit(0);
}
console.error('[shikigami] {"type":"status","status":"running"}');
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "22222222-2222-4222-8222-222222222222",
    prompt: "hang",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "ask",
  }, process.env);
  const kinds: string[] = [];
  for await (const event of run.events) {
    kinds.push(event.kind);
    if (event.kind === "session_started") assert.equal(adapter.cancel(run.id), true);
  }
  assert.ok(kinds.includes("session_started"));
  assert.ok(kinds.includes("cancelled") || kinds.includes("failed"));
  assert.equal(adapter.cancel(run.id), false);
});
