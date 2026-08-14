import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RETAINED_BYTE_FRAGMENTS, readBoundedBytes } from "./bounded-byte-reader.mjs";

test("collects a body fragmented beyond the retained-fragment bound", async () => {
  const fragment = Buffer.from("a");
  const count = MAX_RETAINED_BYTE_FRAGMENTS * 3 + 7;
  const body = await readBoundedBytes(
    {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < count; index += 1) yield fragment;
      },
    },
    count,
    "oversized",
  );

  assert.equal(body.byteLength, count);
  assert.equal(body.toString("utf8"), "a".repeat(count));
});

test("preserves ordinary fragments without changing their bytes", async () => {
  const first = Buffer.from('{"value":');
  const second = new Uint8Array(Buffer.from("true}"));
  assert.equal(
    (await readBoundedBytes([first, second], 128, "oversized")).toString("utf8"),
    '{"value":true}',
  );
});

test("rejects the first fragment above the byte ceiling with the caller error", async () => {
  await assert.rejects(
    readBoundedBytes([Buffer.from("1234"), Buffer.from("5")], 4, "oversized", {
      error: (message) => Object.assign(new Error(message), { status: 413 }),
    }),
    (error) => {
      assert.equal(error.message, "oversized");
      assert.equal(error.status, 413);
      return true;
    },
  );
});

test("propagates transport failures instead of returning an incomplete body", async () => {
  await assert.rejects(
    readBoundedBytes(
      {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("partial");
          throw new Error("transport failed");
        },
      },
      128,
      "oversized",
    ),
    /transport failed/,
  );
});
