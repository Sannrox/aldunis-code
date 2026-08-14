import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";

test("conversation search ignores a stale response after the query changes", async () => {
  const dom = new JSDOM("<!doctype html><html><body><main id='app'></main></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = {
    window: scope.window,
    document: scope.document,
    Node: scope.Node,
    Element: scope.Element,
    HTMLElement: scope.HTMLElement,
    Event: scope.Event,
    KeyboardEvent: scope.KeyboardEvent,
    MutationObserver: scope.MutationObserver,
    requestAnimationFrame: scope.requestAnimationFrame,
    cancelAnimationFrame: scope.cancelAnimationFrame,
    fetch: scope.fetch,
    IS_REACT_ACT_ENVIRONMENT: scope.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(scope, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const pending: Array<{
    query: string;
    signal: AbortSignal | null;
    resolve: (response: Response) => void;
  }> = [];
  globalThis.fetch = ((_input, init) =>
    new Promise<Response>((resolve) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      pending.push({ query: body.query, signal: init?.signal ?? null, resolve });
    })) as typeof fetch;
  const container = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(container);
  const { ThreadSearchDialog } = await import("./thread-search-dialog");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const result = {
    id: "thread-1",
    projectId: "project-1",
    title: "Result",
    worktree: "/tmp/project",
    updatedAt: "2026-07-29T16:21:34.000Z",
    projectName: "aldunis-code",
    provider: "codex-cli",
    pinnedAt: null,
    archivedAt: null,
  } as const;
  try {
    await act(async () => {
      root.render(
        createElement(ThreadSearchDialog, {
          open: true,
          threads: [],
          onClose: () => undefined,
          onSelect: () => undefined,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.query, "");
    const input = dom.window.document.querySelector<HTMLInputElement>("#thread-search-query");
    assert.ok(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "latest");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(pending[0]?.signal?.aborted, true);
    await act(async () => {
      pending[0]?.resolve(
        Response.json({ threads: [{ ...result, id: "stale", title: "Stale result" }] }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Stale result/);
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 175));
    });
    assert.equal(pending.length, 2);
    assert.equal(pending[1]?.query, "latest");
    await act(async () => {
      pending[1]?.resolve(
        Response.json({ threads: [{ ...result, id: "latest", title: "Latest result" }] }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(dom.window.document.body.textContent ?? "", /Latest result/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(scope, key);
      else Object.assign(scope, { [key]: value });
    }
  }
});
