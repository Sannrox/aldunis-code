import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForShikigamiChildClose } from "./shikigami-provider.ts";

test("Shikigami child close releases its fallback timer", async () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { exitCode: null, signalCode: null });
  let callback: (() => void) | null = null;
  let cleared = false;
  let terminations = 0;
  const completion = waitForShikigamiChildClose(
    child,
    () => {
      terminations += 1;
    },
    2_000,
    {
      setTimeout: (next) => {
        callback = next;
        return { unref() {} };
      },
      clearTimeout: () => {
        cleared = true;
        callback = null;
      },
    },
  );

  child.emit("close");
  await completion;
  callback?.();

  assert.equal(cleared, true);
  assert.equal(terminations, 0);
  assert.equal(child.listenerCount("close"), 0);
});
