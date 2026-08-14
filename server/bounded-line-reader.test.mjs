import assert from "node:assert/strict";
import test from "node:test";

import { readBoundedLines } from "./bounded-line-reader.mjs";

async function collect(chunks, limit = 8) {
  const lines = [];
  for await (const line of readBoundedLines(chunks, limit, "too large")) {
    lines.push(line.toString("utf8"));
  }
  return lines;
}

test("assembles split lines and preserves empty lines", async () => {
  assert.deepEqual(await collect([Buffer.from("one\n t"), Buffer.from("wo\n\n")]), [
    "one",
    " two",
    "",
  ]);
});

test("accepts the exact byte limit", async () => {
  assert.deepEqual(await collect([Buffer.from("1234"), Buffer.from("5678\n")]), ["12345678"]);
});

test("rejects a line as soon as its byte limit is exceeded", async () => {
  await assert.rejects(collect([Buffer.from("1234"), Buffer.from("56789")]), /too large/);
});

test("rejects incomplete content but permits trailing whitespace", async () => {
  await assert.rejects(collect([Buffer.from("{}")]), /incomplete JSON-RPC message/);
  assert.deepEqual(await collect([Buffer.from(" \t")]), []);
});

test("assembles a 1 MiB line from 64-byte fragments", async () => {
  const fragments = Array.from({ length: 16_384 }, () => Buffer.alloc(64, 0x61));
  fragments.push(Buffer.from("\n"));
  const [line] = await collect(fragments, 1024 * 1024);
  assert.equal(Buffer.byteLength(line), 1024 * 1024);
  assert.equal(line.at(0), "a");
  assert.equal(line.at(-1), "a");
});

test("supports explicit incomplete-trailer policies", async () => {
  const input = [Buffer.from("{}")];
  const yielded = [];
  for await (const line of readBoundedLines(input, 8, "too large", { trailer: "yield" })) {
    yielded.push(line.toString("utf8"));
  }
  assert.deepEqual(yielded, ["{}"]);
  assert.deepEqual(
    await Array.fromAsync(readBoundedLines(input, 8, "too large", { trailer: "discard" })),
    [],
  );
  await assert.rejects(
    Array.fromAsync(
      readBoundedLines(input, 8, "too large", { incompleteMessage: "provider incomplete" }),
    ),
    /provider incomplete/,
  );
});

test("constructs caller-specific protocol errors", async () => {
  class ProtocolError extends Error {}
  await assert.rejects(
    Array.fromAsync(
      readBoundedLines([Buffer.from("123456789")], 8, "provider overflow", {
        error: (message) => new ProtocolError(message),
      }),
    ),
    (error) => error instanceof ProtocolError && error.message === "provider overflow",
  );
});
