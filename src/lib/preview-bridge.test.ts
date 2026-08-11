import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

test("preview bridge only cancels the matching element selection", async () => {
  const source = await readFile(
    new URL("../../public/aldunis-preview-bridge.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "dangerously",
    url: "http://localhost:4173",
  });
  Object.defineProperty(dom.window.document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  dom.window.eval(source);
  const send = (data: object) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data,
        origin: dom.window.origin,
        source: dom.window as unknown as Window,
      }),
    );

  send({ type: "aldunis-preview:select-element", requestId: "current" });
  assert.equal(dom.window.document.documentElement.hasAttribute("data-aldunis-selecting"), true);

  send({ type: "aldunis-preview:cancel-element-selection", requestId: "stale" });
  assert.equal(dom.window.document.documentElement.hasAttribute("data-aldunis-selecting"), true);

  send({ type: "aldunis-preview:cancel-element-selection", requestId: "current" });
  assert.equal(dom.window.document.documentElement.hasAttribute("data-aldunis-selecting"), false);

  dom.window.close();
});
