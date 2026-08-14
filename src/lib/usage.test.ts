import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUsageReport,
  isUsageRangeDays,
  MAX_USAGE_COST_USD,
  MAX_USAGE_TOKENS,
  type UsageReceipt,
} from "./usage";

const now = "2026-08-08T12:00:00.000Z";

function receipt(overrides: Partial<UsageReceipt>): UsageReceipt {
  return {
    schemaVersion: 2,
    id: "usage-1",
    threadId: "thread-1",
    turnId: "turn-1",
    provider: "codex-cli",
    model: "gpt-5-codex",
    status: "completed",
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningOutputTokens: null,
    totalProcessedTokens: null,
    reportedCostUsd: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("usage reports aggregate bounded receipts and ignore running or stale records", () => {
  const report = buildUsageReport(
    [
      receipt({
        id: "usage-codex",
        turnId: "turn-codex",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 4,
        reasoningOutputTokens: 5,
        reportedCostUsd: 0.03,
      }),
      receipt({
        id: "usage-claude",
        turnId: "turn-claude",
        provider: "claude-code",
        model: "claude-sonnet",
        status: "interrupted",
        totalProcessedTokens: 500,
        inputTokens: null,
        outputTokens: null,
        updatedAt: "2026-08-02T08:00:00.000Z",
      }),
      receipt({ id: "usage-running", turnId: "turn-running", status: "running" }),
      receipt({
        id: "usage-old",
        turnId: "turn-old",
        updatedAt: "2026-07-01T08:00:00.000Z",
        inputTokens: 99,
        outputTokens: 1,
      }),
    ],
    7,
    new Date(now),
  );

  assert.deepEqual(report.totals, {
    observedTurns: 2,
    completedTurns: 1,
    inputTokens: 100,
    outputTokens: 25,
    processedTokens: 125,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 4,
    reasoningOutputTokens: 5,
    reportedCostUsd: 0.03,
    pricedTurns: 1,
  });
  assert.deepEqual(
    report.providers.map((item) => [item.provider, item.turns, item.processedTokens]),
    [
      ["codex-cli", 1, 125],
      ["claude-code", 1, 0],
    ],
  );
  assert.equal(report.daily.length, 7);
  assert.equal(report.daily.find((item) => item.date === "2026-08-02")?.processedTokens, 0);
  assert.equal(report.daily.find((item) => item.date === "2026-08-08")?.processedTokens, 125);
  assert.equal(report.startDate, "2026-08-02");
  assert.equal(report.endDate, "2026-08-08");
});

test("usage reports stream the retained receipt inventory without array materialization", () => {
  const source = [
    receipt({ id: "usage-first", turnId: "turn-first", inputTokens: 10, outputTokens: 2 }),
    receipt({ id: "usage-running", turnId: "turn-running", status: "running" }),
    receipt({
      id: "usage-stale",
      turnId: "turn-stale",
      updatedAt: "2026-07-01T08:00:00.000Z",
    }),
  ];
  const receipts = new Proxy(source, {
    get(target, property, receiver) {
      if (
        property === "filter" ||
        property === "map" ||
        property === "slice" ||
        property === "sort"
      ) {
        throw new Error(`receipt inventory must not call ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const report = buildUsageReport(receipts, 7, new Date(now));

  assert.equal(report.totals.observedTurns, 1);
  assert.equal(report.totals.completedTurns, 1);
  assert.equal(report.totals.processedTokens, 12);
  assert.equal(report.providers[0]?.turns, 1);
  assert.equal(report.models[0]?.turns, 1);
});

test("usage reports do not sum cumulative provider totals", () => {
  const report = buildUsageReport(
    [
      receipt({ id: "usage-first", turnId: "turn-first", totalProcessedTokens: 100 }),
      receipt({ id: "usage-second", turnId: "turn-second", totalProcessedTokens: 180 }),
    ],
    7,
    new Date(now),
  );

  assert.equal(report.totals.observedTurns, 2);
  assert.equal(report.totals.processedTokens, 0);
  assert.equal(report.providers[0]?.processedTokens, 0);
  assert.equal(report.daily.find((item) => item.date === "2026-08-08")?.processedTokens, 0);
});

test("usage reports preserve the shared unknown-model bucket", () => {
  const report = buildUsageReport(
    [
      receipt({ id: "usage-null", turnId: "turn-null", model: null, inputTokens: 1 }),
      receipt({ id: "usage-empty", turnId: "turn-empty", model: "", outputTokens: 2 }),
    ],
    7,
    new Date(now),
  );

  assert.equal(report.models.length, 1);
  assert.equal(report.models[0]?.model, null);
  assert.equal(report.models[0]?.turns, 2);
  assert.equal(report.models[0]?.processedTokens, 3);
});

test("usage reports include Claude cache input categories", () => {
  const report = buildUsageReport(
    [
      receipt({
        provider: "claude-code",
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 4,
      }),
    ],
    7,
    new Date(now),
  );

  assert.equal(report.totals.inputTokens, 100);
  assert.equal(report.totals.cachedInputTokens, 10);
  assert.equal(report.totals.cacheWriteInputTokens, 4);
  assert.equal(report.totals.processedTokens, 139);
});

test("usage reports ignore out-of-bound provider metrics", () => {
  const report = buildUsageReport(
    [
      receipt({
        inputTokens: MAX_USAGE_TOKENS + 1,
        outputTokens: MAX_USAGE_TOKENS + 1,
        reportedCostUsd: MAX_USAGE_COST_USD + 1,
      }),
    ],
    7,
    new Date(now),
  );

  assert.equal(report.totals.observedTurns, 1);
  assert.equal(report.totals.processedTokens, 0);
  assert.equal(report.totals.reportedCostUsd, null);
  assert.equal(report.totals.pricedTurns, 0);
});

test("usage range validation accepts only the supported dashboard ranges", () => {
  assert.equal(isUsageRangeDays(7), true);
  assert.equal(isUsageRangeDays(30), true);
  assert.equal(isUsageRangeDays(90), true);
  assert.equal(isUsageRangeDays(8), false);
  assert.equal(isUsageRangeDays("30"), false);
});
