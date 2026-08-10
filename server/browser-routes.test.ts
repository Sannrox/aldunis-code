import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BrowserError } from "./browser.ts";
import { handleBrowserRoute } from "./browser-routes.ts";
import type { StateProjection } from "./state.ts";

const request = (authorization?: string) =>
  ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
const response = {} as ServerResponse;
const unusedState = async () => {
  throw new Error("state must not load");
};
const unusedWorktree = async () => {
  throw new Error("worktree must not resolve");
};
const unusedJson = async () => {
  throw new Error("body must not be read");
};

test("browser route module leaves unrelated routes to local dispatch", async () => {
  const handled = await handleBrowserRoute("/api/state/load", request(), response, {
    remoteRequest: false,
    managed: false,
    loadState: unusedState as () => Promise<StateProjection>,
    selectWorktree: unusedWorktree,
    readJson: unusedJson,
    sendJson: () => assert.fail("response must not be written"),
  });

  assert.equal(handled, false);
});

test("browser route module denies provider tools outside the local desktop host", async () => {
  await assert.rejects(
    handleBrowserRoute("/api/browser/tools", request("Bearer token"), response, {
      remoteRequest: true,
      managed: false,
      loadState: unusedState as () => Promise<StateProjection>,
      selectWorktree: unusedWorktree,
      readJson: unusedJson,
      sendJson: () => assert.fail("response must not be written"),
    }),
    (error: unknown) =>
      error instanceof BrowserError &&
      error.status === 403 &&
      error.message === "Shared browser tools are available in the local desktop host only.",
  );
});
