import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { ConversationSummary } from "../../types";
import { ThreadRow } from "./thread-row";

const conversation: ConversationSummary = {
  id: "thread-1",
  projectId: "project-1",
  projectName: "Example",
  title: "Example thread",
  worktree: "/repo/.aldunis/wt/example",
  provider: "codex-cli",
  updatedAt: "2026-08-02T10:00:00.000Z",
};

test("beside is available from the thread-row menu and invokes its action", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const globalScope = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousGlobals = {
    window: globalScope.window,
    document: globalScope.document,
    Node: globalScope.Node,
    HTMLElement: globalScope.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalScope.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalScope, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  let besideCalls = 0;

  try {
    await act(async () => {
      root.render(createElement(ThreadRow, {
        conversation,
        active: false,
        onOpen: () => undefined,
        onOpenBeside: () => {
          besideCalls += 1;
        },
        showBeside: true,
        onAction: () => undefined,
      }));
    });

    assert.equal(container.querySelector(".beside"), null);
    const trigger = container.querySelector<HTMLButtonElement>(".row-more");
    assert.ok(trigger);

    await act(async () => {
      trigger.click();
    });

    const beside = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "Beside");
    assert.ok(beside);

    await act(async () => {
      beside.click();
    });

    assert.equal(besideCalls, 1);
    assert.equal(container.querySelector(".row-menu-pop"), null);
  } finally {
    await act(async () => {
      root.unmount();
    });
    dom.window.close();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) Reflect.deleteProperty(globalScope, key);
      else Object.assign(globalScope, { [key]: value });
    }
  }
});
