import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  hasPendingProviderTermination,
  scheduleProviderChildTermination,
  terminateProviderChild,
} from "./provider-process.ts";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  close(): void {
    this.exitCode = 0;
    this.emit("close", 0, null);
  }
}

function fakeTimers() {
  const callbacks = new Map<object, () => void>();
  const delays = new Map<object, number>();
  return {
    callbacks,
    delays,
    timers: {
      setTimeout(callback: () => void, delayMs: number) {
        const handle = { unref() {} };
        callbacks.set(handle, () => {
          callbacks.delete(handle);
          delays.delete(handle);
          callback();
        });
        delays.set(handle, delayMs);
        return handle;
      },
      clearTimeout(handle: object) {
        callbacks.delete(handle);
        delays.delete(handle);
      },
    },
  };
}

test("provider termination is idempotent and releases its force timer on close", () => {
  const child = new FakeChild();
  const scheduled = fakeTimers();

  terminateProviderChild(child as unknown as ChildProcess, 2_000, scheduled.timers);
  terminateProviderChild(child as unknown as ChildProcess, 2_000, scheduled.timers);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(scheduled.callbacks.size, 1);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), true);

  child.close();
  assert.equal(scheduled.callbacks.size, 0);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), false);

  terminateProviderChild(child as unknown as ChildProcess, 2_000, scheduled.timers);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(scheduled.callbacks.size, 0);
});

test("provider termination force-kills an unresponsive exact child once", () => {
  const child = new FakeChild();
  const scheduled = fakeTimers();
  terminateProviderChild(child as unknown as ChildProcess, 2_000, scheduled.timers);

  const force = [...scheduled.callbacks.values()][0]!;
  force();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(scheduled.callbacks.size, 0);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), false);
});

test("scheduled provider termination coalesces and clears before its delay", () => {
  const child = new FakeChild();
  const scheduled = fakeTimers();
  scheduleProviderChildTermination(
    child as unknown as ChildProcess,
    2_000,
    3_000,
    scheduled.timers,
  );
  scheduleProviderChildTermination(
    child as unknown as ChildProcess,
    2_000,
    3_000,
    scheduled.timers,
  );
  assert.deepEqual(child.signals, []);
  assert.deepEqual([...scheduled.delays.values()], [2_000]);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), true);

  child.close();
  assert.equal(scheduled.callbacks.size, 0);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), false);
});

test("immediate termination promotes one scheduled lifecycle", () => {
  const child = new FakeChild();
  const scheduled = fakeTimers();
  scheduleProviderChildTermination(
    child as unknown as ChildProcess,
    2_000,
    3_000,
    scheduled.timers,
  );
  terminateProviderChild(child as unknown as ChildProcess, 99_000, scheduled.timers);
  terminateProviderChild(child as unknown as ChildProcess, 99_000, scheduled.timers);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual([...scheduled.delays.values()], [3_000]);

  [...scheduled.callbacks.values()][0]!();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(hasPendingProviderTermination(child as unknown as ChildProcess), false);
});

test("scheduled provider termination escalates once after both delays", () => {
  const child = new FakeChild();
  const scheduled = fakeTimers();
  scheduleProviderChildTermination(
    child as unknown as ChildProcess,
    2_000,
    3_000,
    scheduled.timers,
  );
  [...scheduled.callbacks.values()][0]!();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual([...scheduled.delays.values()], [3_000]);

  [...scheduled.callbacks.values()][0]!();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(scheduled.callbacks.size, 0);
});
