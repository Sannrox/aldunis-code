import assert from "node:assert/strict";
import test from "node:test";
import { WakeBroker } from "./wake.ts";

test("wake broker delivers status transitions without payload side channels", () => {
  const broker = new WakeBroker();
  const received: unknown[] = [];
  const unsubscribe = broker.subscribe((event) => received.push(event));
  broker.publish({
    threadId: "thread-1",
    status: "pending_approval",
    at: "2026-07-25T00:00:00.000Z",
  });
  assert.deepEqual(received, [{
    threadId: "thread-1",
    status: "pending_approval",
    at: "2026-07-25T00:00:00.000Z",
  }]);
  unsubscribe();
  broker.publish({
    threadId: "thread-1",
    status: "idle",
    at: "2026-07-25T00:01:00.000Z",
  });
  assert.equal(received.length, 1);
  assert.equal(broker.subscriberCount, 0);
});
