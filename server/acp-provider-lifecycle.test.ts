import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpProviderAdapter } from "./acp-provider.ts";
import { PermissionBroker } from "./permission.ts";
import type { InstalledProviderAdapter } from "./provider-adapters.ts";

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
