import assert from "node:assert/strict";
import test from "node:test";
import {
  isDue,
  MIN_INTERVAL_SECS,
  nextCronOccurrenceMs,
  parseSchedule,
} from "./automations-schedule.ts";

test("interval never-run seeds instead of firing", () => {
  assert.equal(
    isDue({ type: "interval", secs: 3600 }, Date.parse("2026-01-01T12:00:00Z"), null),
    "seed",
  );
});

test("interval is due only after the full window", () => {
  const last = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(
    isDue({ type: "interval", secs: 3600 }, last + 3_599_000, last),
    "wait",
  );
  assert.equal(
    isDue({ type: "interval", secs: 3600 }, last + 3_600_000, last),
    "due",
  );
});

test("parseSchedule rejects sub-minute intervals", () => {
  assert.throws(
    () => parseSchedule({ type: "interval", secs: MIN_INTERVAL_SECS - 1 }),
    /at least 60/,
  );
  assert.deepEqual(
    parseSchedule({ type: "interval", secs: 60 }),
    { type: "interval", secs: 60 },
  );
});

test("cron never-run seeds", () => {
  assert.equal(
    isDue({ type: "cron", expr: "0 9 * * *" }, Date.parse("2026-01-01T09:00:00Z"), null),
    "seed",
  );
});

test("cron is due when an occurrence falls after lastRun and at or before now", () => {
  // lastRun just before 09:00 UTC on Jan 1; now is 09:01 — the 09:00 occurrence is due.
  const last = Date.parse("2026-01-01T08:59:00Z");
  const now = Date.parse("2026-01-01T09:01:00Z");
  assert.equal(isDue({ type: "cron", expr: "0 9 * * *" }, now, last), "due");
});

test("cron waits when the next occurrence is still in the future", () => {
  const last = Date.parse("2026-01-01T09:00:00Z");
  const now = Date.parse("2026-01-01T09:30:00Z");
  assert.equal(isDue({ type: "cron", expr: "0 9 * * *" }, now, last), "wait");
});

test("nextCronOccurrenceMs finds the next matching minute", () => {
  const after = Date.parse("2026-01-01T08:00:00Z");
  const next = nextCronOccurrenceMs("30 9 * * *", after);
  assert.equal(next, Date.parse("2026-01-01T09:30:00Z"));
});

test("parseSchedule rejects invalid cron", () => {
  assert.throws(() => parseSchedule({ type: "cron", expr: "not a cron" }), /cron/i);
  assert.throws(() => parseSchedule({ type: "cron", expr: "* * *" }), /cron/i);
});

test("parseSchedule accepts a valid cron expression", () => {
  assert.deepEqual(
    parseSchedule({ type: "cron", expr: "0 9 * * 1-5" }),
    { type: "cron", expr: "0 9 * * 1-5" },
  );
});

test("cron DOM+DOW uses POSIX OR when both fields are restricted", () => {
  // 0 9 15 * 1 → 09:00 on the 15th OR on Mondays (not only Mondays that are the 15th).
  const expr = "0 9 15 * 1";
  // 2026-01-15 is a Thursday → DOM match only.
  const afterDom = Date.parse("2026-01-15T08:00:00Z");
  assert.equal(nextCronOccurrenceMs(expr, afterDom), Date.parse("2026-01-15T09:00:00Z"));
  // Next Monday after Jan 15 is Jan 19 → DOW match.
  const afterDow = Date.parse("2026-01-15T10:00:00Z");
  assert.equal(nextCronOccurrenceMs(expr, afterDow), Date.parse("2026-01-19T09:00:00Z"));
});
