import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeEvent } from "./provider.ts";

test("Claude result usage normalizes bounded token and cache fields", () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: "result",
      session_id: "session-1",
      usage: {
        input_tokens: 1_000,
        output_tokens: 200,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
      },
      total_cost_usd: 0.02,
    }),
    [
      {
        kind: "context_usage",
        usedTokens: 1_200,
        maxTokens: null,
        totalProcessedTokens: 1_200,
        inputTokens: 1_000,
        outputTokens: 200,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 20,
      },
      { kind: "turn_completed", sessionId: "session-1", costUsd: 0.02 },
    ],
  );
});

test("Claude error results preserve bounded reported cost", () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: "result",
      session_id: "session-1",
      is_error: true,
      result: "The provider stopped after partial work.",
      total_cost_usd: 0.04,
    }),
    [
      {
        kind: "failed",
        costUsd: 0.04,
        message: "The provider stopped after partial work.",
      },
    ],
  );
});
