import assert from "node:assert/strict";
import test from "node:test";
import { ConversationAutomationSessionModule, type AutomationItem } from "./automation-session";

const item = (overrides: Partial<AutomationItem> = {}): AutomationItem => ({
  id: "automation-1",
  name: "Recurring check",
  threadId: "thread-1",
  prompt: "Check status",
  mode: "ask",
  enabled: true,
  schedule: { kind: "interval", seconds: 3_600 },
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastFire: null,
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("automation session opens with the first conversation and loads through its interface", async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const session = new ConversationAutomationSessionModule({
    request: async (path, body) => {
      requests.push({ path, body });
      return { automations: [item()] };
    },
    randomUUID: () => "request-1",
  });

  session.open(["thread-1", "thread-2"]);
  await flush();

  assert.equal(session.getSnapshot().draft.threadId, "thread-1");
  assert.deepEqual(session.getSnapshot().items, [item()]);
  assert.deepEqual(requests, [{ path: "/api/automations/list", body: undefined }]);
});

test("create constructs the schedule, clears the prompt, and reloads", async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const session = new ConversationAutomationSessionModule({
    request: async (path, body) => {
      requests.push({ path, body });
      return path.endsWith("/list") ? { automations: [] } : {};
    },
    randomUUID: () => "request-1",
  });
  session.open(["thread-1"]);
  await flush();
  session.updateDraft({ name: "  Check  ", prompt: "Review", intervalMinutes: 15 });

  await session.execute({ kind: "create" });

  assert.deepEqual(requests.slice(1), [
    {
      path: "/api/automations/create",
      body: {
        name: "  Check  ",
        threadId: "thread-1",
        prompt: "Review",
        mode: "ask",
        schedule: { kind: "interval", seconds: 900 },
        enabled: true,
      },
    },
    { path: "/api/automations/list", body: undefined },
  ]);
  assert.equal(session.getSnapshot().draft.prompt, "");
  assert.equal(session.getSnapshot().busy, false);
});

test("failed commands preserve items, expose the server error, and recover busy state", async () => {
  const session = new ConversationAutomationSessionModule({
    request: async (path) => {
      if (path.endsWith("/list")) return { automations: [item()] };
      throw new Error("Update denied.");
    },
    randomUUID: () => "request-1",
  });
  session.open(["thread-1"]);
  await flush();

  await session.execute({ kind: "set_enabled", id: "automation-1", enabled: false });

  assert.deepEqual(session.getSnapshot().items, [item()]);
  assert.equal(session.getSnapshot().error, "Update denied.");
  assert.equal(session.getSnapshot().busy, false);
});

test("explicit unknown-fire retry receives a fresh identity and retry binding", async () => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let uuid = 0;
  const session = new ConversationAutomationSessionModule({
    request: async (path, body) => {
      requests.push({ path, body });
      return { automations: [] };
    },
    randomUUID: () => `request-${++uuid}`,
  });
  session.open(["thread-1"]);
  await flush();

  await session.execute({ kind: "run", id: "automation-1", retryOf: "fire-unknown" });

  assert.deepEqual(requests[1], {
    path: "/api/automations/run-now",
    body: {
      id: "automation-1",
      idempotencyKey: "request-1",
      retryOf: "fire-unknown",
    },
  });
});

test("closing suppresses a stale load completion", async () => {
  let resolveLoad: ((value: unknown) => void) | undefined;
  const session = new ConversationAutomationSessionModule({
    request: () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    randomUUID: () => "request-1",
  });
  session.open(["thread-1"]);
  session.close();
  resolveLoad?.({ automations: [item()] });
  await flush();

  assert.deepEqual(session.getSnapshot().items, []);
  assert.equal(session.getSnapshot().busy, false);
});
