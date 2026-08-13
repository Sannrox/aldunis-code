import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("optional control failures preserve the renderer and expose bounded recovery", async () => {
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
    getComputedStyle: scope.getComputedStyle,
    requestAnimationFrame: scope.requestAnimationFrame,
    cancelAnimationFrame: scope.cancelAnimationFrame,
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
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { OptionalControlBoundary } = await import("./components/optional-control-boundary");
  const container = dom.window.document.querySelector<HTMLElement>("#app");
  assert.ok(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  let dismissed = 0;
  let reloaded = 0;
  function BrokenControl(): React.ReactNode {
    throw new Error("sensitive chunk URL");
  }
  const PendingControl = React.lazy(
    () => new Promise<{ default: () => React.ReactNode }>(() => undefined),
  );

  try {
    await act(async () => {
      root.render(
        createElement(
          React.Fragment,
          null,
          createElement(
            OptionalControlBoundary,
            { label: "Loaded", onDismiss: () => undefined },
            createElement("p", null, "Loaded control remains visible"),
          ),
          createElement(
            OptionalControlBoundary,
            { label: "Pending", onDismiss: () => undefined },
            createElement(PendingControl),
          ),
        ),
      );
    });
    assert.match(container.textContent ?? "", /Loaded control remains visible/);

    await act(async () => {
      root.render(
        createElement(
          OptionalControlBoundary,
          {
            label: "Repository controls",
            onDismiss: () => (dismissed += 1),
            onReload: () => (reloaded += 1),
          },
          createElement(BrokenControl),
        ),
      );
    });
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 0)));
    assert.match(
      dom.window.document.body.textContent ?? "",
      /Repository controls could not be loaded/,
    );
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /sensitive chunk URL/);
    const buttons = dom.window.document.body.querySelectorAll<HTMLButtonElement>("button");
    assert.equal(buttons.length, 2);
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    assert.equal(dismissed, 1);
    assert.equal(reloaded, 1);
  } finally {
    await act(async () => root.unmount());
    console.error = originalConsoleError;
    Object.assign(scope, previous);
    dom.window.close();
  }
});
