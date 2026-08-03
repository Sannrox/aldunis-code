import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedClaudeVersion,
  CLAUDE_AUTHENTICATION_FAILURE_MESSAGE,
  ClaudeCodeAdapter,
  modeArguments,
  normalizeClaudeEvent,
  ProviderProtocolError,
} from "./provider.ts";

test("normalizes provider lifecycle, text, tools, and completion", () => {
  assert.deepEqual(normalizeClaudeEvent({
    type: "system", subtype: "init", session_id: "session-1", model: "sonnet",
  }), [{ kind: "session_started", sessionId: "session-1", model: "sonnet" }]);
  // Non-init system events (compact_boundary, future subtypes) must not fail the turn.
  assert.deepEqual(normalizeClaudeEvent({
    type: "system", subtype: "compact_boundary", session_id: "session-1",
  }), []);
  assert.deepEqual(normalizeClaudeEvent({
    type: "system", subtype: "status", message: "working",
  }), []);
  assert.deepEqual(normalizeClaudeEvent({
    type: "assistant",
    message: { content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Done." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/secret" } },
    ] },
  }), [
    { kind: "thinking", text: "private" },
    { kind: "assistant_text", text: "Done." },
    {
      kind: "tool_requested",
      toolCallId: "tool-1",
      name: "Read",
      input: { file_path: "/secret" },
    },
  ]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private delta" },
    },
  }), [{ kind: "thinking", text: "private delta" }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "private" }] },
  }), [{ kind: "tool_finished", toolCallId: "tool-1", failed: false }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "result", session_id: "session-1", total_cost_usd: 0.01,
  }), [{ kind: "turn_completed", sessionId: "session-1", costUsd: 0.01 }]);
});

const supportedHelp = `--tools <tools...>
--permission-mode <mode> (choices: "acceptEdits", "default", "dontAsk", "plan")`;

test("interaction modes are derived from advertised provider capabilities", () => {
  assert.deepEqual(modeArguments("ask", supportedHelp), [
    "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep",
  ]);
  assert.deepEqual(modeArguments("plan", supportedHelp), ["--permission-mode", "plan"]);
  assert.deepEqual(modeArguments("build", supportedHelp), ["--permission-mode", "default"]);
  assert.throws(
    () => modeArguments("ask", "--permission-mode <mode> (choices: \"default\", \"plan\")"),
    /fail-closed read-only mode/,
  );
  assert.throws(
    () => modeArguments("build", "--permission-mode <mode> (choices: \"default\")"),
    /required interaction modes/,
  );
});

test("unknown, malformed, and incompatible provider data fail closed", () => {
  assert.throws(() => normalizeClaudeEvent({ type: "future_event" }), ProviderProtocolError);
  assert.throws(() => normalizeClaudeEvent({ type: "assistant", message: {} }), ProviderProtocolError);
  assert.equal(assertSupportedClaudeVersion("2.1.177 (Claude Code)"), "2.1.177");
  assert.throws(() => assertSupportedClaudeVersion("3.0.0"), /Unsupported Claude Code version/);
  assert.throws(() => assertSupportedClaudeVersion("not a version"), /Unsupported Claude Code version/);
});

test("Claude rate-limit and stream housekeeping events are ignored", () => {
  assert.deepEqual(normalizeClaudeEvent({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed" },
  }), []);
  assert.deepEqual(normalizeClaudeEvent({ type: "stream_event" }), []);
  assert.deepEqual(normalizeClaudeEvent({ type: "progress", message: "working" }), []);
});

test("provider errors are normalized without exposing raw diagnostics", () => {
  assert.deepEqual(normalizeClaudeEvent({
    type: "result", subtype: "error_during_execution", is_error: true,
    session_id: "session-1", result: "Authentication is required.",
  }), [{ kind: "failed", message: "Authentication is required." }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    error_status: 401,
    error: "authentication_failed",
    session_id: "session-1",
  }), [{
    kind: "failed",
    code: "provider_authentication",
    message: CLAUDE_AUTHENTICATION_FAILURE_MESSAGE,
  }]);
  assert.deepEqual(normalizeClaudeEvent({
    type: "system",
    subtype: "api_retry",
    error_status: 503,
    error: "service_unavailable",
  }), []);
});

test("Claude authentication retry terminates the provider process promptly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-auth-"));
  const executable = join(directory, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("2.1.177 (Claude Code)");
} else if (process.argv.includes("--help")) {
  console.log(${JSON.stringify(supportedHelp)});
} else {
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture"}));
  console.log(JSON.stringify({
    type:"system",
    subtype:"api_retry",
    attempt:1,
    max_retries:10,
    error_status:401,
    error:"authentication_failed",
    session_id:"fixture-session"
  }));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
`);
  await chmod(executable, 0o700);

  const adapter = new ClaudeCodeAdapter(executable);
  const run = await adapter.start(
    directory,
    directory,
    "conversation-auth",
    "hello",
    "http://127.0.0.1:4174/api/provider/permissions/request",
    "ask",
  );
  let timeout: NodeJS.Timeout | undefined;
  const events = await Promise.race([
    Array.fromAsync(run.events),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("authentication failure did not stop the provider")),
        3_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));

  assert.deepEqual(events, [
    { kind: "session_started", sessionId: "fixture-session", model: "fixture" },
    {
      kind: "failed",
      code: "provider_authentication",
      message: CLAUDE_AUTHENTICATION_FAILURE_MESSAGE,
    },
  ]);
});

test("provider capabilities expose typed commands and bounded local attachments", () => {
  const capabilities = new ClaudeCodeAdapter().capabilities();
  assert.equal(capabilities.provider, "claude-code");
  assert.deepEqual(capabilities.commands.map((command) => command.name), [
    "/compact",
    "/cost",
    "/help",
  ]);
  assert.equal(capabilities.attachments.maxCount, 8);
  assert.ok(capabilities.attachments.imageTypes.includes("image/png"));
});

test("a running provider subprocess can be cancelled deterministically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-"));
  const executable = join(directory, "fake-claude");
  const invocation = join(directory, "invocation.json");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("2.1.177 (Claude Code)");
} else if (process.argv.includes("--help")) {
  console.log(${JSON.stringify(supportedHelp)});
} else {
  require("node:fs").writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
    args: process.argv.slice(2),
    token: process.env.ALDUNIS_PROVIDER_RUN_TOKEN
  }));
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture"}));
  setInterval(() => {}, 1000);
}
`);
  await chmod(executable, 0o700);

  const adapter = new ClaudeCodeAdapter(executable);
  const run = await adapter.start(
    directory,
    directory,
    "conversation-1",
    "sensitive prompt",
    "http://127.0.0.1:4174/api/provider/permissions/request",
    "build",
  );
  const events: Array<{ kind: string }> = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.kind === "session_started") assert.equal(adapter.cancel(run.id), true);
  }
  assert.deepEqual(events.map((event) => event.kind), ["session_started", "cancelled"]);
  assert.equal(adapter.cancel(run.id), false);
  const launched = JSON.parse(await readFile(invocation, "utf8")) as {
    args: string[];
    token: string;
  };
  assert.ok(launched.token);
  assert.equal(launched.args.join(" ").includes(launched.token), false);
  assert.equal(
    launched.args.some((argument) => argument.includes("${ALDUNIS_PROVIDER_RUN_TOKEN}")),
    true,
  );
});

test("a mutating provider event outside Build mode fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-mode-"));
  const executable = join(directory, "fake-claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("2.1.177 (Claude Code)");
} else if (process.argv.includes("--help")) {
  console.log(${JSON.stringify(supportedHelp)});
} else {
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture"}));
  console.log(JSON.stringify({type:"assistant",message:{content:[
    {type:"tool_use",id:"tool-write",name:"Write",input:{file_path:"fixture.txt",content:"private"}}
  ]}}));
}
`);
  await chmod(executable, 0o700);

  const adapter = new ClaudeCodeAdapter(executable);
  const run = await adapter.start(
    directory,
    directory,
    "conversation-ask",
    "inspect only",
    "http://127.0.0.1:4174/api/provider/permissions/request",
    "ask",
  );
  const events: Array<{ kind: string; message?: string }> = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(events.map((event) => event.kind), [
    "session_started",
    "tool_started",
    "failed",
  ]);
  assert.match(events.at(-1)?.message ?? "", /mutating tool Write while ask mode was active/);
});
