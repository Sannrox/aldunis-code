import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("browser MCP advertises bounded tools and forwards bearer authorization", async () => {
  let authorization: string | undefined;
  let received: unknown;
  let oversized: "none" | "declared" | "chunked" = "none";
  const broker = createServer((request, response) => {
    authorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (oversized === "declared") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": 3 * 1024 * 1024,
        });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (oversized === "chunked") {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let index = 0; index < 48; index += 1) response.write(chunk);
        response.end();
        return;
      }
      const operation = received as { operation?: { kind?: string } };
      response.end(
        JSON.stringify(
          operation.operation?.kind === "snapshot"
            ? {
                ok: true,
                kind: "snapshot",
                snapshot: {
                  url: "http://127.0.0.1:4173/",
                  title: "Preview",
                  loading: false,
                  visibleText: "Hello",
                  interactiveElements: [],
                  screenshot: "data:image/jpeg;base64,AA==",
                  actionTimeline: [],
                },
              }
            : { ok: true, kind: "status", state: { connected: true } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./browser-mcp.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        ALDUNIS_BROWSER_TOOL_URL: `http://127.0.0.1:${address.port}/api/browser/tools`,
        ALDUNIS_BROWSER_CONVERSATION_ID: "conversation-1",
        ALDUNIS_BROWSER_TOKEN: "browser-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.id === "number") pending.get(value.id)?.(value);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const request = (id: number, method: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
    });
  try {
    const initialized = await request(1, "initialize");
    assert.deepEqual(
      (initialized.result as { capabilities: { tools: unknown } }).capabilities.tools,
      {},
    );
    const listed = await request(2, "tools/list");
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    assert.deepEqual(names, [
      "browser_status",
      "browser_snapshot",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_scroll",
      "browser_wait",
    ]);
    const called = await request(3, "tools/call", { name: "browser_status", arguments: {} });
    assert.equal(called.result && typeof called.result === "object", true);
    assert.equal(authorization, "Bearer browser-token");
    assert.equal((received as { conversationId: string }).conversationId, "conversation-1");
    assert.deepEqual(received, { conversationId: "conversation-1", operation: { kind: "status" } });
    const snapshot = await request(4, "tools/call", { name: "browser_snapshot", arguments: {} });
    const content = (snapshot.result as { content: Array<Record<string, unknown>> }).content;
    assert.equal(content[0]?.type, "text");
    assert.match(String(content[0]?.text), /\[image attached\]/);
    assert.deepEqual(content[1], { type: "image", data: "AA==", mimeType: "image/jpeg" });
    assert.deepEqual(received, {
      conversationId: "conversation-1",
      operation: { kind: "snapshot" },
    });
    oversized = "chunked";
    const rejected = await request(5, "tools/call", { name: "browser_status", arguments: {} });
    assert.equal((rejected.result as { isError: boolean }).isError, true);
    assert.match(
      String((rejected.result as { content: Array<{ text: string }> }).content[0]?.text),
      /response was too large/,
    );
    oversized = "declared";
    const declared = await request(6, "tools/call", {
      name: "browser_status",
      arguments: {},
    });
    assert.equal((declared.result as { isError: boolean }).isError, true);
    assert.match(
      String((declared.result as { content: Array<{ text: string }> }).content[0]?.text),
      /response was too large/,
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  }
});
