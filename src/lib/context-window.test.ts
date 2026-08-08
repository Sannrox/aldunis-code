import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextWindowFromUsage,
  formatContextWindowPercentage,
  formatContextWindowTokens,
} from "./context-window";

test("contextWindowFromUsage rejects invalid used tokens", () => {
  assert.equal(contextWindowFromUsage({ usedTokens: -1 }), null);
  assert.equal(contextWindowFromUsage({ usedTokens: Number.NaN }), null);
});

test("contextWindowFromUsage derives percentage and remaining when max is known", () => {
  const snapshot = contextWindowFromUsage({
    usedTokens: 14_000,
    maxTokens: 258_000,
    totalProcessedTokens: 20_000,
    inputTokens: 12_000,
    outputTokens: 2_000,
  });
  assert.ok(snapshot);
  assert.equal(snapshot.usedTokens, 14_000);
  assert.equal(snapshot.maxTokens, 258_000);
  assert.equal(snapshot.remainingTokens, 244_000);
  assert.ok(snapshot.usedPercentage !== null);
  assert.ok(Math.abs(snapshot.usedPercentage! - (14_000 / 258_000) * 100) < 0.001);
  assert.equal(snapshot.totalProcessedTokens, 20_000);
  assert.equal(snapshot.inputTokens, 12_000);
  assert.equal(snapshot.outputTokens, 2_000);
});

test("contextWindowFromUsage allows used-only snapshots without max", () => {
  const snapshot = contextWindowFromUsage({ usedTokens: 1_200 });
  assert.ok(snapshot);
  assert.equal(snapshot.maxTokens, null);
  assert.equal(snapshot.usedPercentage, null);
  assert.equal(snapshot.remainingTokens, null);
});

test("token and percentage formatting stay compact", () => {
  assert.equal(formatContextWindowTokens(null), "0");
  assert.equal(formatContextWindowTokens(420), "420");
  assert.equal(formatContextWindowTokens(1_500), "1.5k");
  assert.equal(formatContextWindowTokens(14_000), "14k");
  assert.equal(formatContextWindowTokens(1_250_000), "1.3m");
  assert.equal(formatContextWindowPercentage(null), null);
  assert.equal(formatContextWindowPercentage(5.4), "5.4%");
  assert.equal(formatContextWindowPercentage(42.2), "42%");
});
