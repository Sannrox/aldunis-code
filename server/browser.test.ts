import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserUrl,
  type BrowserHost,
  type BrowserHostResult,
  type BrowserHostState,
  type BrowserOperation,
  SharedBrowserBroker,
  normalizeBrowserOperation,
} from "./browser.ts";

class FakeBrowserHost implements BrowserHost {
  state: BrowserHostState = {
    connected: true,
    url: "http://127.0.0.1:4173/",
    title: "Fixture",
    controller: "human",
    controlEpoch: 0,
    error: null,
  };
  operations: BrowserOperation[] = [];
  closedSessionIds: string[] = [];

  getState(): BrowserHostState {
    return { ...this.state };
  }

  execute(
    _sessionId: string,
    operation: BrowserOperation,
    expectedControlEpoch: number,
  ): BrowserHostResult {
    if (expectedControlEpoch !== this.state.controlEpoch) {
      return { ok: false, code: "browser_human_control", message: "Human took control." };
    }
    this.operations.push(operation);
    return operation.kind === "status"
      ? { ok: true, kind: "status", state: this.getState() }
      : operation.kind === "snapshot"
        ? {
            ok: true,
            kind: "snapshot",
            snapshot: {
              url: this.state.url,
              title: this.state.title,
              loading: false,
              visibleText: "fixture",
              interactiveElements: [],
              screenshot: null,
              actionTimeline: [],
            },
          }
        : { ok: true, kind: "action", message: "done", state: this.getState() };
  }

  setAgentControl(_sessionId: string, enabled: boolean): void {
    this.state.controller = enabled ? "agent" : "human";
  }

  close(sessionId: string): void {
    this.closedSessionIds.push(sessionId);
    this.state.connected = false;
  }

  setPictureInPicture(): void {}
}

test("shared browser accepts only bounded loopback URLs and operations", () => {
  assert.equal(assertBrowserUrl("http://localhost:4173"), "http://localhost:4173/");
  assert.equal(assertBrowserUrl("https://[::1]:8443/app"), "https://[::1]:8443/app");
  assert.throws(() => assertBrowserUrl("https://example.com"), /loopback/);
  assert.throws(() => assertBrowserUrl("http://user:pass@127.0.0.1:4173"), /loopback/);
  assert.throws(() => assertBrowserUrl("file:///tmp/page.html"), /loopback/);
  assert.deepEqual(normalizeBrowserOperation({ kind: "click", selector: "#submit" }), {
    kind: "click",
    selector: "#submit",
  });
  assert.throws(() => normalizeBrowserOperation({ kind: "wait", milliseconds: 5_001 }), /5000/);
  assert.throws(() => normalizeBrowserOperation({ kind: "click", x: -1, y: 2 }), /coordinate/);
});

test("shared browser broker reuses the provider token and fails closed on control changes", async () => {
  const host = new FakeBrowserHost();
  const broker = new SharedBrowserBroker(host);
  const configuration = broker.providerMcpConfiguration({
    conversationId: "conversation-1",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });
  const session = broker.open("conversation-1", "http://127.0.0.1:4173");
  assert.equal(session.partition, broker.open("conversation-1", session.origin).partition);
  assert.equal(configuration.environment.ALDUNIS_BROWSER_CONVERSATION_ID, "conversation-1");
  assert.equal(configuration.environment.ALDUNIS_BROWSER_TOKEN?.length, 36);
  assert.equal(configuration.environment.ALDUNIS_INTERNAL_REQUEST_TOKEN, undefined);

  const readOnly = await broker.executeProvider(
    "conversation-1",
    configuration.environment.ALDUNIS_BROWSER_TOKEN,
    { kind: "status" },
  );
  assert.equal(readOnly.ok, true);
  const waited = await broker.executeProvider(
    "conversation-1",
    configuration.environment.ALDUNIS_BROWSER_TOKEN,
    { kind: "wait", milliseconds: 0 },
  );
  assert.equal(waited.ok, true);
  const refused = await broker.executeProvider(
    "conversation-1",
    configuration.environment.ALDUNIS_BROWSER_TOKEN,
    { kind: "click", selector: "#submit" },
  );
  assert.deepEqual(refused, {
    ok: false,
    code: "browser_control_disabled",
    message: "The operator has not enabled agent control for this shared browser session.",
  });

  const enabled = await broker.setAgentControl(
    session.id,
    { conversationId: "conversation-1", origin: session.origin },
    true,
  );
  assert.equal(enabled.agentControl, true);
  const action = await broker.executeProvider(
    "conversation-1",
    configuration.environment.ALDUNIS_BROWSER_TOKEN,
    { kind: "click", selector: "#submit" },
  );
  assert.equal(action.ok, true);
  assert.equal(host.operations.at(-1)?.kind, "click");
  await assert.rejects(
    () =>
      broker.executeProvider("conversation-1", configuration.environment.ALDUNIS_BROWSER_TOKEN, {
        kind: "navigate",
        url: "http://127.0.0.1:9000/admin",
      }),
    /approved preview origin/,
  );

  host.state.controlEpoch += 1;
  host.state.controller = "human";
  const takeover = await broker.executeProvider(
    "conversation-1",
    configuration.environment.ALDUNIS_BROWSER_TOKEN,
    { kind: "navigate", url: "http://127.0.0.1:4173/next" },
  );
  assert.equal(takeover.ok, false);
  if (!takeover.ok) assert.equal(takeover.code, "browser_human_control");
  await broker.close(session.id, { conversationId: "conversation-1", origin: session.origin });
  await assert.rejects(
    () =>
      broker.executeProvider("conversation-1", configuration.environment.ALDUNIS_BROWSER_TOKEN, {
        kind: "status",
      }),
    /authorization is invalid/,
  );
});

test("shared browser MCP env forces Electron Node mode so desktop turns do not dock a second app", () => {
  const broker = new SharedBrowserBroker(new FakeBrowserHost());
  const desktop = broker.providerMcpConfiguration({
    conversationId: "conversation-electron",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/Applications/Aldunis Code.app/Contents/MacOS/Aldunis Code",
    script: "/app/browser-mcp.mjs",
    electronVersion: "43.2.0",
  });
  assert.equal(desktop.environment.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(desktop.environment.ALDUNIS_BROWSER_CONVERSATION_ID, "conversation-electron");

  const loopbackHost = broker.providerMcpConfiguration({
    conversationId: "conversation-node",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
    electronVersion: "",
  });
  assert.equal(loopbackHost.environment.ELECTRON_RUN_AS_NODE, undefined);
});

test("shared browser preserves a pre-opened session token across close and reopen", async () => {
  const broker = new SharedBrowserBroker(new FakeBrowserHost());
  const firstSession = broker.open("conversation-2", "http://127.0.0.1:4173");
  const firstConfiguration = broker.providerMcpConfiguration({
    conversationId: "conversation-2",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });
  await broker.close(firstSession.id, {
    conversationId: "conversation-2",
    origin: firstSession.origin,
  });
  // Closed session records are released; only the provider token is retained.
  assert.throws(
    () => {
      void broker.snapshot(firstSession.id);
    },
    (error: unknown) => error instanceof Error && /does not exist/.test(error.message),
  );
  const reopened = broker.open("conversation-2", firstSession.origin);
  assert.notEqual(reopened.id, firstSession.id);
  const secondConfiguration = broker.providerMcpConfiguration({
    conversationId: "conversation-2",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });
  assert.equal(
    secondConfiguration.environment.ALDUNIS_BROWSER_TOKEN,
    firstConfiguration.environment.ALDUNIS_BROWSER_TOKEN,
  );
});

test("shared browser releases provider-only tokens after a run", () => {
  const broker = new SharedBrowserBroker(new FakeBrowserHost());
  const configuration = broker.providerMcpConfiguration({
    conversationId: "conversation-finished",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });
  assert.equal(configuration.environment.ALDUNIS_BROWSER_TOKEN?.length, 36);
  assert.equal(broker.retainedProviderTokenCount, 1);

  broker.releaseProviderToken("conversation-finished");

  assert.equal(broker.retainedProviderTokenCount, 0);
});

test("shared browser republishes an active session token after run cleanup", () => {
  const broker = new SharedBrowserBroker(new FakeBrowserHost());
  const session = broker.open("conversation-active", "http://127.0.0.1:4173");
  const first = broker.providerMcpConfiguration({
    conversationId: "conversation-active",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });
  broker.releaseProviderToken("conversation-active");
  assert.equal(broker.retainedProviderTokenCount, 0);

  const next = broker.providerMcpConfiguration({
    conversationId: "conversation-active",
    endpoint: "http://127.0.0.1:4173/api/browser/tools",
    command: "/usr/bin/node",
    script: "/app/browser-mcp.mjs",
  });

  assert.equal(next.environment.ALDUNIS_BROWSER_TOKEN, first.environment.ALDUNIS_BROWSER_TOKEN);
  assert.equal(session.conversationId, "conversation-active");
  assert.equal(broker.retainedProviderTokenCount, 1);
});

test("shared browser replaces a failed session on the next open", async () => {
  const host = new FakeBrowserHost();
  const broker = new SharedBrowserBroker(host);
  const failed = broker.open("conversation-failed", "http://127.0.0.1:4173");
  host.state.error = "view crashed";
  host.state.connected = false;
  const snapshot = await broker.snapshot(failed.id);
  assert.equal(snapshot.state, "failed");
  const reopened = broker.open("conversation-failed", "http://127.0.0.1:4173");
  assert.notEqual(reopened.id, failed.id);
  assert.equal(reopened.state, "awaiting_view");
  assert.deepEqual(host.closedSessionIds, [failed.id]);
});
