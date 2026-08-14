import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpProviderAdapter } from "./acp-provider.ts";
import { PermissionBroker } from "./permission.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

async function waitForFile(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      assert.equal(await readFile(path, "utf8"), expected);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("a successful ACP terminal event closes its subprocess before iterator abandonment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-lifecycle-"));
  const executable = join(directory, "fake-acp");
  const terminatedFile = join(directory, "terminated");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline");
process.on("SIGTERM", () => {
  require("node:fs").writeFileSync(${JSON.stringify(terminatedFile)}, "SIGTERM");
  process.exit(0);
});
readline.createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 0) console.log(JSON.stringify({jsonrpc:"2.0",id:0,result:{protocolVersion:1,agentCapabilities:{}}}));
  if (request.id === 1) console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{sessionId:"fixture-session"}}));
  if (request.id === 2) console.log(JSON.stringify({jsonrpc:"2.0",id:2,result:{}}));
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(executable, 0o700);
  const installed: InstalledProviderAdapter = {
    schemaVersion: 1,
    source: "fixture",
    digest: "fixture",
    enabled: true,
    installedAt: new Date(0).toISOString(),
    manifest: {
      schemaVersion: 1,
      id: "fixture",
      publisher: { name: "Fixture" },
      version: "1.0.0",
      aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
      protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
      executable: { names: ["fake-acp"], arguments: [] },
      capabilities: { tools: false, images: false, sessionResume: false },
      environment: [],
      presentation: { name: "Fixture", description: "Fixture ACP adapter" },
    },
  };
  const adapter = new AcpProviderAdapter(installed, executable, new PermissionBroker());
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-1",
    prompt: "Inspect",
    approvalUrl: "http://127.0.0.1:4174/api/provider/permissions/request",
    mode: "ask",
    model: "default",
  });
  const iterator = run.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "session_started");
  assert.equal((await iterator.next()).value?.kind, "turn_completed");
  await iterator.return?.();
  await run.settled;
  assert.equal(await readFile(terminatedFile, "utf8"), "SIGTERM");
  assert.equal(adapter.cancel(run.id), false);
});

test("ACP input backpressure stops consuming provider requests until stdin drains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-backpressure-"));
  const executable = join(directory, "fake-acp");
  const startedFile = join(directory, "started");
  const blockedFile = join(directory, "blocked");
  const completedFile = join(directory, "completed");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({input: process.stdin});
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 0) console.log(JSON.stringify({jsonrpc:"2.0",id:0,result:{protocolVersion:1,agentCapabilities:{}}}));
  if (request.id === 1) console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{sessionId:"fixture-session"}}));
  if (request.id === 2) {
    input.close();
    process.stdin.pause();
    const message = JSON.stringify({jsonrpc:"2.0",id:99,method:"unsupported/request",params:{payload:"x".repeat(512)}}) + "\\n";
    let index = 0;
    fs.writeFileSync(${JSON.stringify(startedFile)}, "started");
    const writeRequests = () => {
      while (index < 20000) {
        index += 1;
        if (!process.stdout.write(message)) {
          fs.writeFileSync(${JSON.stringify(blockedFile)}, "blocked");
          process.stdout.once("drain", writeRequests);
          return;
        }
      }
      fs.writeFileSync(${JSON.stringify(completedFile)}, "completed");
    };
    writeRequests();
  }
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(executable, 0o700);
  const installed: InstalledProviderAdapter = {
    schemaVersion: 1,
    source: "fixture",
    digest: "fixture",
    enabled: true,
    installedAt: new Date(0).toISOString(),
    manifest: {
      schemaVersion: 1,
      id: "fixture",
      publisher: { name: "Fixture" },
      version: "1.0.0",
      aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
      protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
      executable: { names: ["fake-acp"], arguments: [] },
      capabilities: { tools: false, images: false, sessionResume: false },
      environment: [],
      presentation: { name: "Fixture", description: "Fixture ACP adapter" },
    },
  };
  const adapter = new AcpProviderAdapter(installed, executable, new PermissionBroker());
  const run = await adapter.start({
    repository: directory,
    worktree: directory,
    conversationId: "conversation-1",
    prompt: "Inspect",
    approvalUrl: "http://127.0.0.1:4174/api/provider/permissions/request",
    mode: "ask",
    model: "default",
  });
  const iterator = run.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "session_started");
  const pending = iterator.next();
  let cancelled = false;
  let terminal: Awaited<typeof pending> | undefined;
  try {
    await waitForFile(startedFile, "started");
    await waitForFile(blockedFile, "blocked");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(readFile(completedFile, "utf8"), { code: "ENOENT" });
  } finally {
    cancelled = adapter.cancel(run.id);
    [terminal] = await Promise.all([pending, run.settled]);
  }
  assert.equal(cancelled, true);
  assert.equal(terminal.value?.kind, "cancelled");
});
