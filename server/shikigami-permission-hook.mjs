/**
 * Fail-closed pre_tool gate for shikigami → Aldunis Code PermissionBroker.
 *
 * Invoked by shikigami hooks with JSON on stdin:
 *   {"event":"pre_tool","payload":{"run_id":"…","tool":"write_file","args_json":"…"}}
 *
 * Config path is argv[2]: JSON { approvalUrl, runId, token, mutatingTools }.
 * Exit 0 allow / non-mutating; exit 1 deny or broker failure.
 */
import process from "node:process";
import { requestApproval } from "./approval-response.mjs";
import { readPermissionHookConfig } from "./permission-hook-config.mjs";

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("shikigami permission hook: missing config path\n");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readPermissionHookConfig(configPath));
} catch {
  process.stderr.write("shikigami permission hook: invalid or unsafe config\n");
  process.exit(1);
}

const approvalUrl = typeof config.approvalUrl === "string" ? config.approvalUrl : "";
const runId = typeof config.runId === "string" ? config.runId : "";
const token = typeof config.token === "string" ? config.token : "";
const mutatingTools = new Set(
  Array.isArray(config.mutatingTools)
    ? config.mutatingTools.filter((name) => typeof name === "string")
    : [],
);

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`input exceeds the ${MAX_HOOK_INPUT_BYTES / 1024} KiB limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseArgsJson(value) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

let raw;
try {
  raw = await readStdin();
} catch (error) {
  process.stderr.write(
    `shikigami permission hook: ${error instanceof Error ? error.message : "input failed"}\n`,
  );
  process.exit(1);
}
const body = parsePayload(raw);
const payload = body && typeof body === "object" ? body.payload : null;
const tool = payload && typeof payload.tool === "string" ? payload.tool : "";
if (!tool) {
  process.stderr.write("shikigami permission hook: missing tool name\n");
  process.exit(1);
}

if (!mutatingTools.has(tool)) {
  process.exit(0);
}

if (!approvalUrl || !runId || !token) {
  process.stderr.write("shikigami permission hook: broker not configured\n");
  process.exit(1);
}

const input = parseArgsJson(payload?.args_json);
try {
  const { response, result } = await requestApproval(approvalUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runId,
      toolName: tool,
      input,
    }),
  });
  if (!response.ok) {
    process.stderr.write(
      `shikigami permission hook: broker HTTP ${response.status}: ${result.error ?? "failed"}\n`,
    );
    process.exit(1);
  }
  if (result.behavior === "allow") {
    process.exit(0);
  }
  process.stderr.write(`shikigami permission hook: denied: ${result.message ?? "user denied"}\n`);
  process.exit(1);
} catch (error) {
  process.stderr.write(
    `shikigami permission hook: ${error instanceof Error ? error.message : "broker failed"}\n`,
  );
  process.exit(1);
}
