import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { ReleaseDeliverySession } from "../../types";
import {
  nextReleaseAction,
  repairPromptForOutcome,
  releaseSessionForView,
  TenkaiDeliveryPanel,
} from "./tenkai-delivery";

test("Tenkai delivery renders the staged local authority boundary", () => {
  const html = renderToStaticMarkup(
    <TenkaiDeliveryPanel
      repository={{
        projectId: "project-1",
        name: "widget",
        root: "/repo",
        defaultBranch: "main",
        selectedWorktree: "/repo",
        worktrees: [],
      }}
      projectId="project-1"
      chiseiBound
    />,
  );
  assert.match(html, /Candidate ledger/);
  assert.match(html, /Release delivery stages/);
  assert.match(html, /Tenkai manifest/);
  assert.match(html, /not an operating-system sandbox/);
  assert.match(html, /exposes no general terminal/);
});

test("Tenkai delivery aborts superseded and unmounted inspections", async () => {
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
  const signals: AbortSignal[] = [];
  const fetchMock = ((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal);
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
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
  const repository = (selectedWorktree: string) => ({
    projectId: "project-1",
    name: "widget",
    root: "/repo",
    defaultBranch: "main",
    selectedWorktree,
    worktrees: [],
  });

  try {
    await act(async () => {
      root.render(
        <TenkaiDeliveryPanel
          repository={repository("/repo/first")}
          projectId="project-1"
          chiseiBound
        />,
      );
    });
    assert.equal(signals.length, 1);

    await act(async () => {
      root.render(
        <TenkaiDeliveryPanel
          repository={repository("/repo/second")}
          projectId="project-1"
          chiseiBound
        />,
      );
    });
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals.length, 2);
    assert.doesNotMatch(container.textContent ?? "", /AbortError|aborted|cancelled/i);

    await act(async () => root.unmount());
    assert.equal(signals[1]?.aborted, true);
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) Reflect.deleteProperty(globalScope, key);
      else Object.assign(globalScope, { [key]: value });
    }
  }
});

test("Tenkai delivery keeps a superseded execution locked until it settles", async () => {
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
  const inspection = {
    configuration: { chisei: true, tenkai: true, localOnly: true },
    sessions: [],
    terminalOutcomes: { authority: "tenkai", state: "live", outcomes: [], warning: null },
  };
  let settleExecution!: (response: Response) => void;
  const execution = new Promise<Response>((resolve) => {
    settleExecution = resolve;
  });
  const response = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
  const fetchMock = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/release-delivery/inspect") return response(inspection);
    if (url === "/api/release-delivery/plans") {
      return response({
        id: "plan-old",
        action: "prepare",
        summary: "Prepare old candidate",
        details: [],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    if (url.endsWith("/execute")) return execution;
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
  const repository = (selectedWorktree: string) => ({
    projectId: "project-1",
    name: "widget",
    root: "/repo",
    defaultBranch: "main",
    selectedWorktree,
    worktrees: [],
  });
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );

  try {
    await act(async () => {
      root.render(
        <TenkaiDeliveryPanel
          repository={repository("/repo/old")}
          projectId="project-1"
          chiseiBound
        />,
      );
    });
    await act(async () => button("Prepare candidate")?.click());
    await act(async () => button("Confirm Prepare candidate")?.click());

    await act(async () => {
      root.render(
        <TenkaiDeliveryPanel
          repository={repository("/repo/new")}
          projectId="project-1"
          chiseiBound
        />,
      );
    });
    const locked = button("Inspecting…");
    assert.ok(locked);
    assert.equal(locked.disabled, true);

    await act(async () => {
      settleExecution(response({ id: "old-session", state: "candidate_ready" }));
      await execution;
    });
    assert.equal(button("Prepare candidate")?.disabled, false);
    assert.doesNotMatch(container.textContent ?? "", /old-session|finished with candidate ready/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, value] of Object.entries(previousGlobals)) {
      if (value === undefined) Reflect.deleteProperty(globalScope, key);
      else Object.assign(globalScope, { [key]: value });
    }
  }
});

test("workflow action routing never skips an authority stage", () => {
  const session = (state: string) => ({ state }) as ReleaseDeliverySession;
  assert.equal(nextReleaseAction(null), "prepare");
  assert.equal(nextReleaseAction(session("candidate_ready")), "evaluate");
  assert.equal(nextReleaseAction(session("governance_allowed")), "publish");
  assert.equal(nextReleaseAction(session("publication_unknown")), "reconcile");
  assert.equal(nextReleaseAction(session("published")), "promote");
  assert.equal(nextReleaseAction(session("promoted")), "plan");
  assert.equal(nextReleaseAction(session("planned")), "apply");
  assert.equal(nextReleaseAction(session("unknown")), "reconcile");
  assert.equal(nextReleaseAction(session("stale")), null);
});

test("starting a new candidate does not reuse the selected historical session", () => {
  const historical = { id: "session-1", state: "completed" } as ReleaseDeliverySession;
  assert.equal(releaseSessionForView([historical], historical.id, false), historical);
  assert.equal(releaseSessionForView([historical], historical.id, true), null);
  assert.equal(
    nextReleaseAction(releaseSessionForView([historical], historical.id, true)),
    "prepare",
  );
});

test("repair handoff contains bounded evidence without provider output or local paths", () => {
  const prompt = repairPromptForOutcome(
    {
      candidate: {
        identity: `sha256:${"a".repeat(64)}`,
        document: { commit: { oid: "a".repeat(40) } },
      },
    } as ReleaseDeliverySession,
    {
      eventId: "tenkai:outcome:v2:event-1",
      schema: "tenkai.terminal_outcome.v1",
      deploymentId: "tenkai:deployment:local:widget:1",
      planId: "tenkai:plan:local:1",
      releaseId: "tenkai:release:widget:1.2.3",
      product: "widget",
      environmentId: "tenkai:environment:local",
      configurationId: "tenkai:configuration:local",
      terminalState: "deployment_failed",
      observedAt: new Date(1_000).toISOString(),
      bindingDigest: `sha256:${"b".repeat(64)}`,
      releaseDigest: `sha256:${"c".repeat(64)}`,
      planDigest: `sha256:${"d".repeat(64)}`,
      configurationDigest: `sha256:${"e".repeat(64)}`,
      deliveryState: "delivered",
      attempts: 1,
      nextAttemptAt: new Date(1_000).toISOString(),
      deliveredAt: new Date(1_010).toISOString(),
      claimUntil: null,
      deliveryLagMs: 10,
    },
  );
  assert.match(prompt, /event_id=tenkai:outcome:v2:event-1/);
  assert.match(prompt, /binding_digest=sha256:/);
  assert.doesNotMatch(prompt, /payload|raw output|\/Users\/|tenkai\.db/);
});
