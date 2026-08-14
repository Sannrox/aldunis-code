import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSupportedCodexVersion,
  codexAppServerArguments,
  codexFileChangePaths,
  CodexCliAdapter,
  isRecoverableCodexResumeError,
  MAX_IDLE_CODEX_SESSIONS,
  normalizeCodexNotification,
  pathsWithinWorktree,
} from "./codex-provider.ts";
import { JsonLineWriter } from "./json-line-writer.mjs";
import { ProviderProtocolError } from "./provider.ts";

class FakeCodexTimers {
  readonly pending = new Set<{ callback: () => void; unref(): void }>();

  setTimeout = (callback: () => void) => {
    const handle = { callback, unref() {} };
    this.pending.add(handle);
    return handle;
  };

  clearTimeout = (handle: { callback: () => void; unref(): void }) => {
    this.pending.delete(handle);
  };

  fireNext(): void {
    const handle = this.pending.values().next().value;
    assert.ok(handle);
    this.pending.delete(handle);
    handle.callback();
  }
}

test("Codex retains at most two idle app-server sessions by default", () => {
  assert.equal(MAX_IDLE_CODEX_SESSIONS, 2);
});

const TEST_BROWSER_MCP = {
  name: "aldunis_browser",
  command: "/usr/bin/node",
  args: ["/browser-mcp.mjs"],
  environment: { ALDUNIS_BROWSER_TOKEN: "fixture-token" },
};

test("file-change approvals include move destinations", () => {
  assert.deepEqual(
    codexFileChangePaths({
      type: "fileChange",
      changes: [
        { path: "src/old.ts", kind: { type: "update", move_path: "src/new.ts" } },
        { path: "src/added.ts", kind: { type: "add" } },
      ],
    }),
    ["src/old.ts", "src/new.ts", "src/added.ts"],
  );
  assert.throws(
    () =>
      codexFileChangePaths({
        type: "fileChange",
        changes: [{ path: "src/valid.ts", kind: { type: "update" } }, { kind: { type: "add" } }],
      }),
    /malformed file change/,
  );
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
  const browserArgs = codexAppServerArguments("0.145.0", {
    name: "aldunis_browser",
    command: "/usr/bin/node",
    args: ["/app/browser-mcp.mjs"],
    environment: {
      ALDUNIS_BROWSER_TOKEN: "token",
      ALDUNIS_BROWSER_TOOL_URL: "http://127.0.0.1:4173/api/browser/tools",
    },
  });
  assert.match(browserArgs.join(" "), /mcp_servers\.aldunis_browser/);
  assert.match(browserArgs.join(" "), /ALDUNIS_BROWSER_TOOL_URL/);
  assert.ok(
    browserArgs.indexOf("mcp_servers={}") <
      browserArgs.findIndex((value) => value.includes("mcp_servers.aldunis_browser")),
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 40_000,
            inputTokens: 30_000,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 10_000,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 12_500,
            inputTokens: 10_000,
            cachedInputTokens: 1_000,
            cacheWriteInputTokens: 0,
            outputTokens: 2_500,
            reasoningOutputTokens: 200,
          },
          modelContextWindow: 258_000,
        },
      },
    }),
    [
      {
        kind: "context_usage",
        // last.totalTokens (12500) − reasoningOutputTokens (200)
        usedTokens: 12_300,
        maxTokens: 258_000,
        totalProcessedTokens: 40_000,
        inputTokens: 10_000,
        outputTokens: 2_500,
        cachedInputTokens: 1_000,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 200,
      },
    ],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 40_000 },
          modelContextWindow: 258_000,
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: {} },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/started",
      params: { item: { id: "item-1", type: "commandExecution", command: "private" } },
    }),
    [{ kind: "tool_started", toolCallId: "item-1", name: "Command" }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: { item: { id: "item-2", type: "agentMessage", text: "Done." } },
    }),
    [{ kind: "assistant_text", text: "Done." }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/reasoning/textDelta",
      params: { itemId: "reasoning-1", delta: "private reasoning" },
    }),
    [{ kind: "thinking", text: "private reasoning" }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "item-1",
          type: "commandExecution",
          status: "failed",
          aggregatedOutput: "secret",
        },
      },
    }),
    [{ kind: "tool_finished", toolCallId: "item-1", failed: true }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/started",
      params: {
        item: {
          id: "item-3",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
        },
      },
    }),
    [{ kind: "tool_started", toolCallId: "item-3", name: "Subagent spawnAgent" }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "item-3",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
        },
      },
    }),
    [{ kind: "tool_finished", toolCallId: "item-3", failed: false }],
  );
  const inlineImage = Buffer.from("codex browser frame", "utf8").toString("base64");
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: { id: "image-1", type: "imageView", imageData: inlineImage, mimeType: "image/webp" },
      },
    }),
    [
      {
        kind: "browser_observation",
        provider: "codex-cli",
        observationId: "image-1",
        imageData: `data:image/webp;base64,${inlineImage}`,
        mediaType: "image/webp",
      },
    ],
  );
  // The shipped Codex schema exposes a local path. It must not become a file
  // read or a browser view merely because the provider emitted an imageView.
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: { id: "path-image", type: "imageView", path: "/private/provider/image.png" },
      },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "thread/goal/cleared",
      params: { threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "thread/goal/updated",
      params: {
        threadId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
        goal: { objective: "Ship safely", status: "active" },
      },
    }),
    [],
  );
  // Codex 0.145+ housekeeping and ThreadItem variants must not kill the turn.
  for (const method of [
    "thread/compacted",
    "hook/started",
    "hook/completed",
    "process/exited",
    "process/outputDelta",
    "command/exec/outputDelta",
    "rawResponse/completed",
    "rawResponseItem/completed",
    "guardianWarning",
    "fs/changed",
    "fuzzyFileSearch/sessionUpdated",
    "mcpServer/oauthLogin/completed",
    "account/login/completed",
  ]) {
    assert.deepEqual(normalizeCodexNotification({ method, params: { threadId: "thread-1" } }), []);
  }
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/started",
      params: {
        item: {
          id: "search-1",
          type: "webSearch",
          query: "aldunis protocol",
          action: null,
          results: null,
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/started",
      params: {
        item: {
          id: "msg-empty",
          type: "agentMessage",
          text: "",
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    }),
    [],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "msg-empty",
          type: "agentMessage",
          text: "",
          phase: "final_answer",
          memoryCitation: null,
        },
      },
    }),
    [],
  );
  assert.throws(
    () =>
      normalizeCodexNotification({
        method: "item/completed",
        params: {
          item: {
            id: "msg-missing-text",
            type: "agentMessage",
            phase: "final_answer",
            memoryCitation: null,
          },
        },
      }),
    /missing agent text/,
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "rs-1",
          type: "reasoning",
          summary: ["Considered the protocol surface."],
          content: [],
        },
      },
    }),
    [{ kind: "thinking", text: "Considered the protocol surface." }],
  );
});

test("Codex readiness cancellation terminates its temporary app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-readiness-cancel-"));
  const executable = join(directory, "fake-codex");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
  process.exit(0);
}
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = new CodexCliAdapter(executable).readiness(controller.signal);
  while (!(await readFile(pidPath, "utf8").catch(() => ""))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  const pid = Number(await readFile(pidPath, "utf8"));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
  }
  process.kill(pid, "SIGKILL");
  assert.fail("cancelled Codex readiness child remained active");
});

test("Codex plan notifications normalize as stable artifacts and reject malformed steps", () => {
  assert.deepEqual(
    normalizeCodexNotification({
      method: "turn/plan/updated",
      params: {
        turnId: "turn-1",
        explanation: "Implementation plan",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ],
      },
    }),
    [
      {
        kind: "plan_updated",
        artifact: {
          id: "turn:turn-1",
          provider: "codex-cli",
          body: "Implementation plan",
          steps: [
            { content: "Inspect", status: "completed" },
            { content: "Implement", status: "active" },
            { content: "Verify", status: "pending" },
          ],
        },
      },
    ],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/plan/delta",
      params: { itemId: "plan-1", delta: "First chunk" },
    }),
    [
      {
        kind: "plan_updated",
        artifact: { id: "item:plan-1", provider: "codex-cli", body: "First chunk" },
        bodyMode: "append",
      },
    ],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: { item: { id: "plan-1", type: "plan", text: "Final plan" } },
    }),
    [
      {
        kind: "plan_updated",
        artifact: { id: "item:plan-1", provider: "codex-cli", body: "Final plan" },
      },
    ],
  );
  assert.throws(
    () =>
      normalizeCodexNotification({
        method: "turn/plan/updated",
        params: { turnId: "turn-1", plan: [{ step: "Inspect", status: "invented" }] },
      }),
    /Unsupported Codex plan step status/,
  );
});

test("Codex resumes fall back only for missing provider threads", () => {
  assert.equal(isRecoverableCodexResumeError({ message: "thread not found" }), true);
  assert.equal(isRecoverableCodexResumeError({ message: "no rollout found for thread abc" }), true);
  assert.equal(isRecoverableCodexResumeError({ message: "authentication required" }), false);
  assert.equal(isRecoverableCodexResumeError({ message: "thread permission denied" }), false);
});

test("Codex reuses recent app-server sessions and bounds idle process lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-session-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  let turn = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"thread-" + process.pid},model:"fixture"}
    }));
    if (message.id === 2) {
      turn += 1;
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-" + turn}}}));
      console.log(JSON.stringify({
        method:"turn/completed",
        params:{threadId:"thread-" + process.pid,turn:{id:"turn-" + turn,status:"completed"}}
      }));
    }
  });
}
`,
  );
  await chmod(executable, 0o700);
  const timers = new FakeCodexTimers();
  const closed: string[] = [];
  const adapter = new CodexCliAdapter(executable, undefined, {
    idleSessionTtlMs: 1_000,
    maxIdleSessions: 1,
    onSessionClosed: (conversationId) => closed.push(conversationId),
    timers,
  });
  try {
    const first = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-1",
      prompt: "First",
      approvalUrl: "http://127.0.0.1:1/unused",
      browserMcp: TEST_BROWSER_MCP,
      mode: "build",
    });
    const firstEvents = [];
    for await (const event of first.events) firstEvents.push(event);
    const session = firstEvents.find((event) => event.kind === "session_started");
    assert.equal(session?.kind, "session_started");
    assert.equal(adapter.retainedIdleSessionCount, 1);
    assert.equal(timers.pending.size, 1);

    const second = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-1",
      prompt: "Second",
      approvalUrl: "http://127.0.0.1:1/unused",
      resumeSessionId: session?.kind === "session_started" ? session.sessionId : undefined,
      browserMcp: TEST_BROWSER_MCP,
      mode: "build",
    });
    const secondEvents = [];
    for await (const event of second.events) secondEvents.push(event);
    assert.deepEqual(secondEvents, [
      {
        kind: "turn_completed",
        sessionId: session?.kind === "session_started" ? session.sessionId : "",
        costUsd: null,
      },
    ]);
    assert.equal(adapter.retainedIdleSessionCount, 1);
    assert.equal(timers.pending.size, 1);

    timers.fireNext();
    assert.equal(adapter.retainedIdleSessionCount, 0);
    assert.deepEqual(closed, ["conversation-1"]);

    const resumed = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-1",
      prompt: "After idle expiry",
      approvalUrl: "http://127.0.0.1:1/unused",
      resumeSessionId: session?.kind === "session_started" ? session.sessionId : undefined,
      browserMcp: TEST_BROWSER_MCP,
      mode: "build",
    });
    const resumedEvents = [];
    for await (const event of resumed.events) resumedEvents.push(event);
    const resumedSession = resumedEvents.find((event) => event.kind === "session_started");
    assert.equal(resumedSession?.kind, "session_started");
    if (session?.kind === "session_started" && resumedSession?.kind === "session_started") {
      assert.notEqual(resumedSession.sessionId, session.sessionId);
    }

    const other = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-2",
      prompt: "Other conversation",
      approvalUrl: "http://127.0.0.1:1/unused",
      browserMcp: TEST_BROWSER_MCP,
      mode: "build",
    });
    for await (const _event of other.events) {
      // Drain the fixture turn.
    }
    assert.equal(adapter.retainedIdleSessionCount, 1);
    assert.deepEqual(closed, ["conversation-1", "conversation-1"]);

    const zeroLimitClosed: string[] = [];
    const zeroLimitAdapter = new CodexCliAdapter(executable, undefined, {
      maxIdleSessions: 0,
      onSessionClosed: (conversationId) => zeroLimitClosed.push(conversationId),
      timers: new FakeCodexTimers(),
    });
    try {
      const zeroLimitRun = await zeroLimitAdapter.start({
        repository: directory,
        worktree: directory,
        conversationId: "conversation-zero",
        prompt: "Do not retain",
        approvalUrl: "http://127.0.0.1:1/unused",
        browserMcp: TEST_BROWSER_MCP,
        mode: "build",
      });
      for await (const _event of zeroLimitRun.events) {
        // Drain the fixture turn.
      }
      assert.equal(zeroLimitAdapter.retainedIdleSessionCount, 0);
      assert.deepEqual(zeroLimitClosed, ["conversation-zero"]);
    } finally {
      zeroLimitAdapter.close();
    }

    const withoutBrowser = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-2",
      prompt: "Replace without browser MCP",
      approvalUrl: "http://127.0.0.1:1/unused",
      mode: "build",
    });
    for await (const _event of withoutBrowser.events) {
      // Drain the replacement fixture turn.
    }
    assert.deepEqual(closed, ["conversation-1", "conversation-1", "conversation-2"]);
  } finally {
    adapter.close();
  }
});

test("Codex releases retained session state when app-server spawn fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-spawn-failure-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  fs.unlinkSync(__filename);
  console.log("codex-cli 0.145.0");
}
`,
  );
  await chmod(executable, 0o700);
  const closed: string[] = [];
  const adapter = new CodexCliAdapter(executable, undefined, {
    onSessionClosed: (conversationId) => closed.push(conversationId),
  });
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-spawn-failure",
    prompt: "Fail to spawn",
    approvalUrl: "http://127.0.0.1:1/unused",
    browserMcp: TEST_BROWSER_MCP,
    mode: "build",
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  for (let attempt = 0; attempt < 20 && closed.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(events.at(-1)?.kind, "failed");
  assert.equal(adapter.retainedIdleSessionCount, 0);
  assert.deepEqual(closed, ["conversation-spawn-failure"]);
});

test("Codex does not close a session before start transfers ownership", async () => {
  const closed: string[] = [];
  const adapter = new CodexCliAdapter("missing-codex-fixture", undefined, {
    onSessionClosed: (conversationId) => closed.push(conversationId),
  });
  await assert.rejects(
    () =>
      adapter.start({
        repository: "/repo",
        worktree: "/repo",
        conversationId: "conversation-not-started",
        prompt: "Unavailable",
        approvalUrl: "http://127.0.0.1:1/unused",
        browserMcp: TEST_BROWSER_MCP,
        mode: "build",
      }),
    /not installed or could not be started/,
  );
  assert.deepEqual(closed, []);
});

test("Codex session reuse cannot leak abandoned tool state into the next turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-session-reset-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  let turn = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"thread-1"},model:"fixture"}
    }));
    if (message.id === 2) {
      turn += 1;
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-" + turn}}}));
      if (turn === 1) {
        console.log(JSON.stringify({
          method:"item/started",
          params:{item:{id:"abandoned-command",type:"commandExecution",command:"private"}}
        }));
      } else {
        console.log(JSON.stringify({
          method:"turn/completed",
          params:{threadId:"thread-1",turn:{id:"turn-" + turn,status:"completed"}}
        }));
      }
    }
  });
}
`,
  );
  await chmod(executable, 0o700);
  const adapter = new CodexCliAdapter(executable);
  try {
    const first = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-1",
      prompt: "First",
      approvalUrl: "http://127.0.0.1:1/unused",
      mode: "build",
    });
    let sessionId = "";
    for await (const event of first.events) {
      if (event.kind === "session_started") sessionId = event.sessionId;
      if (event.kind === "tool_started") break;
    }

    const second = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-1",
      prompt: "Second",
      approvalUrl: "http://127.0.0.1:1/unused",
      resumeSessionId: sessionId,
      mode: "build",
    });
    const secondEvents = [];
    for await (const event of second.events) secondEvents.push(event);
    assert.deepEqual(secondEvents, [
      {
        kind: "turn_completed",
        sessionId: "thread-1",
        costUsd: null,
      },
    ]);
  } finally {
    adapter.close();
  }
});

test("Codex native input requests normalize and resume only after the bound answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-input-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"thread-input"},model:"fixture"}
    }));
    if (message.id === 2) {
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-input"}}}));
      console.log(JSON.stringify({
        id:42,
        method:"item/tool/requestUserInput",
        params:{
          threadId:"thread-input",
          turnId:"turn-input",
          itemId:"item-input",
          autoResolutionMs:60000,
          questions:[{
            id:"strategy",
            header:"Strategy",
            question:"Choose a strategy",
            options:[{label:"Safe",description:"Preserve compatibility"}]
          }]
        }
      }));
    }
    if (message.id === 42 && message.result?.answers?.strategy?.answers?.[0] === "Safe") {
      console.log(JSON.stringify({
        method:"turn/completed",
        params:{threadId:"thread-input",turn:{id:"turn-input",status:"completed"}}
      }));
    }
  });
}
`,
  );
  await chmod(executable, 0o700);
  const settled: Array<{ runId: string; requestId: string }> = [];
  const adapter = new CodexCliAdapter(executable, undefined, {
    onInputSettled: (runId, requestId) => settled.push({ runId, requestId }),
  });
  try {
    const run = await adapter.start({
      repository: directory,
      worktree: directory,
      conversationId: "conversation-input",
      prompt: "Ask",
      approvalUrl: "http://127.0.0.1:1/unused",
      mode: "build",
    });
    const events = [];
    for await (const event of run.events) {
      events.push(event);
      if (event.kind === "input_requested") {
        assert.equal(event.responseMode, "native_resume");
        assert.equal(event.choices[0].label, "Safe");
        assert.equal(adapter.answerInput(run.id, event.id, "Safe"), true);
        assert.equal(adapter.answerInput(run.id, event.id, "Safe"), false);
      }
    }
    assert.ok(events.some((event) => event.kind === "turn_completed"));
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.runId, run.id);
  } finally {
    adapter.close();
  }
});

test("Codex skills expose enabled metadata without local paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-skills-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.144.3");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({id:1,result:{data:[{
      cwd:${JSON.stringify(directory)},
      errors:[],
      skills:[
        {name:"zeta",description:"Zeta skill",path:"/private/zeta",scope:"user",enabled:true},
        {name:"alpha",description:"Alpha skill",path:"/private/alpha",scope:"repo",enabled:true},
        {name:"disabled",description:"Disabled skill",path:"/private/disabled",scope:"repo",enabled:false}
      ]
    }]}}));
  });
}
`,
  );
  await chmod(executable, 0o700);
  assert.deepEqual(await new CodexCliAdapter(executable).skills(directory), [
    { name: "alpha", description: "Alpha skill" },
    { name: "zeta", description: "Zeta skill" },
  ]);
});

test("Codex skills abort terminates the temporary app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-skills-abort-"));
  const executable = join(directory, "fake-codex");
  const started = join(directory, "started");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.144.3");
} else {
  require("node:fs").writeFileSync(${JSON.stringify(started)}, String(process.pid));
  setInterval(() => {}, 1000);
}
`,
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = new CodexCliAdapter(executable).skills(directory, controller.signal);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(started);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(started);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
});

test("Codex cancellation force-terminates an unresponsive app-server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-provider-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
    if (message.id === 2) console.log(JSON.stringify({
      method:"item/started",
      params:{item:{id:"command-before-cancel",type:"commandExecution",command:"private"}}
    }));
    if (message.id === 2) console.log(JSON.stringify({
      id:42,
      method:"item/tool/requestUserInput",
      params:{
        threadId:"0199a213-81c0-7800-8aa1-bbab2a035a53",
        turnId:"0199a213-81c0-7800-8aa1-bbab2a035a54",
        itemId:"input-before-cancel",
        autoResolutionMs:60000,
        questions:[{id:"confirm",question:"Continue?",options:[]}]
      }
    }));
  });
}
`,
  );
  await chmod(executable, 0o700);
  const settled: string[] = [];
  const adapter = new CodexCliAdapter(executable, undefined, {
    onInputSettled: (_runId, requestId) => settled.push(requestId),
  });
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
    if (event.kind === "input_requested") adapter.cancel(run.id);
  }
  assert.deepEqual(kinds, [
    "session_started",
    "tool_started",
    "input_requested",
    "tool_finished",
    "cancelled",
  ]);
  assert.equal(settled.length, 1);
  assert.equal(adapter.cancel(run.id), false);
});

test("Codex dynamic-tool requests fail with an actionable policy explanation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-provider-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
        method:"item/started",
        params:{item:{id:"command-before-policy-failure",type:"commandExecution",command:"private"}}
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
`,
  );
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
      kind: "tool_started",
      toolCallId: "command-before-policy-failure",
      name: "Command",
    },
    {
      kind: "tool_finished",
      toolCallId: "command-before-policy-failure",
      failed: true,
    },
    {
      kind: "failed",
      code: "unsupported_external_tool",
      message:
        "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
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
    () =>
      normalizeCodexNotification({
        method: "item/started",
        params: { item: { id: "item-1", type: "futureMutation" } },
      }),
    /Unsupported Codex item type/,
  );
  assert.deepEqual(
    normalizeCodexNotification({
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
    }),
    [
      {
        kind: "failed",
        code: "unsupported_external_tool",
        message:
          "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
      },
    ],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/started",
      params: {
        item: {
          id: "item-3",
          type: "mcpToolCall",
          server: "aldunis_browser",
          tool: "browser_snapshot",
        },
      },
    }),
    [{ kind: "tool_started", toolCallId: "item-3", name: "MCP browser_snapshot" }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "item-2",
          type: "mcpToolCall",
          server: "aldunis_browser",
          tool: "browser_snapshot",
          status: "completed",
        },
      },
    }),
    [{ kind: "tool_finished", toolCallId: "item-2", failed: false }],
  );
});

test("Codex protocol failures preserve a safe diagnostic and settle active tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-protocol-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"thread-1"},model:"fixture"}
    }));
    if (message.id === 2) {
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-1"}}}));
      console.log(JSON.stringify({
        method:"item/started",
        params:{item:{id:"command-1",type:"commandExecution",command:"private"}}
      }));
      console.log(JSON.stringify({method:"future/event",params:{}}));
    }
  });
}
`,
  );
  await chmod(executable, 0o700);
  const closed: string[] = [];
  const adapter = new CodexCliAdapter(executable, undefined, {
    onSessionClosed: (conversationId) => closed.push(conversationId),
  });
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-1",
    prompt: "Trigger a protocol mismatch",
    approvalUrl: "http://127.0.0.1:1/unused",
    browserMcp: TEST_BROWSER_MCP,
    mode: "build",
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(events, [
    { kind: "session_started", sessionId: "thread-1", model: "fixture" },
    { kind: "tool_started", toolCallId: "command-1", name: "Command" },
    { kind: "tool_finished", toolCallId: "command-1", failed: true },
    {
      kind: "failed",
      code: "provider_protocol_error",
      message: "Codex app-server emitted an unsupported notification.",
    },
  ]);
  assert.deepEqual(closed, ["conversation-1"]);
});

test("interrupted and failed Codex turns normalize to terminal events", () => {
  assert.deepEqual(
    normalizeCodexNotification({
      method: "error",
      params: { error: { message: "Authentication expired." } },
    }),
    [{ kind: "failed", message: "Authentication expired." }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "turn/completed",
      params: { turn: { status: "interrupted", error: null } },
    }),
    [{ kind: "cancelled" }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "turn/completed",
      params: { turn: { status: "failed", error: { message: "Provider unavailable." } } },
    }),
    [{ kind: "failed", message: "Provider unavailable." }],
  );
  assert.deepEqual(
    normalizeCodexNotification({
      method: "turn/completed",
      params: { turn: { status: "inProgress", error: null } },
    }),
    [],
  );
  assert.throws(
    () =>
      normalizeCodexNotification({
        method: "turn/completed",
        params: { turn: { status: "future-status", error: null } },
      }),
    /Unsupported Codex turn status/,
  );
});

test("Codex terminal tool failures are not overwritten by stream cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-terminal-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (message.id === 1) console.log(JSON.stringify({
      id:1,result:{thread:{id:"thread-1"},model:"fixture"}
    }));
    if (message.id === 2) {
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-1"}}}));
      console.log(JSON.stringify({
        method:"item/started",
        params:{item:{
          id:"mcp-1",
          type:"mcpToolCall",
          server:"private-server",
          tool:"private-tool",
          status:"inProgress",
          arguments:{}
        }}
      }));
      // Partial trailing line after the terminal failure should not replace
      // the unsupported-external-tool outcome with a protocol fallback.
      process.stdout.write('{"method":"process/exited","params":{');
    }
  });
}
`,
  );
  await chmod(executable, 0o700);
  const adapter = new CodexCliAdapter(executable);
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-terminal",
    prompt: "Trigger an external tool failure",
    approvalUrl: "http://127.0.0.1:1/unused",
    mode: "build",
  });
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(events, [
    { kind: "session_started", sessionId: "thread-1", model: "fixture" },
    {
      kind: "failed",
      code: "unsupported_external_tool",
      message:
        "Codex requested a dynamic or MCP tool that Aldunis Code does not authorize. Continue without external tools.",
    },
  ]);
});

test("Codex input backpressure stops consuming app-server requests until stdin drains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-codex-backpressure-"));
  const executable = join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
} else {
  const readline = require("node:readline");
  readline.createInterface({input: process.stdin}).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === 0) console.log(JSON.stringify({id:0,result:{}}));
    if (request.id === 1) console.log(JSON.stringify({id:1,result:{thread:{id:"thread-1"}}}));
    if (request.id === 2) {
      console.log(JSON.stringify({id:2,result:{turn:{id:"turn-1"}}}));
      console.log(JSON.stringify({id:99,method:"fixture/unsupported",params:{}}));
      console.log(JSON.stringify({id:99,method:"fixture/unsupported",params:{}}));
    }
  });
  setInterval(() => {}, 1000);
}
`,
  );
  await chmod(executable, 0o700);
  let releaseFirstResponse = () => {};
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  let markFirstResponse = () => {};
  const firstResponseStarted = new Promise<void>((resolve) => {
    markFirstResponse = resolve;
  });
  let markSecondResponse = () => {};
  const secondResponseStarted = new Promise<void>((resolve) => {
    markSecondResponse = resolve;
  });
  let responseCount = 0;
  const adapter = new CodexCliAdapter(executable, undefined, {
    inputWriterFactory: (output) => {
      const delegate = new JsonLineWriter(output);
      return {
        async write(value) {
          const message = value as { id?: unknown; error?: unknown };
          if (message.id === 99 && message.error) {
            responseCount += 1;
            if (responseCount === 1) {
              markFirstResponse();
              await firstResponseGate;
            } else {
              markSecondResponse();
            }
          }
          await delegate.write(value);
        },
        drained: () => delegate.drained(),
      };
    },
  });
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-backpressure",
    prompt: "Inspect",
    approvalUrl: "http://127.0.0.1:1/unused",
    mode: "ask",
  });
  const iterator = run.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "session_started");
  const pending = iterator.next();
  try {
    await firstResponseStarted;
    assert.equal(responseCount, 1);
    releaseFirstResponse();
    await secondResponseStarted;
    assert.equal(responseCount, 2);
  } finally {
    releaseFirstResponse();
    adapter.close();
    await Promise.allSettled([pending, run.settled]);
  }
});
