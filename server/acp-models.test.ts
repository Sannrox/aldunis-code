import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acpSetModelRequest,
  MAX_ACP_MODEL_PROBE_MESSAGE_BYTES,
  MAX_ACTIVE_ACP_MODEL_PROBES,
  parseAcpSessionModels,
  probeAcpModels,
} from "./acp-models.ts";

test("parseAcpSessionModels reads Kiro/Grok session models field", () => {
  const models = parseAcpSessionModels({
    sessionId: "s1",
    models: {
      currentModelId: "auto",
      availableModels: [
        { modelId: "auto", name: "auto", description: "pick for me" },
        { modelId: "claude-sonnet-4.6", name: "claude-sonnet-4.6" },
        {
          modelId: "grok-4.5",
          name: "Grok 4.5",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [
              { value: "high", default: true },
              { value: "medium" },
              { value: "low" },
            ],
          },
        },
      ],
    },
  });
  assert.equal(models.length, 3);
  assert.equal(models[0]?.id, "auto");
  assert.equal(models[0]?.isDefault, true);
  assert.equal(models[2]?.id, "grok-4.5");
  assert.deepEqual(models[2]?.reasoningEfforts, ["high", "medium", "low"]);
  assert.equal(models[2]?.defaultReasoningEffort, "high");
});

test("parseAcpSessionModels reads configOptions model category", () => {
  const models = parseAcpSessionModels({
    sessionId: "s1",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "m2",
        options: [
          { value: "m1", name: "Model 1" },
          { value: "m2", name: "Model 2" },
        ],
      },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models.find((model) => model.id === "m2")?.isDefault, true);
});

test("acpSetModelRequest builds session/set_model", () => {
  assert.deepEqual(acpSetModelRequest("sess", "claude-sonnet-4.6"), {
    method: "session/set_model",
    params: { sessionId: "sess", modelId: "claude-sonnet-4.6" },
  });
});

test("probeAcpModels streams initialize + session/new from a fixture CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-models-"));
  const executable = join(directory, "fake-acp");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    }) + "\\n");
    return;
  }
  if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "sess-1",
        models: {
          currentModelId: "model-b",
          availableModels: [
            { modelId: "model-a", name: "Model A" },
            { modelId: "model-b", name: "Model B" },
          ],
        },
      },
    }) + "\\n");
  }
});
`,
  );
  await chmod(executable, 0o700);
  const models = await probeAcpModels({
    executable,
    arguments: [],
    cwd: directory,
    timeoutMs: 5_000,
  });
  assert.equal(models.length, 2);
  assert.equal(models.find((model) => model.id === "model-b")?.isDefault, true);
  assert.equal(models.find((model) => model.id === "model-a")?.displayName, "Model A");
});

test("probeAcpModels assembles a fragmented bounded response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-models-fragmented-"));
  const executable = join(directory, "fragmented-acp");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  const response = msg.method === "initialize"
    ? { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }
    : {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "sess-fragmented",
          padding: "x".repeat(256 * 1024),
          models: {
            currentModelId: "model-a",
            availableModels: [{ modelId: "model-a", name: "Model A" }],
          },
        },
      };
  const output = Buffer.from(JSON.stringify(response) + "\\n");
  let offset = 0;
  const write = () => {
    if (offset >= output.length) return;
    process.stdout.write(output.subarray(offset, offset + 1024));
    offset += 1024;
    setImmediate(write);
  };
  write();
});
`,
  );
  await chmod(executable, 0o700);

  const models = await probeAcpModels({
    executable,
    arguments: [],
    cwd: directory,
    timeoutMs: 5_000,
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["model-a"],
  );
});

test("probeAcpModels force-terminates a fixture that ignores SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-models-"));
  const executable = join(directory, "stubborn-acp");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);

  const models = await probeAcpModels({
    executable,
    arguments: [],
    cwd: directory,
    timeoutMs: 1_000,
    terminationGraceMs: 25,
  });
  assert.deepEqual(models, []);
  const pid = Number(await readFile(pidPath, "utf8"));
  const isAlive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  for (let attempt = 0; attempt < 50 && isAlive(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    assert.equal(isAlive(), false);
  } finally {
    if (isAlive()) process.kill(pid, "SIGKILL");
  }
});

test("probeAcpModels terminates a newline-free oversized message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-model-oversized-"));
  const executable = join(directory, "oversized-acp");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdout.write("x".repeat(${MAX_ACP_MODEL_PROBE_MESSAGE_BYTES + 1}));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);

  const startedAt = Date.now();
  const models = await probeAcpModels({
    executable,
    arguments: [],
    cwd: directory,
    timeoutMs: 5_000,
    terminationGraceMs: 25,
  });
  assert.deepEqual(models, []);
  assert.ok(Date.now() - startedAt < 1_000);
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("probeAcpModels settles promptly when the executable cannot spawn", async () => {
  const startedAt = Date.now();
  assert.deepEqual(
    await probeAcpModels({
      executable: join(tmpdir(), `missing-acp-${Date.now()}`),
      arguments: [],
      timeoutMs: 25,
    }),
    [],
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("probeAcpModels cancellation terminates its active child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-model-cancel-"));
  const executable = join(directory, "blocked-acp");
  const pidPath = join(directory, "pid");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = probeAcpModels({
    executable,
    arguments: [],
    cwd: directory,
    timeoutMs: 5_000,
    terminationGraceMs: 10,
    signal: controller.signal,
  });
  while (!(await readFile(pidPath, "utf8").catch(() => ""))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("probeAcpModels caps active children and recovers capacity after settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-model-capacity-"));
  const executable = join(directory, "blocked-acp");
  const startsPath = join(directory, "starts");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(startsPath)}, "started\\n");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);

  const options = {
    executable,
    arguments: [] as string[],
    cwd: directory,
    timeoutMs: 1_000,
    terminationGraceMs: 10,
  };
  const active = Array.from({ length: MAX_ACTIVE_ACP_MODEL_PROBES }, () => probeAcpModels(options));
  const startedCount = async () =>
    (await readFile(startsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  for (
    let attempt = 0;
    attempt < 200 && (await startedCount()) < MAX_ACTIVE_ACP_MODEL_PROBES;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES);

  const queuedStart = Date.now();
  assert.deepEqual(await probeAcpModels({ ...options, timeoutMs: 25 }), []);
  assert.ok(Date.now() - queuedStart < 250);
  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES);

  let queuedSettled = false;
  const queued = probeAcpModels({ ...options, timeoutMs: 2_000 }).finally(() => {
    queuedSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(queuedSettled, false);
  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES);
  await Promise.all([...active, queued]);

  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES + 1);
});

test("probeAcpModels cancellation removes queued admission without starting a child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-acp-model-queue-cancel-"));
  const executable = join(directory, "blocked-acp");
  const startsPath = join(directory, "starts");
  await writeFile(
    executable,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(startsPath)}, "started\\n");
setInterval(() => {}, 1_000);
`,
  );
  await chmod(executable, 0o700);
  const options = {
    executable,
    arguments: [] as string[],
    cwd: directory,
    timeoutMs: 1_000,
    terminationGraceMs: 10,
  };
  const active = Array.from({ length: MAX_ACTIVE_ACP_MODEL_PROBES }, () => probeAcpModels(options));
  const startedCount = async () =>
    (await readFile(startsPath, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  while ((await startedCount()) < MAX_ACTIVE_ACP_MODEL_PROBES) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const controller = new AbortController();
  const queued = probeAcpModels({ ...options, timeoutMs: 5_000, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));

  controller.abort();

  await assert.rejects(
    queued,
    (error: unknown) => (error as { name?: unknown }).name === "AbortError",
  );
  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES);
  await Promise.all(active);
  assert.equal(await startedCount(), MAX_ACTIVE_ACP_MODEL_PROBES);
});
