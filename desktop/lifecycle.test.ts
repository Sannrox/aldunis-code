import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  closeServer,
  isSupportedDeepLink,
  listenOnLoopback,
  localApplicationUrl,
  selectedDirectoryPath,
} from "./lifecycle.ts";

test("packaged startup waits for a loopback backend on an ephemeral port", async () => {
  const server = createServer((_request, response) => response.end("ready"));
  const url = await listenOnLoopback(server);
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await fetch(url).then((response) => response.text()), "ready");
  } finally {
    await closeServer(server);
  }
  assert.equal(server.listening, false);
});

test("backend readiness rejects non-TCP and unavailable addresses", () => {
  assert.throws(() => localApplicationUrl(null), /did not provide a TCP address/);
  assert.throws(() => localApplicationUrl("/tmp/aldunis.sock"), /did not provide a TCP address/);
});

test("deep links accept only the registered application protocol", () => {
  assert.equal(isSupportedDeepLink("aldunis-code://open"), true);
  assert.equal(isSupportedDeepLink("https://example.com"), false);
  assert.equal(isSupportedDeepLink("not a URL"), false);
});

test("native directory selection returns one path and cancellation returns no authority", () => {
  assert.equal(selectedDirectoryPath({ canceled: false, filePaths: ["/project", "/other"] }), "/project");
  assert.equal(selectedDirectoryPath({ canceled: true, filePaths: ["/project"] }), null);
  assert.equal(selectedDirectoryPath({ canceled: false, filePaths: [] }), null);
});
