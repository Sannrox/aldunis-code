import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;
const serverPath = fileURLToPath(new URL("./permission-mcp.mjs", import.meta.url));

function spawnPermissionMcp(environment: NodeJS.ProcessEnv = {}): {
  child: ReturnType<typeof spawn>;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {
    // Oversized input intentionally closes the child before the writer ends.
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, result };
}

test("permission MCP accepts an exact-limit JSON-RPC message", async () => {
  const base = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", padding: "" });
  const message = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    padding: "x".repeat(MAX_MESSAGE_BYTES - Buffer.byteLength(base)),
  });
  assert.equal(Buffer.byteLength(message), MAX_MESSAGE_BYTES);

  const { child, result } = spawnPermissionMcp();
  child.stdin.end(message + "\n");
  const completed = await result;

  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).id, 1);
});

test("permission MCP rejects overflow before stdin ends", async () => {
  const { child, result } = spawnPermissionMcp();
  child.stdin.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 0x20));
  const completed = await Promise.race([
    result,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("permission MCP did not reject overflow")), 5_000),
    ),
  ]);

  assert.equal(completed.code, 1);
  assert.match(completed.stderr, /message exceeds the 1024 KiB limit/);
});

test("permission MCP bounds concurrent broker requests", async () => {
  let active = 0;
  let maximumActive = 0;
  let received = 0;
  const broker = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the bounded request body.
    }
    active += 1;
    received += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ behavior: "deny", message: "test denial" }));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  assert.ok(address && typeof address !== "string");

  try {
    const { child, result } = spawnPermissionMcp({
      ALDUNIS_APPROVAL_URL: `http://127.0.0.1:${address.port}/approval`,
      ALDUNIS_PROVIDER_RUN_ID: "bounded-run",
      ALDUNIS_PROVIDER_RUN_TOKEN: "synthetic-token",
    });
    const requests = Array.from({ length: 24 }, (_, index) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: index,
        method: "tools/call",
        params: { arguments: { tool_name: "write_file", input: { index } } },
      }),
    ).join("\n");
    child.stdin.end(requests + "\n");
    const completed = await result;

    assert.equal(completed.code, 0, completed.stderr);
    assert.equal(received, 24);
    assert.equal(maximumActive, MAX_ACTIVE_REQUESTS);
    assert.equal(completed.stdout.trim().split("\n").length, 24);
  } finally {
    await new Promise<void>((resolve, reject) =>
      broker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
