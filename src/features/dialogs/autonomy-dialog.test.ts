import assert from "node:assert/strict";
import test from "node:test";
import { AUTONOMY_REFRESH_INTERVAL_MS, startAutonomyRefreshPolling } from "./autonomy-dialog";

test("autonomy polling pauses while hidden and refreshes on visibility return", () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | undefined;
  let interval: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cleared = 0;
  let loads = 0;
  const tick = () => interval?.();
  const visibility = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      visibilityListener = listener as () => void;
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (visibilityListener === listener) visibilityListener = undefined;
    },
  };
  const timers = {
    setInterval: (callback: TimerHandler, timeout?: number) => {
      interval = callback as () => void;
      intervalMs = timeout;
      return 1;
    },
    clearInterval: () => {
      cleared += 1;
      interval = undefined;
    },
  };

  const dispose = startAutonomyRefreshPolling(
    () => {
      loads += 1;
    },
    visibility,
    timers as unknown as Pick<Window, "setInterval" | "clearInterval">,
  );

  assert.equal(loads, 1);
  assert.equal(intervalMs, AUTONOMY_REFRESH_INTERVAL_MS);
  tick();
  assert.equal(loads, 2);

  visibilityState = "hidden";
  visibilityListener?.();
  assert.equal(interval, undefined);
  assert.equal(loads, 2);

  visibilityState = "visible";
  visibilityListener?.();
  assert.equal(loads, 3);
  tick();
  assert.equal(loads, 4);

  dispose();
  assert.equal(visibilityListener, undefined);
  assert.equal(interval, undefined);
  assert.equal(cleared, 2);
});

test("autonomy polling starts dormant when the document is hidden", () => {
  let intervalCreated = false;
  let loads = 0;
  const dispose = startAutonomyRefreshPolling(
    () => {
      loads += 1;
    },
    {
      visibilityState: "hidden",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    {
      setInterval: () => {
        intervalCreated = true;
        return 1;
      },
      clearInterval: () => undefined,
    } as unknown as Pick<Window, "setInterval" | "clearInterval">,
  );

  assert.equal(loads, 0);
  assert.equal(intervalCreated, false);
  dispose();
});
