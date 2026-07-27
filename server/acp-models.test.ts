import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acpSetModelRequest,
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
  await writeFile(executable, `#!/usr/bin/env node
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
`);
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
