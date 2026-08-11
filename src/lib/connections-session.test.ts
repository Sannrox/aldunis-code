import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectionsSessionModule,
  type ConnectionsSessionAdapters,
  type RemoteEnvironmentSummary,
} from "./connections-session";

function environment(overrides: Partial<RemoteEnvironmentSummary> = {}): RemoteEnvironmentSummary {
  return {
    id: "environment-1",
    label: "Build server",
    transport: "ssh",
    endpoint: null,
    sshTarget: "build.example",
    remotePort: 4374,
    remoteCommand: "aldunis-code",
    preferredLocalPort: null,
    paired: true,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    connected: false,
    localUrl: null,
    ...overrides,
  };
}

function adapters(events: string[]): ConnectionsSessionAdapters {
  return {
    localDesktop: true,
    remoteDesktop: false,
    canUseLocal: true,
    hostRequest: async (route) => {
      events.push(route);
      return { remoteEnabled: false, descriptor: null, sessions: [] } as never;
    },
    desktop: {
      list: async () => {
        events.push("list");
        return [];
      },
      save: async () => {
        events.push("save");
        return { summary: environment(), pairingUrl: "https://pair" };
      },
      connect: async (_id, pairingUrl, forcePair) => {
        events.push(`connect:${pairingUrl ?? "none"}:${Boolean(forcePair)}`);
      },
      disconnect: async () => events.push("disconnect"),
      remove: async () => events.push("remove"),
      useLocal: async () => events.push("local"),
    },
    copy: async () => {
      events.push("copy");
    },
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("local open loads environments before host administration status", async () => {
  const events: string[] = [];
  const session = new ConnectionsSessionModule(adapters(events));
  session.open();
  await settle();
  assert.deepEqual(events, ["list", "/api/remote/admin/status"]);
  assert.equal(session.getSnapshot().loading, false);
});

test("a connected desktop environment suppresses local host administration", async () => {
  const events: string[] = [];
  const config = adapters(events);
  config.desktop!.list = async () => {
    events.push("list");
    return [environment({ connected: true })];
  };
  const session = new ConnectionsSessionModule(config);
  session.open();
  await settle();
  assert.deepEqual(events, ["list"]);
  assert.equal(session.getSnapshot().status, null);
});

test("save and connect owns the transaction and clears the draft only after connection", async () => {
  const events: string[] = [];
  const session = new ConnectionsSessionModule(adapters(events));
  session.open();
  await settle();
  events.length = 0;
  session.showNewEnvironment();
  session.updateDraft({ label: "Build", sshTarget: "build.example" });
  await session.saveAndConnect();
  assert.deepEqual(events, ["save", "connect:https://pair:false"]);
  assert.equal(session.getSnapshot().formOpen, false);
  assert.equal(session.getSnapshot().draft.label, "");
});

test("failed connect refreshes environment truth and keeps a bounded error", async () => {
  const events: string[] = [];
  const config = adapters(events);
  config.desktop!.connect = async () => {
    events.push("connect");
    throw new Error("Pairing expired.");
  };
  const session = new ConnectionsSessionModule(config);
  session.open();
  await settle();
  events.length = 0;
  await session.connect(environment());
  assert.deepEqual(events, ["connect", "list"]);
  assert.equal(session.getSnapshot().error, "Pairing expired.");
  assert.equal(session.getSnapshot().environmentBusy, null);
});

test("a failed reopen clears stale host administration status", async () => {
  const events: string[] = [];
  const config = adapters(events);
  let available = true;
  config.hostRequest = async () => {
    if (!available) throw new Error("Host unavailable.");
    return { remoteEnabled: true, descriptor: null, sessions: [] } as never;
  };
  const session = new ConnectionsSessionModule(config);
  session.open();
  await settle();
  assert.equal(session.getSnapshot().status?.remoteEnabled, true);

  session.close();
  available = false;
  session.open();
  await settle();
  assert.equal(session.getSnapshot().status, null);
  assert.equal(session.getSnapshot().error, "Host unavailable.");
});

test("reopen clears operation flags invalidated by close", async () => {
  const events: string[] = [];
  const config = adapters(events);
  config.desktop!.connect = () => new Promise(() => undefined);
  const session = new ConnectionsSessionModule(config);
  session.open();
  await settle();
  void session.connect(environment());
  assert.equal(session.getSnapshot().environmentBusy, "environment-1");

  session.close();
  session.open();
  assert.equal(session.getSnapshot().environmentBusy, null);
  assert.equal(session.getSnapshot().busy, false);
});
