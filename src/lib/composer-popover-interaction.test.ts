import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useComposerPopoverInteraction } from "./composer-popover-interaction";

test("composer popover interaction owns exclusive lifetime and keyboard behavior", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = {
    window: scope.window,
    document: scope.document,
    Node: scope.Node,
    HTMLElement: scope.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: scope.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(scope, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  const providerRef = createRef<HTMLDivElement>();
  const modelRef = createRef<HTMLDivElement>();
  let interaction:
    ReturnType<typeof useComposerPopoverInteraction<"provider" | "model">> | undefined;
  const currentInteraction = () => {
    assert.ok(interaction);
    return interaction;
  };
  let activations = 0;

  function Harness() {
    interaction = useComposerPopoverInteraction({
      provider: { container: providerRef, optionSelector: "[data-option]" },
      model: { container: modelRef, optionSelector: "[data-option]" },
    });
    return createElement(
      "div",
      null,
      createElement(
        "div",
        { ref: providerRef },
        createElement("button", {
          "data-option": "",
          onClick: () => {
            if (!currentInteraction().pointerSelectionAllowed("provider")) return;
            activations += 1;
            currentInteraction().closeMenus();
          },
        }),
        createElement("button", { "data-option": "", disabled: true }),
        createElement("button", { "data-option": "" }),
      ),
      createElement("div", { ref: modelRef }, createElement("button", { "data-option": "" })),
    );
  }

  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => currentInteraction().toggleMenu("provider"));
    assert.equal(currentInteraction().isOpen("provider"), true);
    assert.equal(currentInteraction().pointerSelectionAllowed("provider"), false);
    await act(async () => currentInteraction().toggleMenu("model"));
    assert.equal(currentInteraction().isOpen("provider"), false);
    assert.equal(currentInteraction().isOpen("model"), true);
    await act(async () => currentInteraction().toggleMenu("provider"));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    const options = providerRef.current!.querySelectorAll<HTMLButtonElement>("[data-option]");
    await act(async () =>
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp" })),
    );
    assert.equal(document.activeElement, options[2]);
    await act(async () =>
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home" })),
    );
    assert.equal(document.activeElement, options[0]);
    await act(async () =>
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" })),
    );
    assert.equal(activations, 1);
    assert.equal(currentInteraction().activeMenu, null);

    await act(async () => currentInteraction().toggleMenu("provider"));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    const outside = dom.window.document.createElement("button");
    dom.window.document.body.append(outside);
    const outsidePointer = new dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
    await act(async () => outside.dispatchEvent(outsidePointer));
    assert.equal(outsidePointer.defaultPrevented, true);
    assert.equal(currentInteraction().activeMenu, null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(scope, key);
      else Object.assign(scope, { [key]: value });
    }
  }
});
