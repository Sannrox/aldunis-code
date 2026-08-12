import process from "node:process";
import { StringDecoder } from "node:string_decoder";

const approvalUrl = process.env.ALDUNIS_APPROVAL_URL;
const runId = process.env.ALDUNIS_PROVIDER_RUN_ID;
const token = process.env.ALDUNIS_PROVIDER_RUN_TOKEN;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_ACTIVE_REQUESTS = 8;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(message) {
  if (message.method === "initialize") {
    send({
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
    send({
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
      const response = await fetch(approvalUrl, {
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
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Permission broker failed.");
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    } catch (error) {
      send({
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
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

async function processInput() {
  const decoder = new StringDecoder("utf8");
  const active = new Set();
  let buffer = "";
  let pendingBytes = 0;

  const dispatch = async (line) => {
    while (active.size >= MAX_ACTIVE_REQUESTS) await Promise.race(active);
    const request = Promise.resolve(handle(JSON.parse(line))).finally(() => active.delete(request));
    active.add(request);
  };

  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    pendingBytes += chunk.byteLength;
    buffer += decoder.write(chunk);

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const rawLine = buffer.slice(0, newline);
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      if (lineBytes > MAX_MESSAGE_BYTES) throw new Error("message exceeds the 1024 KiB limit");
      pendingBytes -= lineBytes + 1;
      buffer = buffer.slice(newline + 1);
      const line = rawLine.trim();
      if (line) await dispatch(line);
      newline = buffer.indexOf("\n");
    }

    if (pendingBytes > MAX_MESSAGE_BYTES) {
      throw new Error("message exceeds the 1024 KiB limit");
    }
  }

  buffer += decoder.end();
  if (buffer.trim()) throw new Error("incomplete JSON-RPC message");
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
