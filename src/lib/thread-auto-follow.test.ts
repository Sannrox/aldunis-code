import assert from "node:assert/strict";
import test from "node:test";
import {
  THREAD_FOLLOW_THRESHOLD_PX,
  createThreadBottomSettler,
  isNearThreadBottom,
  nextThreadFollowEnabled,
  readThreadScrollMetrics,
  scrollThreadToBottom,
  shouldPinThreadToBottom,
  threadDistanceFromBottom,
  threadHasOverflow,
} from "./thread-auto-follow";

test("threadDistanceFromBottom measures remaining scroll room", () => {
  assert.equal(
    threadDistanceFromBottom({ scrollTop: 100, clientHeight: 400, scrollHeight: 600 }),
    100,
  );
  assert.equal(
    threadDistanceFromBottom({ scrollTop: 200, clientHeight: 400, scrollHeight: 600 }),
    0,
  );
  assert.equal(
    threadDistanceFromBottom({ scrollTop: 250, clientHeight: 400, scrollHeight: 600 }),
    0,
  );
});

test("isNearThreadBottom uses the follow threshold", () => {
  const near = {
    scrollTop: 600 - 400 - (THREAD_FOLLOW_THRESHOLD_PX - 1),
    clientHeight: 400,
    scrollHeight: 600,
  };
  const far = {
    scrollTop: 600 - 400 - (THREAD_FOLLOW_THRESHOLD_PX + 1),
    clientHeight: 400,
    scrollHeight: 600,
  };
  assert.equal(isNearThreadBottom(near), true);
  assert.equal(isNearThreadBottom(far), false);
});

test("nextThreadFollowEnabled stays on when there is no overflow", () => {
  assert.equal(
    nextThreadFollowEnabled({ scrollTop: 0, clientHeight: 400, scrollHeight: 200 }),
    true,
  );
});

test("nextThreadFollowEnabled turns off when the operator scrolls up", () => {
  assert.equal(
    nextThreadFollowEnabled({
      scrollTop: 0,
      clientHeight: 400,
      scrollHeight: 1200,
    }),
    false,
  );
  assert.equal(
    nextThreadFollowEnabled({
      scrollTop: 800 - THREAD_FOLLOW_THRESHOLD_PX,
      clientHeight: 400,
      scrollHeight: 1200,
    }),
    true,
  );
});

test("scrollThreadToBottom pins scrollTop to scrollHeight", () => {
  const target = { scrollTop: 12, scrollHeight: 900 };
  scrollThreadToBottom(target);
  assert.equal(target.scrollTop, 900);
});

test("thread bottom settler reaches content that grows before the next frame", () => {
  let frame: (() => void) | null = null;
  const settler = createThreadBottomSettler(
    (callback) => {
      frame = callback;
      return 1;
    },
    () => undefined,
  );
  const target = { scrollTop: 12, scrollHeight: 900 };

  settler.settle(target);
  assert.equal(target.scrollTop, 900);
  target.scrollHeight = 1200;
  assert.ok(frame);
  (frame as () => void)();
  assert.equal(target.scrollTop, 1200);
});

test("thread bottom settler replaces and cancels pending frame work", () => {
  const cancelled: number[] = [];
  let nextHandle = 0;
  const settler = createThreadBottomSettler(
    () => ++nextHandle,
    (handle) => cancelled.push(handle),
  );

  settler.settle({ scrollTop: 0, scrollHeight: 100 });
  settler.settle({ scrollTop: 0, scrollHeight: 200 });
  assert.deepEqual(cancelled, [1]);

  settler.cancel();
  assert.deepEqual(cancelled, [1, 2]);
});

test("empty first-run content is not pinned to the bottom", () => {
  assert.equal(shouldPinThreadToBottom(true, false), false);
  assert.equal(shouldPinThreadToBottom(false, false), false);
  assert.equal(shouldPinThreadToBottom(true, true), true);
});

test("threadHasOverflow ignores 1px subpixel noise", () => {
  assert.equal(threadHasOverflow({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 }), false);
  assert.equal(threadHasOverflow({ scrollTop: 0, clientHeight: 400, scrollHeight: 401 }), false);
  assert.equal(threadHasOverflow({ scrollTop: 0, clientHeight: 400, scrollHeight: 402 }), true);
});

test("readThreadScrollMetrics copies live element metrics", () => {
  assert.deepEqual(readThreadScrollMetrics({ scrollTop: 10, clientHeight: 20, scrollHeight: 30 }), {
    scrollTop: 10,
    clientHeight: 20,
    scrollHeight: 30,
  });
});
