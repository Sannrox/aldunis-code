import assert from "node:assert/strict";
import test from "node:test";
import { hostFetch } from "./host-fetch";

test("extracted hostFetch still binds fetch to the global", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = function windowFetch(this: unknown, input: RequestInfo | URL) {
    called = true;
    if (this !== globalThis) {
      throw new TypeError("Can only call Window.fetch on instances of Window");
    }
    assert.equal(String(input), "/api/provider/runs");
    return Promise.resolve(new Response(null, { status: 204 }));
  } as typeof fetch;
  try {
    const owner = { request: hostFetch };
    const response = await owner.request("/api/provider/runs");
    assert.equal(called, true);
    assert.equal(response.status, 204);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
