import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isMutatingTool, PermissionBroker } from "./permission.ts";
import {
  assertSupportedShikigamiVersion,
  buildShikigamiConfig,
  normalizeShikigamiEvent,
  parseShikigamiStderrLine,
  permissionHookRuntimeEnvironment,
  ShikigamiAdapter,
  ShikigamiToolIdTracker,
  toolsForMode,
} from "./shikigami-provider.ts";

test("assertSupportedShikigamiVersion accepts 1.0.2+ product lines", () => {
  assert.equal(assertSupportedShikigamiVersion("shikigami 1.0.2"), "1.0.2");
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 0.2.0"), /major version 1/);
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 1.0.1"), /1\.0\.2/);
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

test("buildShikigamiConfig encodes mode tool allow-lists and pre_tool gate", () => {
  assert.equal(toolsForMode("ask").includes("write_file"), false);
  assert.equal(toolsForMode("build").includes("write_file"), true);
  assert.equal(isMutatingTool("write_file"), true);
  assert.equal(isMutatingTool("read_file"), false);

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
    nodeExecutable: "/usr/bin/node",
    permissionHookPath: "/tmp/hook.mjs",
    permissionConfigPath: "/tmp/gate.json",
  });
  assert.match(build, /adapter = "http"/);
  assert.match(build, /"write_file"/);
  assert.match(build, /"apply_patch"/);
  assert.match(build, /"bash"/);
  assert.match(build, /"todo_write"/);
  assert.match(build, /event = "pre_tool"/);
  assert.match(build, /fail_closed = true/);
  assert.match(build, /hook\.mjs/);
});

test("Electron-hosted hooks run the embedded runtime as Node", () => {
  const source = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" };
  const electron = permissionHookRuntimeEnvironment(source, "43.2.0");
  const node = permissionHookRuntimeEnvironment(source, undefined);

  assert.notEqual(electron, source);
  assert.equal(electron.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(node.ELECTRON_RUN_AS_NODE, "unexpected");
  assert.deepEqual(source, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" });
});

test("ShikigamiAdapter streams events from a fixture CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
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
  const readiness = await adapter.readiness({
    ...process.env,
    SHIKIGAMI_MODEL_ADAPTER: "scripted",
  });
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, true);
  assert.equal(readiness.version, "1.0.2");
  assert.equal(readiness.detail, null);

  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "11111111-1111-4111-8111-111111111111",
    prompt: "demo task",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "build",
  }, { ...process.env, SHIKIGAMI_MODEL_ADAPTER: "scripted" });
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

test("ShikigamiAdapter readiness reports install detail when missing", async () => {
  const adapter = new ShikigamiAdapter("/nonexistent/shikigami-binary-aldunis-test");
  const readiness = await adapter.readiness(process.env);
  assert.equal(readiness.installed, false);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /Install shikigami 1\.0\.2\+/);
});

test("ShikigamiAdapter readiness reports unsupported version detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-version-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
console.log("shikigami 1.0.1");
`);
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const readiness = await adapter.readiness(process.env);
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /1\.0\.2/);
});

test("ShikigamiAdapter readiness reports missing HTTP key when forced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-http-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
console.log("shikigami 1.0.2");
`);
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const env = {
    ...process.env,
    SHIKIGAMI_MODEL_ADAPTER: "http",
    SHIKIGAMI_API_KEY_ENV: "OPENAI_API_KEY",
  };
  delete env.OPENAI_API_KEY;
  const readiness = await adapter.readiness(env);
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /OPENAI_API_KEY|SHIKIGAMI_API_KEY_ENV|scripted/);
});

test("ShikigamiAdapter normalizes a parked question as a child follow-up request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-park-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  console.error('[shikigami] {"type":"run_finished","run_id":"bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee","success":false,"summary":"need operator input"}');
  console.log("run bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee turns=1 success=false termination=parked summary=need operator input");
  console.log("parked reason=need operator input");
  console.log("parked question=continue?");
  process.exit(0);
}
process.exit(1);
`);
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "33333333-3333-4333-8333-333333333333",
    prompt: "park me",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "build",
  }, process.env);
  const events = [];
  for await (const event of run.events) events.push(event);
  const request = events.find((event) => event.kind === "input_requested");
  assert.equal(request?.kind, "input_requested");
  if (request?.kind === "input_requested") {
    assert.equal(request.question, "continue?");
    assert.equal(request.providerRequestId, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(request.responseMode, "child_follow_up");
  }
});

test("ShikigamiAdapter emits approval_pending for mutating tools in build mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-approve-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  const start = { type: "tool_start", name: "write_file", args_json: JSON.stringify({ path: "a.txt", content: "x" }) };
  console.error("[shikigami] " + JSON.stringify(start));
  console.error('[shikigami] {"type":"tool_end","name":"write_file","ok":true,"detail":"ok"}');
  console.error('[shikigami] {"type":"run_finished","run_id":"cccccccc-cccc-cccc-cccc-cccccccccccc","success":true,"summary":"wrote"}');
  process.exit(0);
}
process.exit(1);
`);
  await chmod(executable, 0o700);

  const permissions = new PermissionBroker();
  const adapter = new ShikigamiAdapter(executable, permissions);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "44444444-4444-4444-8444-444444444444",
    prompt: "write",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "build",
  }, process.env);

  const events = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.kind === "approval_pending") {
      permissions.decide(event.id, {
        runId: event.runId,
        conversationId: event.conversationId,
        repository: event.repository,
        worktree: event.worktree,
        toolCallId: event.toolCallId,
      }, "allow_once");
    }
  }
  assert.ok(events.some((event) => event.kind === "approval_pending"));
  assert.ok(events.some((event) => event.kind === "approval_resolved"));
  assert.ok(events.some((event) => event.kind === "tool_started"));
  assert.ok(events.some((event) => event.kind === "turn_completed"));
});

test("ShikigamiAdapter fails closed when mutating tools run outside build mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-ask-mutate-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  const start = { type: "tool_start", name: "write_file", args_json: JSON.stringify({ path: "a.txt", content: "x" }) };
  console.error("[shikigami] " + JSON.stringify(start));
  setInterval(() => {}, 1000);
}
process.exit(1);
`);
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "55555555-5555-4555-8555-555555555555",
    prompt: "should fail",
    approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
    mode: "ask",
  }, process.env);
  const events = [];
  for await (const event of run.events) events.push(event);
  const failed = events.find((event) => event.kind === "failed");
  assert.equal(failed?.kind, "failed");
  if (failed?.kind === "failed") {
    assert.match(failed.message, /write_file/);
    assert.match(failed.message, /ask mode/);
  }
});

test("shikigami permission hook allows once and denies via PermissionBroker", async () => {
  const permissions = new PermissionBroker(30_000);
  const runId = "run-hook-1";
  const token = permissions.createRunToken(runId);
  const toolInput = { path: "a.txt", content: "hello" };
  const denyInput = { path: "b.txt", content: "nope" };

  let resolveRequest: ((body: { toolName: string; input: unknown }) => void) | null = null;
  const nextRequest = () => new Promise<{ toolName: string; input: unknown }>((resolve) => {
    resolveRequest = resolve;
  });

  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        runId: string;
        toolName: string;
        input: unknown;
      };
      const authorization = request.headers.authorization ?? "";
      // Attach to the pending approval before the test resolves it.
      const resultPromise = permissions.awaitDecision(
        body.runId,
        authorization.slice("Bearer ".length),
        body.toolName,
        body.input,
      );
      resolveRequest?.({ toolName: body.toolName, input: body.input });
      resolveRequest = null;
      const result = await resultPromise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "failed",
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const approvalUrl = `http://127.0.0.1:${address.port}/api/provider/permissions/request`;

  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-hook-"));
  const configPath = join(directory, "gate.json");
  await writeFile(configPath, JSON.stringify({
    approvalUrl,
    runId,
    token,
    mutatingTools: ["write_file", "edit", "bash"],
  }));

  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const hookPath = fileURLToPath(new URL("./shikigami-permission-hook.mjs", import.meta.url));

  const runHook = (payload: object) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [hookPath, configPath], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });

  const approval = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:1",
    toolName: "write_file",
    toolInput,
    provider: "Shikigami",
  });
  assert.ok(approval);
  const allowSeen = nextRequest();
  const allowWait = runHook({
    event: "pre_tool",
    payload: { run_id: "h1", tool: "write_file", args_json: JSON.stringify(toolInput) },
  });
  await allowSeen;
  permissions.decide(approval.id, {
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:1",
  }, "allow_once");
  const allowed = await allowWait;
  assert.equal(allowed.code, 0, allowed.stderr);

  const identicalInput = { path: "same.txt", content: "same" };
  const firstIdentical = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-1",
    toolName: "write_file",
    toolInput: identicalInput,
    provider: "Shikigami",
  });
  const secondIdentical = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-2",
    toolName: "write_file",
    toolInput: identicalInput,
    provider: "Shikigami",
  });
  assert.ok(firstIdentical);
  assert.ok(secondIdentical);

  const firstIdenticalSeen = nextRequest();
  const firstIdenticalWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(identicalInput),
    },
  });
  await firstIdenticalSeen;
  const secondIdenticalSeen = nextRequest();
  let secondIdenticalSettled = false;
  const secondIdenticalWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(identicalInput),
    },
  }).finally(() => {
    secondIdenticalSettled = true;
  });
  await secondIdenticalSeen;

  permissions.decide(firstIdentical.id, {
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-1",
  }, "allow_once");
  const firstIdenticalResult = await firstIdenticalWait;
  assert.equal(firstIdenticalResult.code, 0, firstIdenticalResult.stderr);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondIdenticalSettled, false, "one allow-once must not release an identical operation");

  permissions.decide(secondIdentical.id, {
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-2",
  }, "deny");
  const secondIdenticalResult = await secondIdenticalWait;
  assert.equal(secondIdenticalResult.code, 1, secondIdenticalResult.stderr);

  const denyApproval = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:2",
    toolName: "write_file",
    toolInput: denyInput,
    provider: "Shikigami",
  });
  assert.ok(denyApproval);
  const denySeen = nextRequest();
  const denyWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(denyInput),
    },
  });
  await denySeen;
  permissions.decide(denyApproval.id, {
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:2",
  }, "deny");
  const denied = await denyWait;
  assert.equal(denied.code, 1, denied.stderr);

  const skip = await runHook({
    event: "pre_tool",
    payload: { run_id: "h1", tool: "read_file", args_json: "{\"path\":\"a.txt\"}" },
  });
  assert.equal(skip.code, 0);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("ShikigamiAdapter cancel stops a long-running fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-cancel-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
console.error('[shikigami] {"type":"status","status":"running"}');
process.on("SIGTERM", () => {
  console.log("run bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee termination=parked");
  console.log("parked question=should not survive cancellation?");
  process.exit(0);
});
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
  assert.ok(!kinds.includes("input_requested"));
  assert.equal(adapter.cancel(run.id), false);
});
