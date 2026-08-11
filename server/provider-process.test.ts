import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { hasPendingProviderTermination, terminateProviderChild } from "./provider-process.ts";

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
  return {
    callbacks,
    timers: {
      setTimeout(callback: () => void) {
        const handle = { unref() {} };
        callbacks.set(handle, callback);
        return handle;
      },
      clearTimeout(handle: object) {
        callbacks.delete(handle);
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
