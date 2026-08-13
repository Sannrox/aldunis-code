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
