import assert from "node:assert/strict";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedCodexVersion,
  codexAppServerArguments,
  codexFileChangePaths,
  CodexCliAdapter,
  normalizeCodexNotification,
  pathsWithinWorktree,
} from "./codex-provider.ts";
import { ProviderProtocolError } from "./provider.ts";

test("file-change approvals include move destinations", () => {
  assert.deepEqual(codexFileChangePaths({
    type: "fileChange",
    changes: [
      { path: "src/old.ts", kind: { type: "update", move_path: "src/new.ts" } },
      { path: "src/added.ts", kind: { type: "add" } },
    ],
  }), ["src/old.ts", "src/new.ts", "src/added.ts"]);
  assert.throws(() => codexFileChangePaths({
    type: "fileChange",
    changes: [
      { path: "src/valid.ts", kind: { type: "update" } },
      { kind: { type: "add" } },
    ],
  }), /malformed file change/);
});

test("approval paths cannot escape the selected worktree", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "aldunis-codex-worktree-"));
  await symlink(join(tmpdir(), "aldunis-missing-target"), join(worktree, "dangling-link"));
  assert.equal(await pathsWithinWorktree(worktree, [worktree, "src/new.ts"]), true);
  assert.equal(await pathsWithinWorktree(worktree, ["../outside"]), false);
  assert.equal(await pathsWithinWorktree(worktree, [tmpdir()]), false);
  assert.equal(await pathsWithinWorktree(worktree, ["dangling-link"]), false);
});

test("Codex version and native lifecycle events normalize without provider payload leakage", () => {
  assert.equal(assertSupportedCodexVersion("codex-cli 0.144.3"), "0.144.3");
  assert.equal(assertSupportedCodexVersion("codex-cli 0.92.0"), "0.92.0");
  assert.equal(assertSupportedCodexVersion("codex-cli 0.200.1"), "0.200.1");
  assert.throws(() => assertSupportedCodexVersion("codex-cli 0.50.0"), ProviderProtocolError);
  assert.throws(() => assertSupportedCodexVersion("codex-cli 1.0.0"), ProviderProtocolError);
  assert.equal(codexAppServerArguments("0.92.0").includes("--stdio"), false);
  assert.equal(codexAppServerArguments("0.144.3").includes("--stdio"), true);
  assert.deepEqual(normalizeCodexNotification({
    method: "item/started",
    params: { item: { id: "item-1", type: "commandExecution", command: "private" } },
  }), [{ kind: "tool_started", toolCallId: "item-1", name: "Command" }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "item/completed",
    params: { item: { id: "item-2", type: "agentMessage", text: "Done." } },
  }), [{ kind: "assistant_text", text: "Done." }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "item/completed",
    params: { item: { id: "item-1", type: "commandExecution", status: "failed", aggregatedOutput: "secret" } },
  }), [{ kind: "tool_finished", toolCallId: "item-1", failed: true }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "item/started",
    params: { item: { id: "item-3", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress" } },
  }), [{ kind: "tool_started", toolCallId: "item-3", name: "Subagent spawnAgent" }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "item/completed",
    params: { item: { id: "item-3", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed" } },
  }), [{ kind: "tool_finished", toolCallId: "item-3", failed: false }]);
});

test("Codex cancellation force-terminates an unresponsive app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-provider-"));
  const executable = join(directory, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.144.3");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"0199a213-81c0-7800-8aa1-bbab2a035a53"},model:"fixture"}
    }));
    if (message.id === 2) console.log(JSON.stringify({
      id:2,result:{turn:{id:"0199a213-81c0-7800-8aa1-bbab2a035a54"}}
    }));
  });
}
`);
  await chmod(executable, 0o700);
  const adapter = new CodexCliAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-1",
    prompt: "Wait",
    approvalUrl: "http://127.0.0.1:1/unused",
    mode: "build",
  });
  const kinds: string[] = [];
  for await (const event of run.events) {
    kinds.push(event.kind);
    if (event.kind === "session_started") {
      setTimeout(() => adapter.cancel(run.id), 50).unref();
    }
  }
  assert.deepEqual(kinds, ["session_started", "cancelled"]);
  assert.equal(adapter.cancel(run.id), false);
});

test("Codex dynamic-tool requests fail with an actionable policy explanation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-provider-"));
  const executable = join(directory, "fake-codex");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"0199a213-81c0-7800-8aa1-bbab2a035a53"},model:"fixture"}
    }));
    if (message.id === 2) {
      console.log(JSON.stringify({
        id:2,result:{turn:{id:"0199a213-81c0-7800-8aa1-bbab2a035a54"}}
      }));
      console.log(JSON.stringify({
        id:3,
        method:"item/tool/call",
        params:{
          threadId:"0199a213-81c0-7800-8aa1-bbab2a035a53",
          turnId:"0199a213-81c0-7800-8aa1-bbab2a035a54",
          callId:"private-call",
          namespace:null,
          tool:"private-tool",
          arguments:{secret:"must not be exposed"}
        }
      }));
    }
  });
}
`);
  await chmod(executable, 0o700);
  const adapter = new CodexCliAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-1",
    prompt: "Use an external tool",
    approvalUrl: "http://127.0.0.1:1/unused",
    mode: "build",
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(events, [
    {
      kind: "session_started",
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      model: "fixture",
    },
    {
      kind: "failed",
      code: "unsupported_external_tool",
      message: "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
    },
  ]);
  assert.equal(adapter.cancel(run.id), false);
});

test("unknown and malformed Codex notifications fail closed", () => {
  assert.throws(
    () => normalizeCodexNotification({ method: "future/event", params: {} }),
    /Unsupported Codex notification/,
  );
  assert.throws(
    () => normalizeCodexNotification({ method: "item\\/started", params: {} }),
    ProviderProtocolError,
  );
  assert.throws(
    () => normalizeCodexNotification({
      method: "item/started",
      params: { item: { id: "item-1", type: "futureMutation" } },
    }),
    /Unsupported Codex item type/,
  );
  assert.deepEqual(normalizeCodexNotification({
    method: "item/started",
    params: {
      item: {
        id: "item-2",
        type: "mcpToolCall",
        server: "private-server",
        tool: "private-tool",
        arguments: { secret: "must not be exposed" },
      },
    },
  }), [{
    kind: "failed",
    code: "unsupported_external_tool",
    message: "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
  }]);
});

test("interrupted and failed Codex turns normalize to terminal events", () => {
  assert.deepEqual(normalizeCodexNotification({
    method: "error",
    params: { error: { message: "Authentication expired." } },
  }), [{ kind: "failed", message: "Authentication expired." }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "turn/completed",
    params: { turn: { status: "interrupted", error: null } },
  }), [{ kind: "cancelled" }]);
  assert.deepEqual(normalizeCodexNotification({
    method: "turn/completed",
    params: { turn: { status: "failed", error: { message: "Provider unavailable." } } },
  }), [{ kind: "failed", message: "Provider unavailable." }]);
  assert.throws(() => normalizeCodexNotification({
    method: "turn/completed",
    params: { turn: { status: "future-status", error: null } },
  }), /Unsupported Codex turn status/);
});
