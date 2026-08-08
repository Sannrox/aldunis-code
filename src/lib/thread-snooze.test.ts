import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertValidSnoozeUntil,
  canSnooze,
  isEffectivelySnoozed,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadNeedsAttentionWhileSnoozed,
} from "./thread-snooze";

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("snooze presets include evening only before it is imminent", () => {
  const morning = resolveSnoozePresets(localDate(2026, 4, 8, 10));
  assert.deepEqual(
    morning.map((preset) => preset.id),
    ["hour", "evening", "tomorrow", "next-week"],
  );
  const evening = morning.find((preset) => preset.id === "evening");
  assert.ok(evening);
  assert.equal(new Date(evening.snoozedUntil).getHours(), 18);

  const late = resolveSnoozePresets(localDate(2026, 4, 8, 17, 30));
  assert.deepEqual(
    late.map((preset) => preset.id),
    ["hour", "tomorrow", "next-week"],
  );
});

test("tomorrow and next week land on local morning hours", () => {
  const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
  const tomorrow = new Date(presets.find((preset) => preset.id === "tomorrow")!.snoozedUntil);
  assert.equal(tomorrow.getDate(), 9);
  assert.equal(tomorrow.getHours(), 9);

  // Wednesday → next Monday
  const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
  assert.equal(nextWeek.getDay(), 1);
  assert.equal(nextWeek.getHours(), 9);
});

test("effective snooze is future-only and yields to approval or input", () => {
  const future = "2026-04-10T12:00:00.000Z";
  const now = "2026-04-09T12:00:00.000Z";
  assert.equal(isEffectivelySnoozed({ snoozedUntil: future, status: "idle" }, now), true);
  assert.equal(isEffectivelySnoozed({ snoozedUntil: future, status: "running" }, now), true);
  assert.equal(
    isEffectivelySnoozed({ snoozedUntil: future, status: "pending_approval" }, now),
    false,
  );
  assert.equal(
    isEffectivelySnoozed({ snoozedUntil: future, status: "awaiting_input" }, now),
    false,
  );
  assert.equal(
    isEffectivelySnoozed({ snoozedUntil: "2026-04-08T12:00:00.000Z", status: "idle" }, now),
    false,
  );
  assert.equal(isEffectivelySnoozed({ snoozedUntil: null, status: "idle" }, now), false);
  assert.equal(isEffectivelySnoozed({ snoozedUntil: "not-a-date", status: "idle" }, now), false);
});

test("canSnooze rejects only operator-blocking statuses", () => {
  assert.equal(canSnooze({ status: "idle" }), true);
  assert.equal(canSnooze({ status: "running" }), true);
  assert.equal(canSnooze({ status: "failed" }), true);
  assert.equal(canSnooze({ status: "pending_approval" }), false);
  assert.equal(canSnooze({ status: "awaiting_input" }), false);
  assert.equal(threadNeedsAttentionWhileSnoozed({ status: "pending_approval" }), true);
});

test("wake labels compact remaining time", () => {
  const now = Date.parse("2026-04-09T12:00:00.000Z");
  assert.equal(snoozeWakeLabel("2026-04-09T12:00:00.000Z", now), "now");
  assert.equal(snoozeWakeLabel("2026-04-09T12:20:00.000Z", now), "20m");
  assert.equal(snoozeWakeLabel("2026-04-09T15:00:00.000Z", now), "3h");
  assert.equal(snoozeWakeLabel("2026-04-12T12:00:00.000Z", now), "3d");
});

test("assertValidSnoozeUntil rejects past and far-future times", () => {
  const now = localDate(2026, 4, 9, 12);
  assert.throws(() => assertValidSnoozeUntil("not-a-date", now), /valid snooze wake time/);
  assert.throws(
    () => assertValidSnoozeUntil(new Date(now.getTime() - 60_000).toISOString(), now),
    /future/,
  );
  assert.throws(
    () =>
      assertValidSnoozeUntil(
        new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
        now,
      ),
    /60 days/,
  );
  const valid = assertValidSnoozeUntil(new Date(now.getTime() + 3_600_000).toISOString(), now);
  assert.ok(Date.parse(valid) > now.getTime());
});
