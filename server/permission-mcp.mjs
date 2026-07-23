import process from "node:process";

const approvalUrl = process.env.ALDUNIS_APPROVAL_URL;
const runId = process.env.ALDUNIS_PROVIDER_RUN_ID;
const token = process.env.ALDUNIS_PROVIDER_RUN_TOKEN;
let buffer = "";

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
        tools: [{
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
        }],
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
          "authorization": `Bearer ${token}`,
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
          content: [{
            type: "text",
            text: JSON.stringify({
              behavior: "deny",
              message: error instanceof Error ? error.message : "Permission broker failed.",
            }),
          }],
        },
      });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});
