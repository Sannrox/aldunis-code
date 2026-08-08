import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAcpNotification, normalizeAcpUsageUpdate } from "./acp-provider.ts";

test("ACP usage_update normalizes common field names into context_usage", () => {
  assert.deepEqual(
    normalizeAcpUsageUpdate({
      usedTokens: 8_000,
      maxTokens: 200_000,
      inputTokens: 6_000,
      outputTokens: 2_000,
    }),
    [
      {
        kind: "context_usage",
        usedTokens: 8_000,
        maxTokens: 200_000,
        totalProcessedTokens: null,
        inputTokens: 6_000,
        outputTokens: 2_000,
      },
    ],
  );
  assert.deepEqual(
    normalizeAcpUsageUpdate({
      used: 1_000,
      size: 128_000,
    }),
    [
      {
        kind: "context_usage",
        usedTokens: 1_000,
        maxTokens: 128_000,
        totalProcessedTokens: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  );
  assert.deepEqual(normalizeAcpUsageUpdate({ maxTokens: 100 }), []);
});

test("ACP session/update usage_update is not informational noise", () => {
  assert.deepEqual(
    normalizeAcpNotification({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "usage_update",
          usedTokens: 500,
          contextWindow: 100_000,
        },
      },
    }),
    [
      {
        kind: "context_usage",
        usedTokens: 500,
        maxTokens: 100_000,
        totalProcessedTokens: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  );
});
