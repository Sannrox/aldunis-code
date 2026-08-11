import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAcpNotification } from "./acp-provider.ts";

function kiroMessage(content: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    method: "session/notification",
    params: {
      sessionId: "kiro-session",
      update: { type: "AgentMessageChunk", content },
    },
  };
}

test("Kiro empty text chunks are ignored while missing text remains invalid", () => {
  assert.deepEqual(normalizeAcpNotification(kiroMessage({ type: "text", text: "" })), []);
  assert.throws(
    () => normalizeAcpNotification(kiroMessage({ type: "text" })),
    /missing message text/,
  );
});
