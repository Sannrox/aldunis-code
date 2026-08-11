import assert from "node:assert/strict";
import test from "node:test";
import {
  isCurrentPreviewElementReferenceResponse,
  PreviewElementReferenceDeadline,
} from "./preview-element-reference-deadline";

class FakeTimers {
  #next = 0;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const handle = ++this.#next;
    this.callbacks.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: number): void {
    this.callbacks.delete(handle);
  }
}

test("element reference deadline retains only the latest selection", () => {
  const timers = new FakeTimers();
  const deadline = new PreviewElementReferenceDeadline(timers);
  let timedOut = 0;
  deadline.start(() => {
    timedOut += 1;
  });
  const stale = [...timers.callbacks.entries()][0]!;
  deadline.start(() => {
    timedOut += 1;
  });

  assert.equal(timers.callbacks.size, 1);
  stale[1]();
  assert.equal(timedOut, 0);
  assert.equal(deadline.pending, true);
});

test("element reference deadline clears success and disposal without late callbacks", () => {
  const timers = new FakeTimers();
  const deadline = new PreviewElementReferenceDeadline(timers);
  let timedOut = 0;
  deadline.start(() => {
    timedOut += 1;
  });
  const stale = [...timers.callbacks.values()][0]!;

  deadline.clear();
  stale();

  assert.equal(deadline.pending, false);
  assert.equal(timers.callbacks.size, 0);
  assert.equal(timedOut, 0);
});

test("element reference deadline invokes the current timeout once", () => {
  const timers = new FakeTimers();
  const deadline = new PreviewElementReferenceDeadline(timers);
  let timedOut = 0;
  deadline.start(() => {
    timedOut += 1;
  });
  const callback = [...timers.callbacks.values()][0]!;

  callback();
  callback();

  assert.equal(timedOut, 1);
  assert.equal(deadline.pending, false);
});

test("element reference responses must match the active request", () => {
  assert.equal(
    isCurrentPreviewElementReferenceResponse(
      { type: "aldunis-preview:element-reference", requestId: "request-old" },
      "request-new",
    ),
    false,
  );
  assert.equal(
    isCurrentPreviewElementReferenceResponse(
      { type: "aldunis-preview:element-error", requestId: "request-new" },
      "request-new",
    ),
    true,
  );
  assert.equal(isCurrentPreviewElementReferenceResponse({}, "request-new"), false);
});
