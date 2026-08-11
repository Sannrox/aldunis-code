import assert from "node:assert/strict";
import test from "node:test";
import {
  SIDEBAR_SNOOZE_CLOCK_INTERVAL_MS,
  startSidebarSnoozeClock,
  type SidebarSnoozeClockTimers,
  type SidebarSnoozeClockVisibility,
} from "./sidebar-snooze-clock";

function fixture(initial: DocumentVisibilityState = "visible") {
  let visibilityState = initial;
  let listener: (() => void) | null = null;
  let current = 1_000;
  let nextHandle = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  const visibility: SidebarSnoozeClockVisibility = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type, next) => {
      listener = next;
    },
    removeEventListener: (_type, next) => {
      if (listener === next) listener = null;
    },
  };
  const timers: SidebarSnoozeClockTimers = {
    setTimeout(callback, delay) {
      const handle = nextHandle++;
      pending.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
  };
  return {
    visibility,
    timers,
    pending,
    now: () => current,
    setNow(value: number) {
      current = value;
    },
    setVisibility(value: DocumentVisibilityState) {
      visibilityState = value;
      listener?.();
    },
    fire() {
      const [handle, timeout] = [...pending.entries()][0]!;
      pending.delete(handle);
      timeout.callback();
    },
    listenerActive: () => listener !== null,
  };
}

test("snooze clock stays idle while hidden and resumes immediately with one timer", () => {
  const current = fixture("hidden");
  const ticks: number[] = [];
  const stop = startSidebarSnoozeClock(
    [121_000],
    (now) => ticks.push(now),
    current.visibility,
    current.timers,
    current.now,
  );

  assert.equal(current.pending.size, 0);
  current.setVisibility("visible");
  assert.deepEqual(ticks, [1_000]);
  assert.deepEqual(
    [...current.pending.values()].map(({ delay }) => delay),
    [60_000],
  );

  current.setVisibility("visible");
  assert.deepEqual(ticks, [1_000, 1_000]);
  assert.equal(current.pending.size, 1);
  current.setVisibility("hidden");
  assert.equal(current.pending.size, 0);

  stop();
  assert.equal(current.listenerActive(), false);
});

test("snooze clock wakes at the earlier of label refresh and snooze deadline", () => {
  const current = fixture();
  const ticks: number[] = [];
  const stop = startSidebarSnoozeClock(
    [11_000, 301_000],
    (now) => ticks.push(now),
    current.visibility,
    current.timers,
    current.now,
  );

  assert.deepEqual(ticks, [1_000]);
  assert.deepEqual(
    [...current.pending.values()].map(({ delay }) => delay),
    [10_000],
  );
  current.setNow(11_000);
  current.fire();
  assert.deepEqual(ticks, [1_000, 11_000]);
  assert.deepEqual(
    [...current.pending.values()].map(({ delay }) => delay),
    [SIDEBAR_SNOOZE_CLOCK_INTERVAL_MS],
  );
  stop();
});

test("snooze clock does not schedule without a future deadline", () => {
  const current = fixture();
  const ticks: number[] = [];
  const stop = startSidebarSnoozeClock(
    [Number.NaN, 1_000],
    (now) => ticks.push(now),
    current.visibility,
    current.timers,
    current.now,
  );
  assert.deepEqual(ticks, [1_000]);
  assert.equal(current.pending.size, 0);
  stop();
});
