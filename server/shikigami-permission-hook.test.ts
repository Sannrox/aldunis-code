import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const hookPath = fileURLToPath(new URL("./shikigami-permission-hook.mjs", import.meta.url));

async function hookFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-hook-input-"));
  const configPath = join(directory, "gate.json");
  await writeFile(
    configPath,
    JSON.stringify({
      approvalUrl: "http://127.0.0.1:1/api/provider/permissions/request",
      runId: "hook-input-test",
      token: "synthetic-token",
      mutatingTools: ["write_file"],
    }),
  );
  return configPath;
}

function runHook(
  configPath: string,
  input: Buffer,
  endInput: boolean,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, configPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("permission hook did not reject input within 5 seconds"));
    }, 5_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
      // An early fail-closed exit is expected for oversized input.
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
    if (endInput) child.stdin.end(input);
    else child.stdin.write(input);
  });
}

test("Shikigami permission hook accepts an exact-limit non-mutating payload", async () => {
  const configPath = await hookFixture();
  const base = JSON.stringify({ event: "pre_tool", payload: { tool: "read_file" }, padding: "" });
  const input = Buffer.from(
    JSON.stringify({
      event: "pre_tool",
      payload: { tool: "read_file" },
      padding: "x".repeat(MAX_HOOK_INPUT_BYTES - Buffer.byteLength(base)),
    }),
  );
  assert.equal(input.byteLength, MAX_HOOK_INPUT_BYTES);

  const result = await runHook(configPath, input, true);
  assert.equal(result.code, 0, result.stderr);
});

test("Shikigami permission hook rejects overflow before stdin ends", async () => {
  const configPath = await hookFixture();
  const result = await runHook(configPath, Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1, 0x20), false);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /input exceeds the 1024 KiB limit/);
});
