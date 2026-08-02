import { createInterface } from "node:readline";

const endpoint = process.env.ALDUNIS_BROWSER_TOOL_URL;
const conversationId = process.env.ALDUNIS_BROWSER_CONVERSATION_ID;
const token = process.env.ALDUNIS_BROWSER_TOKEN;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const tools = [
  {
    name: "browser_status",
    description: "Return whether the Aldunis shared browser is connected and who controls it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_snapshot",
    description: "Inspect the current shared loopback page, visible text, interactive elements, and a bounded screenshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "Navigate the shared browser to a loopback HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "A localhost, 127.0.0.1, or ::1 URL." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "Click one interactive element by its snapshot selector or by bounded page coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Insert bounded text into the currently focused page control.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press",
    description: "Press a named keyboard key in the shared browser.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current shared page by bounded pixel offsets.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait",
    description: "Wait briefly for a page update, up to five seconds.",
    inputSchema: {
      type: "object",
      properties: { milliseconds: { type: "number" } },
      required: ["milliseconds"],
      additionalProperties: false,
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorReply(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  })}\n`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotImageContent(result) {
  if (!isRecord(result) || result.kind !== "snapshot" || !isRecord(result.snapshot)) return null;
  const screenshot = result.snapshot.screenshot;
  if (typeof screenshot !== "string") return null;
  const match = screenshot.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || Buffer.byteLength(match[2], "base64") > 512 * 1024) return null;
  return { type: "image", data: match[2], mimeType: match[1] };
}

function toolContent(result) {
  const image = snapshotImageContent(result);
  const textResult = image && isRecord(result) && isRecord(result.snapshot)
    ? { ...result, snapshot: { ...result.snapshot, screenshot: "[image attached]" } }
    : result;
  return [
    { type: "text", text: JSON.stringify(textResult) },
    ...(image ? [image] : []),
  ];
}

function operationFor(name, args) {
  const input = isRecord(args) ? args : {};
  const operations = {
    browser_status: { kind: "status" },
    browser_snapshot: { kind: "snapshot" },
    browser_navigate: { kind: "navigate", url: input.url },
    browser_click: {
      kind: "click",
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.x !== undefined ? { x: input.x, y: input.y } : {}),
    },
    browser_type: { kind: "type", text: input.text },
    browser_press: { kind: "press", key: input.key },
    browser_scroll: { kind: "scroll", x: input.x, y: input.y },
    browser_wait: { kind: "wait", milliseconds: input.milliseconds },
  };
  return operations[name];
}

async function callBroker(operation) {
  if (!endpoint || !conversationId || !token) {
    throw new Error("The Aldunis browser tool is not configured for this provider session.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ conversationId, operation }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("The browser broker response was too large.");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`The browser broker returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `Browser broker request failed (${response.status}).`);
  }
  return body;
}

async function handle(message) {
  if (!isRecord(message)) return;
  const id = message.id;
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    if (id === undefined) return;
    reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "aldunis_browser", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    if (id !== undefined) reply(id, { tools });
    return;
  }
  if (message.method === "tools/call") {
    if (id === undefined) return;
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const operation = operationFor(name, params.arguments);
    if (!operation) {
      errorReply(id, -32602, "The requested browser tool is not available.");
      return;
    }
    try {
      const result = await callBroker(operation);
      reply(id, {
        content: toolContent(result),
        isError: result?.ok === false,
      });
    } catch (error) {
      reply(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : "Browser tool failed." }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) errorReply(id, -32601, `Unsupported MCP method: ${String(message.method)}.`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    errorReply(null, -32700, "Invalid JSON.");
    continue;
  }
  await handle(message);
}
