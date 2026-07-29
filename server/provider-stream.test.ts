import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { beginProviderEventStream } from "./provider-stream.ts";

test("provider run headers arrive before a silent event stream produces a body", async () => {
  let releaseStream: (() => void) | undefined;
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const server = createServer(async (_request, response) => {
    beginProviderEventStream(response, {
      runId: "run-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await streamReleased;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(response.headers.get("x-provider-run-id"), "run-1");
    assert.equal(response.headers.get("x-thread-id"), "thread-1");
    assert.equal(response.headers.get("x-turn-id"), "turn-1");
    await response.body?.cancel();
  } finally {
    releaseStream?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
