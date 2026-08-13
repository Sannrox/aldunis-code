import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_REQUEST_TIMEOUT_MS,
  MAX_APPROVAL_RESPONSE_BYTES,
  requestApproval,
} from "./approval-response.mjs";

test("approval requests carry a deadline and parse a bounded response", async () => {
  let signal: AbortSignal | undefined;
  const { result } = await requestApproval(
    "http://127.0.0.1/approval",
    { method: "POST" },
    async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Response('{"behavior":"deny"}', {
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.equal(APPROVAL_REQUEST_TIMEOUT_MS, 305_000);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.deepEqual(result, { behavior: "deny" });
});

test("approval responses reject declared and streamed overflow", async () => {
  await assert.rejects(
    requestApproval(
      "http://127.0.0.1/approval",
      {},
      async () =>
        new Response("{}", {
          headers: { "content-length": String(MAX_APPROVAL_RESPONSE_BYTES + 1) },
        }),
    ),
    /exceeds the 64 KiB limit/,
  );
  await assert.rejects(
    requestApproval(
      "http://127.0.0.1/approval",
      {},
      async () => new Response(new Uint8Array(MAX_APPROVAL_RESPONSE_BYTES + 1)),
    ),
    /exceeds the 64 KiB limit/,
  );
});
