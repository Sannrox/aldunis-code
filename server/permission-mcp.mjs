import process from "node:process";
import { requestApproval } from "./approval-response.mjs";
import { readBoundedLines } from "./bounded-line-reader.mjs";
import { JsonLineWriter } from "./json-line-writer.mjs";

const approvalUrl = process.env.ALDUNIS_APPROVAL_URL;
const runId = process.env.ALDUNIS_PROVIDER_RUN_ID;
const token = process.env.ALDUNIS_PROVIDER_RUN_TOKEN;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;

const output = new JsonLineWriter(process.stdout);

async function handle(message) {
  if (message.method === "initialize") {
    await output.write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "aldunis-permission-broker", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    await output.write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "approval_prompt",
            description: "Ask Aldunis Code for a single scoped tool approval.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    try {
      if (!approvalUrl || !runId || !token) throw new Error("Permission broker is not configured.");
      const { response, result } = await requestApproval(approvalUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId,
          toolName: message.params?.arguments?.tool_name,
          input: message.params?.arguments?.input,
        }),
      });
      if (!response.ok) throw new Error(result.error ?? "Permission broker failed.");
      await output.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    } catch (error) {
      await output.write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "deny",
                message: error instanceof Error ? error.message : "Permission broker failed.",
              }),
            },
          ],
        },
      });
    }
    return;
  }
  if (message.id !== undefined) {
    await output.write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
}

async function processInput() {
  const active = new Set();

  const dispatch = async (line) => {
    while (active.size >= MAX_ACTIVE_REQUESTS) await Promise.race(active);
    const request = Promise.resolve(handle(JSON.parse(line))).finally(() => active.delete(request));
    active.add(request);
  };

  for await (const rawLine of readBoundedLines(
    process.stdin,
    MAX_MESSAGE_BYTES,
    "message exceeds the 1024 KiB limit",
  )) {
    const line = rawLine.toString("utf8").trim();
    if (line) await dispatch(line);
  }
  await Promise.all(active);
}

try {
  await processInput();
} catch (error) {
  const detail =
    error instanceof SyntaxError
      ? "malformed JSON-RPC message"
      : error instanceof Error
        ? error.message
        : "input failed";
  process.stderr.write(`permission MCP: ${detail}\n`);
  process.exit(1);
}
