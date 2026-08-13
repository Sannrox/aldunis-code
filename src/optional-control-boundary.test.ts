import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

async function withOptionalControlDom(
  run: (input: {
    window: Window & typeof globalThis;
    document: Document;
    container: HTMLElement;
    OptionalControlBoundary: typeof import("./components/optional-control-boundary").OptionalControlBoundary;
  }) => Promise<void>,
): Promise<void> {
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
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await run({
      window: dom.window as unknown as Window & typeof globalThis,
      document: dom.window.document,
      container,
      OptionalControlBoundary,
    });
  } finally {
    console.error = originalConsoleError;
    Object.assign(scope, previous);
    dom.window.close();
  }
}

test("optional control failures preserve the renderer and expose bounded recovery", async () => {
  await withOptionalControlDom(async ({ document, container, OptionalControlBoundary }) => {
    const root = createRoot(container);
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
            createElement(
              OptionalControlBoundary,
              { label: "Lifecycle dialog", onDismiss: () => undefined, pendingDialog: true },
              createElement(PendingControl),
            ),
          ),
        );
      });
      assert.match(container.textContent ?? "", /Loaded control remains visible/);
      assert.match(document.body.textContent ?? "", /Loading lifecycle dialog…/);

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
      await act(async () => new Promise((resolve) => document.defaultView?.setTimeout(resolve, 0)));
      assert.match(document.body.textContent ?? "", /Repository controls could not be loaded/);
      assert.doesNotMatch(document.body.textContent ?? "", /sensitive chunk URL/);
      const buttons = document.body.querySelectorAll<HTMLButtonElement>("button");
      assert.equal(buttons.length, 2);
      await act(async () => buttons[0].click());
      await act(async () => buttons[1].click());
      assert.equal(dismissed, 1);
      assert.equal(reloaded, 1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("optional control pending fallback stays visible and busy until content paints", async () => {
  await withOptionalControlDom(async ({ document, container, OptionalControlBoundary }) => {
    const root = createRoot(container);
    const pending: boolean[] = [];
    let resolvePending: ((value: { default: () => React.ReactNode }) => void) | undefined;
    const PendingControl = React.lazy(
      () =>
        new Promise<{ default: () => React.ReactNode }>((resolve) => {
          resolvePending = resolve;
        }),
    );

    try {
      await act(async () => {
        root.render(
          createElement(
            OptionalControlBoundary,
            {
              label: "Preview",
              onDismiss: () => undefined,
              onPendingChange: (value) => pending.push(value),
              fallback: createElement(
                "section",
                { "aria-busy": "true", "data-workspace-panel-pending": "preview" },
                "Opening Preview…",
              ),
            },
            createElement(PendingControl),
          ),
        );
      });
      assert.match(container.textContent ?? "", /Opening Preview…/);
      assert.equal(
        container.querySelector("[aria-busy='true']")?.getAttribute("data-workspace-panel-pending"),
        "preview",
      );
      assert.equal(pending.at(-1), true);

      await act(async () => {
        resolvePending?.({
          default: function ReadyControl() {
            return createElement("p", null, "Preview ready");
          },
        });
      });
      await act(async () => new Promise((resolve) => document.defaultView?.setTimeout(resolve, 0)));
      assert.match(container.textContent ?? "", /Preview ready/);
      assert.doesNotMatch(container.textContent ?? "", /Opening Preview…/);
      assert.equal(pending.at(-1), false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("optional control recovery dialog clears pending without exposing chunk diagnostics", async () => {
  await withOptionalControlDom(async ({ document, container, OptionalControlBoundary }) => {
    const root = createRoot(container);
    const pending: boolean[] = [];
    function BrokenControl(): React.ReactNode {
      throw new Error("sensitive chunk URL");
    }

    try {
      await act(async () => {
        root.render(
          createElement(
            OptionalControlBoundary,
            {
              label: "Files",
              onDismiss: () => undefined,
              onPendingChange: (value) => pending.push(value),
              fallback: createElement("p", { "aria-busy": "true" }, "Opening Files…"),
            },
            createElement(BrokenControl),
          ),
        );
      });
      await act(async () => new Promise((resolve) => document.defaultView?.setTimeout(resolve, 0)));
      assert.match(document.body.textContent ?? "", /Files could not be loaded/);
      assert.doesNotMatch(document.body.textContent ?? "", /Opening Files…/);
      assert.doesNotMatch(document.body.textContent ?? "", /sensitive chunk URL/);
      assert.equal(pending.at(-1), false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
