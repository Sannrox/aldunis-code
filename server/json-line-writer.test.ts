import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { JsonLineWriter } from "./json-line-writer.mjs";

class ControlledOutput extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  blocked = true;
  writes: string[] = [];

  write(value: string): boolean {
    this.writes.push(value);
    return !this.blocked;
  }
}

test("JSON line writes stop at backpressure and resume in order", async () => {
  const output = new ControlledOutput();
  const writer = new JsonLineWriter(output);
  let firstSettled = false;
  let secondSettled = false;
  const first = writer.write({ id: 1 }).then(() => {
    firstSettled = true;
  });
  const second = writer.write({ id: 2 }).then(() => {
    secondSettled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(output.writes, ['{"id":1}\n']);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);

  output.blocked = false;
  output.emit("drain");
  await Promise.all([first, second]);
  assert.deepEqual(output.writes, ['{"id":1}\n', '{"id":2}\n']);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount("close"), 0);
});

test("JSON line writes reject and release listeners when output closes", async () => {
  const output = new ControlledOutput();
  const writer = new JsonLineWriter(output);
  const pending = writer.write({ id: 1 });
  const queued = writer.write({ id: 2 });

  await new Promise((resolve) => setImmediate(resolve));
  output.emit("close");
  await assert.rejects(pending, /output closed/);
  await assert.rejects(queued, /output closed/);
  assert.deepEqual(output.writes, ['{"id":1}\n']);
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount("close"), 0);
});
