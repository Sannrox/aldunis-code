import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ThreadWakeEvent } from "./wake.ts";
import { MAX_PENDING_WAKE_EVENTS, WakeStreamCoordinator } from "./wake-stream.ts";

class FixtureResponse extends EventEmitter {
  writableEnded = false;
  readonly chunks: string[] = [];
  blockNext = false;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    if (!this.blockNext) return true;
    this.blockNext = false;
    return false;
  }
}

function event(threadId: string, status = "running", at = threadId): ThreadWakeEvent {
  return { threadId, status: status as ThreadWakeEvent["status"], at };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("wake stream bounds and coalesces writes until a slow response drains", () => {
  const response = new FixtureResponse();
  response.blockNext = true;
  const stream = new WakeStreamCoordinator({ response });

  stream.publish(event("accepted"));
  for (let index = 0; index < MAX_PENDING_WAKE_EVENTS + 20; index += 1) {
    stream.publish(event(`thread-${index}`, "running", `old-${index}`));
  }
  stream.publish(event("thread-275", "completed", "latest"));

  assert.equal(response.chunks.length, 1);
  assert.equal(stream.pendingCount, MAX_PENDING_WAKE_EVENTS);
  response.emit("drain");

  assert.equal(stream.pendingCount, 0);
  assert.equal(response.chunks.length, MAX_PENDING_WAKE_EVENTS + 1);
  assert.doesNotMatch(response.chunks.join(""), /thread-0/);
  assert.match(response.chunks.join(""), /"threadId":"thread-275".*"at":"latest"/s);
});

test("managed wake projection is serialized once per burst and stops after close", async () => {
  const response = new FixtureResponse();
  const gates: Array<(value: Set<string>) => void> = [];
  let active = 0;
  let peak = 0;
  let inspections = 0;
  const stream = new WakeStreamCoordinator<Set<string>>({
    response,
    loadProjection: () => {
      inspections += 1;
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        gates.push((value) => {
          active -= 1;
          resolve(value);
        });
      });
    },
    selectEvents: (visible, events) => events.filter((item) => visible.has(item.threadId)),
  });

  stream.publish(event("visible-a", "running", "first"));
  stream.publish(event("visible-b", "running", "old"));
  stream.publish(event("visible-b", "completed", "latest"));
  stream.publish(event("hidden"));
  assert.equal(inspections, 1);
  assert.equal(peak, 1);

  gates.shift()!(new Set(["visible-a", "visible-b"]));
  await settle();
  assert.equal(inspections, 2);
  assert.equal(peak, 1);
  gates.shift()!(new Set(["visible-a", "visible-b"]));
  await settle();

  assert.equal(response.chunks.length, 2);
  assert.match(response.chunks[0]!, /visible-a/);
  assert.match(response.chunks[1]!, /visible-b.*latest/s);

  stream.publish(event("visible-a", "completed", "after-close"));
  assert.equal(inspections, 3);
  stream.close();
  gates.shift()!(new Set(["visible-a"]));
  await settle();
  assert.equal(response.chunks.length, 2);
  assert.equal(stream.pendingCount, 0);
});

test("wake stream removes drain work and skips heartbeats after close", () => {
  const response = new FixtureResponse();
  response.blockNext = true;
  const stream = new WakeStreamCoordinator({ response });
  stream.heartbeat();
  assert.equal(response.listenerCount("drain"), 1);

  stream.publish(event("queued"));
  stream.close();
  response.emit("drain");
  stream.heartbeat();

  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(stream.pendingCount, 0);
  assert.deepEqual(response.chunks, [": heartbeat\n\n"]);
});
