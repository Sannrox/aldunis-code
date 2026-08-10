import assert from "node:assert/strict";
import test from "node:test";
import {
  contextUsageFromAcpParams,
  isGrokBuildProvider,
  normalizeAcpNotification,
  normalizeAcpUsageUpdate,
} from "./acp-provider.ts";

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
  assert.deepEqual(
    normalizeAcpUsageUpdate({
      usage: { used: 2_500, size: 64_000 },
    }),
    [
      {
        kind: "context_usage",
        usedTokens: 2_500,
        maxTokens: 64_000,
        totalProcessedTokens: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  );
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

const grokProvider = "adapter:dev.xai.grok-build@1.0.0";

test("Grok stamps context fill on params._meta.totalTokens, not usage_update", () => {
  assert.deepEqual(
    contextUsageFromAcpParams(
      {
        sessionId: "sess-1",
        _meta: { totalTokens: 20_544, eventId: "e1" },
      },
      grokProvider,
    ),
    [
      {
        kind: "context_usage",
        usedTokens: 20_544,
        maxTokens: null,
        totalProcessedTokens: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  );
  // Non-Grok ACP agents must not treat _meta.totalTokens as context occupancy.
  assert.deepEqual(
    contextUsageFromAcpParams(
      { sessionId: "sess-1", _meta: { totalTokens: 20_544 } },
      "adapter:dev.kiro.cli@1.0.0",
    ),
    [],
  );

  const events = normalizeAcpNotification(
    {
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "grep",
        },
        _meta: {
          totalTokens: 27_263,
          eventId: "e2",
        },
      },
    },
    grokProvider,
  );
  assert.deepEqual(events, [
    { kind: "tool_started", toolCallId: "call-1", name: "grep" },
    {
      kind: "context_usage",
      usedTokens: 27_263,
      maxTokens: null,
      totalProcessedTokens: null,
      inputTokens: null,
      outputTokens: null,
    },
  ]);
  assert.deepEqual(
    normalizeAcpNotification(
      {
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "grep",
          },
          _meta: { totalTokens: 27_263 },
        },
      },
      "adapter:dev.kiro.cli@1.0.0",
    ),
    [{ kind: "tool_started", toolCallId: "call-1", name: "grep" }],
  );
});

test("Grok extension session updates are informational and still surface meta usage", () => {
  assert.deepEqual(
    normalizeAcpNotification(
      {
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "turn_completed",
            // Cumulative API accounting — must not become context usedTokens.
            usage: {
              inputTokens: 2_462_003,
              outputTokens: 17_588,
              totalTokens: 2_479_591,
            },
          },
          _meta: { totalTokens: 48_120 },
        },
      },
      grokProvider,
    ),
    [
      {
        kind: "context_usage",
        usedTokens: 48_120,
        maxTokens: null,
        totalProcessedTokens: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  );
  assert.throws(
    () =>
      normalizeAcpNotification(
        {
          method: "session/update",
          params: {
            update: { sessionUpdate: "turn_completed" },
          },
        },
        "adapter:dev.kiro.cli@1.0.0",
      ),
    /Unsupported ACP session update/,
  );
  assert.equal(isGrokBuildProvider("adapter:com.example.xai.grok-build-wrapper@1.0.0"), false);
  assert.equal(isGrokBuildProvider(grokProvider), true);
});
