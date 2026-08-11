import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { THREAD_SCROLL_POSITION_STORAGE_KEY } from "./thread-open-scroll";
import { useTranscriptViewport, type TranscriptViewportInput } from "./transcript-viewport";

test("transcript viewport coordinates restore, follow, growth, rebind, and cleanup", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost",
  });
  const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = {
    window: scope.window,
    document: scope.document,
    Node: scope.Node,
    HTMLElement: scope.HTMLElement,
    ResizeObserver: scope.ResizeObserver,
    requestAnimationFrame: scope.requestAnimationFrame,
    cancelAnimationFrame: scope.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: scope.IS_REACT_ACT_ENVIRONMENT,
  };
  const resizeObservers: Array<{ callback: ResizeObserverCallback; disconnected: boolean }> = [];
  class FakeResizeObserver {
    private record: { callback: ResizeObserverCallback; disconnected: boolean };
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, disconnected: false };
      resizeObservers.push(this.record);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  Object.assign(scope, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get() {
        return Number((this as HTMLElement).dataset.clientHeight ?? 0);
      },
    },
    scrollHeight: {
      configurable: true,
      get() {
        return Number((this as HTMLElement).dataset.scrollHeight ?? 0);
      },
    },
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  dom.window.localStorage.setItem(
    THREAD_SCROLL_POSITION_STORAGE_KEY,
    JSON.stringify({
      "thread-1": {
        following: false,
        scrollTop: 400,
        clientHeight: 400,
        scrollHeight: 1200,
        updatedAt: 1,
      },
    }),
  );
  const root = createRoot(container);
  let viewport: ReturnType<typeof useTranscriptViewport> | undefined;
  let input: TranscriptViewportInput = {
    scopeKey: "scope-1",
    conversationId: "thread-1",
    openScroll: "remember",
    historyReady: true,
    empty: false,
    contentKey: "content-1",
    layoutKey: "files",
  };

  function Harness({ value }: { value: TranscriptViewportInput }) {
    viewport = useTranscriptViewport(value);
    return createElement(
      "div",
      {
        ref: viewport.viewportRef,
        onScroll: viewport.onScroll,
        "data-client-height": "400",
        "data-scroll-height": "1000",
      },
      createElement("div", { ref: viewport.contentRef }),
    );
  }
  const current = () => {
    assert.ok(viewport);
    return viewport;
  };

  try {
    await act(async () => root.render(createElement(Harness, { value: input })));
    const element = current().viewportRef.current!;
    assert.equal(element.scrollTop, 300, "initial remembered position maps by scroll ratio");
    assert.equal(current().following, false);

    element.scrollTop = 100;
    await act(async () => element.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    assert.equal(current().following, false);
    const stored = JSON.parse(
      dom.window.localStorage.getItem(THREAD_SCROLL_POSITION_STORAGE_KEY) ?? "{}",
    ) as Record<string, { scrollTop: number; following: boolean }>;
    assert.deepEqual(
      { scrollTop: stored["thread-1"]?.scrollTop, following: stored["thread-1"]?.following },
      { scrollTop: 100, following: false },
    );

    input = { ...input, contentKey: "content-2" };
    await act(async () => root.render(createElement(Harness, { value: input })));
    assert.equal(element.scrollTop, 100, "content growth does not steal a scrolled-up viewport");

    await act(async () => current().jumpToLatest());
    assert.equal(element.scrollTop, 1000);
    assert.equal(current().following, true);
    element.scrollTop = 500;
    await act(async () => {
      resizeObservers.at(-1)?.callback([], {} as ResizeObserver);
    });
    assert.equal(element.scrollTop, 1000, "resize keeps a following viewport at the tail");

    dom.window.localStorage.setItem(
      THREAD_SCROLL_POSITION_STORAGE_KEY,
      JSON.stringify({
        "thread-2": {
          following: false,
          scrollTop: 400,
          clientHeight: 400,
          scrollHeight: 1200,
          updatedAt: 1,
        },
      }),
    );
    input = { ...input, scopeKey: "scope-2", conversationId: "thread-2" };
    await act(async () => root.render(createElement(Harness, { value: input })));
    assert.equal(
      element.scrollTop,
      1000,
      "scope change does not apply saved placement to the previous ready transcript",
    );
    input = { ...input, historyReady: false, empty: true, contentKey: "thread-2-loading" };
    await act(async () => root.render(createElement(Harness, { value: input })));
    input = { ...input, historyReady: true, empty: false, contentKey: "thread-2-restored" };
    await act(async () => root.render(createElement(Harness, { value: input })));
    assert.equal(element.scrollTop, 300, "remembered position maps by scroll ratio");
    assert.equal(current().following, false);

    input = { ...input, empty: true, contentKey: "empty" };
    await act(async () => root.render(createElement(Harness, { value: input })));
    assert.equal(element.scrollTop, 0);
  } finally {
    await act(async () => root.unmount());
    assert.ok(resizeObservers.every((observer) => observer.disconnected));
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(scope, key);
      else Object.assign(scope, { [key]: value });
    }
  }
});
