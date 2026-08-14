import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLocalHost } from "./host.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import { LocalStateStore } from "./state.ts";

const execFileAsync = promisify(execFile);
const supportedHelp = `--tools <tools...>
--permission-mode <mode> (choices: "acceptEdits", "default", "dontAsk", "plan")`;

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

for (const scenario of [
  {
    name: "closing a provider response cancels the live run and persists interruption",
    event: `{type:"assistant",message:{content:[{type:"text",text:"working"}]}}`,
    expectedStatus: "interrupted",
    waitForTerminalOutput: false,
  },
  {
    name: "disconnect after a durable terminal event does not overwrite completion",
    event: `{type:"result",session_id:"fixture-session",total_cost_usd:0.01}`,
    expectedStatus: "completed",
    waitForTerminalOutput: true,
  },
] as const) {
  test(scenario.name, async () => {
    const repository = await mkdtemp(join(tmpdir(), "aldunis-provider-close-repo-"));
    const directory = await mkdtemp(join(tmpdir(), "aldunis-provider-close-state-"));
    const bin = await mkdtemp(join(tmpdir(), "aldunis-provider-close-bin-"));
    const executable = join(bin, "claude");
    const terminatedFile = join(bin, "terminated");
    await execFileAsync("git", ["-C", repository, "init", "-q", "-b", "main"]);
    await execFileAsync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
    await execFileAsync("git", ["-C", repository, "config", "user.name", "Aldunis Test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-qm", "fixture"]);
    await writeFile(
      executable,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("2.1.177 (Claude Code)");
} else if (process.argv.includes("--help")) {
  console.log(${JSON.stringify(supportedHelp)});
} else {
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"fixture-session",model:"fixture"}));
  console.log(JSON.stringify(${scenario.event}));
  process.on("SIGTERM", () => {
    console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"raced after close"}]}}));
    setTimeout(() => {
      require("node:fs").writeFileSync(${JSON.stringify(terminatedFile)}, "SIGTERM");
      process.exit(0);
    }, 250);
  });
  setInterval(() => {}, 1000);
}
`,
    );
    await chmod(executable, 0o700);

    const canonicalRepository = await realpath(repository);
    const state = new LocalStateStore(directory);
    await state.saveProject({ id: "project-1", name: "Fixture", root: canonicalRepository });
    const profiles = new ClaudeProfileStore(directory);
    await profiles.ensureDefaults();
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    const server = createLocalHost({ dist: directory, state, profiles });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const runBody = {
        root: canonicalRepository,
        worktree: canonicalRepository,
        prompt: "Inspect",
        conversationId: `conversation-close-${scenario.expectedStatus}`,
        projectId: "project-1",
        mode: "ask",
        provider: "claude-code",
        profileId: "default:claude-code",
        model: "default",
        contextPins: [],
      };
      const status = await new Promise<number>((resolve, reject) => {
        const body = JSON.stringify(runBody);
        const runRequest = request(
          `http://127.0.0.1:${address.port}/api/provider/runs`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (response) => {
            let streamed = "";
            response.on("data", (chunk: Buffer) => {
              streamed += chunk.toString("utf8");
              if (!scenario.waitForTerminalOutput || streamed.includes('"kind":"turn_completed"')) {
                const responseStatus = response.statusCode ?? 0;
                response.destroy();
                runRequest.destroy();
                resolve(responseStatus);
              }
            });
            response.on("error", (error) => {
              if (!response.destroyed) reject(error);
            });
          },
        );
        runRequest.on("error", (error) => {
          if (!runRequest.destroyed) reject(error);
        });
        runRequest.end(body);
      });
      assert.equal(status, 200);

      await waitFor(async () => {
        const projection = await state.inspect();
        return (
          projection.turns.length === 1 && projection.turns[0]?.status === scenario.expectedStatus
        );
      }, `provider response close did not preserve the ${scenario.expectedStatus} turn state`);
      const projection = await state.inspect();
      assert.equal(projection.turns.length, 1);
      assert.equal(projection.turns[0]?.status, scenario.expectedStatus);
      if (scenario.expectedStatus === "interrupted") {
        assert.equal(
          projection.messages.some((message) => message.text.includes("raced after close")),
          false,
        );
        const overlapping = await fetch(`http://127.0.0.1:${address.port}/api/provider/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...runBody, conversationId: "conversation-overlap" }),
        });
        assert.equal(overlapping.status, 409);
      }
      await waitFor(
        async () => (await readFile(terminatedFile, "utf8").catch(() => "")) === "SIGTERM",
        "provider subprocess did not terminate before run ownership was released",
      );
    } finally {
      process.env.PATH = previousPath;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await server.closeResources();
    }
  });
}
