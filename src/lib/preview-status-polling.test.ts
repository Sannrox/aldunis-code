import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEW_STATUS_REFRESH_INTERVAL_MS,
  startPreviewStatusPolling,
  type PreviewPollingTimers,
  type PreviewPollingVisibility,
} from "./preview-status-polling";

class FakeVisibility implements PreviewPollingVisibility {
  visibilityState: "visible" | "hidden";
  listeners = new Set<() => void>();

  constructor(state: "visible" | "hidden") {
    this.visibilityState = state;
  }

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.delete(listener);
  }

  set(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeTimers implements PreviewPollingTimers {
  nextHandle = 1;
  intervals = new Map<number, { callback: () => void; delay: number }>();

  setInterval(callback: () => void, delay: number): number {
    const handle = this.nextHandle++;
    this.intervals.set(handle, { callback, delay });
    return handle;
  }

  clearInterval(handle: number): void {
    this.intervals.delete(handle);
  }

  tick(): void {
    for (const { callback } of [...this.intervals.values()]) callback();
  }
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("preview status polling stays idle while hidden and refreshes immediately on return", async () => {
  const visibility = new FakeVisibility("hidden");
  const timers = new FakeTimers();
  let refreshes = 0;
  const stop = startPreviewStatusPolling(
    async () => {
      refreshes += 1;
    },
    visibility,
    timers,
  );

  assert.equal(refreshes, 0);
  assert.equal(timers.intervals.size, 0);

  visibility.set("visible");
  await settle();
  assert.equal(refreshes, 1);
  assert.deepEqual(
    [...timers.intervals.values()].map(({ delay }) => delay),
    [PREVIEW_STATUS_REFRESH_INTERVAL_MS],
  );

  timers.tick();
  await settle();
  assert.equal(refreshes, 2);

  visibility.set("hidden");
  timers.tick();
  await settle();
  assert.equal(refreshes, 2);
  assert.equal(timers.intervals.size, 0);

  stop();
  visibility.set("visible");
  await settle();
  assert.equal(refreshes, 2);
  assert.equal(visibility.listeners.size, 0);
});

test("preview status polling serializes interval and visibility refreshes", async () => {
  const visibility = new FakeVisibility("visible");
  const timers = new FakeTimers();
  const releases: Array<() => void> = [];
  let refreshes = 0;
  const stop = startPreviewStatusPolling(
    () => {
      refreshes += 1;
      return new Promise<void>((resolve) => releases.push(resolve));
    },
    visibility,
    timers,
  );

  assert.equal(refreshes, 1);
  timers.tick();
  timers.tick();
  visibility.set("hidden");
  visibility.set("visible");
  assert.equal(refreshes, 1);

  releases.shift()?.();
  await settle();
  assert.equal(refreshes, 2);

  visibility.set("hidden");
  releases.shift()?.();
  await settle();
  assert.equal(refreshes, 2);
  stop();
});
