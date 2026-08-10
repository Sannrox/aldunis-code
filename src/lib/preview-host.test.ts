import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewHost, previewHostErrorMessage } from "./preview-host";

const scope = { root: "/repo", worktree: "/repo/worktree" };
const conversationId = "conversation-1";
const preview = (state: string = "approval_pending") => ({
  id: "preview-1",
  repository: scope.root,
  worktree: scope.worktree,
  command: "npm run dev",
  origin: "http://localhost:4173",
  state,
  approvalExpiresAt: null,
  message: null,
});
const browser = (state: string = "ready") => ({
  schemaVersion: 1,
  id: "browser-1",
  conversationId,
  origin: "http://localhost:4173",
  partition: "persist:conversation-1",
  state,
  agentControl: false,
  controller: "human",
  url: null,
  title: null,
  error: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

function scripted(responses: Array<{ ok?: boolean; body: unknown }>) {
  const calls: Array<{ route: string; body: unknown }> = [];
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      route: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.ok === false ? 400 : 200 });
  };
  return { calls, request };
}

test("preview host hides scope and identities across the complete lifecycle", async () => {
  const transport = scripted([
    { body: preview() },
    { body: preview("running") },
    { body: browser() },
    { body: { ...browser(), agentControl: true, controller: "agent" } },
    { body: browser() },
    { body: browser("closed") },
  ]);
  const host = createPreviewHost(scope, transport.request);
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  await host.perform({ kind: "preview.decide", decision: "allow_once" });
  await host.perform({ kind: "browser.open", conversationId });
  await host.perform({ kind: "browser.control", enabled: true });
  await host.perform({ kind: "browser.status" });
  const closed = await host.perform({ kind: "browser.close" });

  assert.equal(closed.browser, null);
  assert.deepEqual(
    transport.calls.map(({ route }) => route),
    [
      "/api/previews/request",
      "/api/previews/preview-1/decide",
      "/api/browser/sessions/open",
      "/api/browser/sessions/control",
      "/api/browser/sessions/status",
      "/api/browser/sessions/close",
    ],
  );
  assert.deepEqual(transport.calls[3]?.body, {
    root: scope.root,
    worktree: scope.worktree,
    conversationId,
    origin: "http://localhost:4173",
    sessionId: "browser-1",
    enabled: true,
  });
});

test("preview host rejects invalid transitions without calling the adapter", async () => {
  const transport = scripted([]);
  const host = createPreviewHost(scope, transport.request);
  await assert.rejects(
    host.perform({ kind: "browser.open", conversationId }),
    /Start the local preview/,
  );
  await assert.rejects(
    host.perform({ kind: "preview.decide", decision: "deny" }),
    /no longer pending/,
  );
  assert.equal(transport.calls.length, 0);
});

test("preview host rejects malformed successful responses without replacing state", async () => {
  const transport = scripted([{ body: { id: "incomplete" } }]);
  const host = createPreviewHost(scope, transport.request);
  await assert.rejects(
    host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" }),
    /could not be prepared/,
  );
});

test("preview host rejects responses that escape its scope or replace host identities", async () => {
  const wrongScope = scripted([{ body: { ...preview(), worktree: "/other" } }]);
  await assert.rejects(
    createPreviewHost(scope, wrongScope.request).perform({
      kind: "preview.prepare",
      origin: "http://localhost:4173",
    }),
    /could not be prepared/,
  );

  const replacedIdentity = scripted([
    { body: preview("running") },
    { body: browser() },
    { body: { ...browser(), id: "browser-2" } },
  ]);
  const host = createPreviewHost(scope, replacedIdentity.request);
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  await host.perform({ kind: "browser.open", conversationId });
  await assert.rejects(host.perform({ kind: "browser.status" }), /status is unavailable/);
});

test("preview host normalizes host and network failures", async () => {
  const hostFailure = scripted([{ ok: false, body: { error: "Preview origin is invalid." } }]);
  await assert.rejects(
    createPreviewHost(scope, hostFailure.request).perform({
      kind: "preview.prepare",
      origin: "http://example.test",
    }),
    /Preview origin is invalid/,
  );

  const networkFailure = createPreviewHost(scope, async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    networkFailure.perform({ kind: "preview.prepare", origin: "http://localhost:4173" }),
    /Failed to fetch/,
  );
});

test("confirmed close fails closed while disposal is idempotent and best effort", async () => {
  const transport = scripted([
    { body: preview("running") },
    { body: browser() },
    { ok: false, body: { error: "Desktop close failed." } },
    { ok: false, body: { error: "Desktop close failed again." } },
  ]);
  const host = createPreviewHost(scope, transport.request);
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  await host.perform({ kind: "browser.open", conversationId });
  await assert.rejects(host.perform({ kind: "browser.close" }), /Desktop close failed/);
  await host.dispose();
  await host.dispose();
  assert.equal(transport.calls.filter(({ route }) => route.endsWith("/close")).length, 2);
  await assert.rejects(host.perform({ kind: "browser.status" }), /disposed/);
});

test("preview host serializes overlapping actions", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  let call = 0;
  const host = createPreviewHost(scope, async () => {
    call += 1;
    order.push(`start-${call}`);
    if (call === 1) await first;
    order.push(`end-${call}`);
    return new Response(JSON.stringify(preview(call === 1 ? "approval_pending" : "running")));
  });
  const prepare = host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  const decide = host.perform({ kind: "preview.decide", decision: "allow_once" });
  await Promise.resolve();
  assert.deepEqual(order, ["start-1"]);
  release();
  await Promise.all([prepare, decide]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
});

test("disposal waits for an in-flight browser open before cleanup", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const routes: string[] = [];
  const host = createPreviewHost(scope, async (input) => {
    const route = String(input);
    routes.push(route);
    if (route === "/api/previews/request") {
      return new Response(JSON.stringify(preview("running")));
    }
    if (route === "/api/browser/sessions/open") {
      markStarted();
      await opened;
      return new Response(JSON.stringify(browser()));
    }
    return new Response(JSON.stringify(browser("closed")));
  });
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  const opening = host.perform({ kind: "browser.open", conversationId });
  await started;
  const disposing = host.dispose();
  release();
  await Promise.all([opening, disposing]);
  assert.deepEqual(routes, [
    "/api/previews/request",
    "/api/browser/sessions/open",
    "/api/browser/sessions/close",
  ]);
});

test("scope replacement disposal stops the retained preview", async () => {
  const transport = scripted([{ body: preview("running") }, { body: preview("stopped") }]);
  const host = createPreviewHost(scope, transport.request);
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  await host.dispose({ stopPreview: true });
  assert.deepEqual(
    transport.calls.map(({ route }) => route),
    ["/api/previews/request", "/api/previews/preview-1/stop"],
  );
});

test("browser release is best effort and preserves the worktree preview", async () => {
  const transport = scripted([
    { body: preview("running") },
    { body: browser() },
    { ok: false, body: { error: "Desktop close failed." } },
    { body: preview("running") },
  ]);
  const host = createPreviewHost(scope, transport.request);
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  await host.perform({ kind: "browser.open", conversationId });
  const released = await host.perform({ kind: "browser.release" });
  assert.equal(released.browser, null);
  assert.equal(released.preview?.state, "running");
  const refreshed = await host.perform({ kind: "preview.status" });
  assert.equal(refreshed.preview?.id, "preview-1");
});

test("browser release queued during open closes the stale conversation session", async () => {
  let releaseOpen!: () => void;
  let markOpenStarted!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const openStarted = new Promise<void>((resolve) => {
    markOpenStarted = resolve;
  });
  const routes: string[] = [];
  const host = createPreviewHost(scope, async (input) => {
    const route = String(input);
    routes.push(route);
    if (route === "/api/previews/request") {
      return new Response(JSON.stringify(preview("running")));
    }
    if (route === "/api/browser/sessions/open") {
      markOpenStarted();
      await openGate;
      return new Response(JSON.stringify(browser()));
    }
    return new Response(JSON.stringify(browser("closed")));
  });
  await host.perform({ kind: "preview.prepare", origin: "http://localhost:4173" });
  const opening = host.perform({ kind: "browser.open", conversationId });
  await openStarted;
  const releasing = host.perform({ kind: "browser.release" });
  releaseOpen();
  const [, released] = await Promise.all([opening, releasing]);
  assert.equal(released.browser, null);
  assert.equal(released.preview?.state, "running");
  assert.deepEqual(routes, [
    "/api/previews/request",
    "/api/browser/sessions/open",
    "/api/browser/sessions/close",
  ]);
});

test("preview transport failures provide recovery guidance", () => {
  assert.equal(
    previewHostErrorMessage(new TypeError("Failed to fetch"), "Preview could not be prepared."),
    "Preview service is unavailable. The action was not confirmed; retry when the local host is ready.",
  );
});
