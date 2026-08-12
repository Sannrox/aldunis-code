import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DomainPage } from "./domain-page";

test("Chisei page exposes a read-only project-bound Action projection", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="project-1"
      projects={[
        {
          id: "project-1",
          name: "aldunis-code",
          root: "/repo",
          openedAt: new Date(0).toISOString(),
          chiseiNamespace: "team/project",
        },
      ]}
    />,
  );
  assert.match(html, /Governed Actions/);
  assert.match(html, /Project namespace/);
  assert.match(html, /stored by this local host/);
  assert.match(html, /cannot admit, claim, retry, or mutate Actions/);
  assert.match(html, /team\/project/);
  assert.match(html, /aria-labelledby="chisei-actions-title"/);
});

test("Chisei Action selection aborts superseded and unmounted detail reads", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const globalScope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousGlobals = {
    window: globalScope.window,
    document: globalScope.document,
    Node: globalScope.Node,
    HTMLElement: globalScope.HTMLElement,
    fetch: globalScope.fetch,
    IS_REACT_ACT_ENVIRONMENT: globalScope.IS_REACT_ACT_ENVIRONMENT,
  };
  const detailSignals: AbortSignal[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/actions/list")) {
      return {
        ok: true,
        json: async () => ({
          state: "live",
          actions: ["action-1", "action-2"].map((instanceId, index) => ({
            instanceId,
            typeId: `review-${index + 1}`,
            version: "1",
            operationId: null,
            status: "admitted",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
        }),
      } as Response;
    }
    if (url.endsWith("/actions/detail")) {
      assert.ok(init?.signal);
      detailSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  Object.assign(globalScope, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    fetch: fetchMock,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <DomainPage
          product="chisei"
          selectedProjectId="project-1"
          projects={[
            {
              id: "project-1",
              name: "Aldunis",
              root: "/repo",
              openedAt: "2026-01-01T00:00:00.000Z",
              chiseiNamespace: "team/project",
            },
          ]}
        />,
      );
    });
    const actions = container.querySelectorAll<HTMLButtonElement>(".chisei-action-list button");
    assert.equal(actions.length, 2);

    await act(async () => actions[0]?.click());
    assert.equal(detailSignals.length, 1);
    await act(async () => actions[1]?.click());
    assert.equal(detailSignals[0]?.aborted, true);
    assert.equal(detailSignals.length, 2);

    await act(async () => root.unmount());
    assert.equal(detailSignals[1]?.aborted, true);
    assert.doesNotMatch(container.textContent ?? "", /AbortError|cancelled/i);
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) Reflect.deleteProperty(globalScope, key);
      else Object.assign(globalScope, { [key]: value });
    }
  }
});

test("Chisei page retains the active worktree binding when projects are collapsed", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="worktree-2"
      projects={[
        {
          id: "main-project",
          name: "Aldunis",
          root: "/tmp/aldunis",
          openedAt: "2026-01-01T00:00:00.000Z",
          memberIds: ["main-project", "worktree-2"],
          chiseiNamespace: "team/main",
          chiseiBindings: {
            "main-project": "team/main",
            "worktree-2": "team/worktree",
          },
        },
      ]}
    />,
  );
  assert.match(html, /value="team\/worktree"/);
  assert.doesNotMatch(html, /value="team\/main"/);
});

test("the selected worktree resolves the project record that owns delivery authority", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="main-project"
      repository={{
        projectId: "main-project",
        name: "Aldunis",
        root: "/tmp/aldunis",
        defaultBranch: "main",
        selectedWorktree: "/tmp/aldunis-worktree",
        worktrees: [],
      }}
      projects={[
        {
          id: "main-project",
          name: "Aldunis",
          root: "/tmp/aldunis",
          openedAt: "2026-01-01T00:00:00.000Z",
          memberIds: ["main-project", "worktree-2"],
          memberRoots: {
            "main-project": "/tmp/aldunis",
            "worktree-2": "/tmp/aldunis-worktree",
          },
          chiseiNamespace: "team/main",
          chiseiBindings: {
            "main-project": "team/main",
            "worktree-2": "team/worktree",
          },
        },
      ]}
    />,
  );
  assert.match(html, /value="team\/worktree"/);
  assert.doesNotMatch(html, /value="team\/main"/);
});

test("Chisei page preserves an explicitly unbound active worktree", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="worktree-2"
      projects={[
        {
          id: "main-project",
          name: "Aldunis",
          root: "/tmp/aldunis",
          openedAt: "2026-01-01T00:00:00.000Z",
          memberIds: ["main-project", "worktree-2"],
          chiseiNamespace: "team/main",
          chiseiBindings: {
            "main-project": "team/main",
            "worktree-2": null,
          },
        },
      ]}
    />,
  );
  assert.match(html, /id="chisei-project-namespace"[^>]*value=""/);
  assert.doesNotMatch(html, /value="team\/main"/);
});

test("Chisei binding administration is disabled for remote clients", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      chiseiBindingAdministrationAvailable={false}
      selectedProjectId="project-1"
      projects={[
        {
          id: "project-1",
          name: "Aldunis",
          root: "/tmp/aldunis",
          openedAt: "2026-01-01T00:00:00.000Z",
          chiseiNamespace: "team/project",
        },
      ]}
    />,
  );
  assert.match(html, /Binding administration is available only on loopback/);
  assert.match(html, /id="chisei-project-namespace"[^>]*disabled/);
  assert.match(html, /type="submit"[^>]*disabled/);
});

test("Chisei page does not retarget an unresolved selected project", () => {
  const html = renderToStaticMarkup(
    <DomainPage
      product="chisei"
      selectedProjectId="missing-project"
      projects={[
        {
          id: "other-project",
          name: "Other",
          root: "/tmp/other",
          openedAt: "2026-01-01T00:00:00.000Z",
          chiseiNamespace: "team/other",
        },
      ]}
    />,
  );
  assert.match(html, /Open a local project/);
  assert.doesNotMatch(html, /team\/other/);
});
