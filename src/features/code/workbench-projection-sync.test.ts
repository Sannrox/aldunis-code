import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSummary } from "../../types";
import {
  createWorkbenchProjectionSynchronization,
  reconcileWorkbenchConversations,
  workbenchProjectionSnapshot,
  type WorkbenchProjectionSnapshot,
  type WorkbenchStateProjection,
} from "./workbench-projection-sync";

function projection(id: string, lastVisitedAt?: string): WorkbenchStateProjection {
  return {
    threads: [
      {
        id,
        projectId: "project",
        title: id,
        provider: "codex-cli",
        worktree: "/repo",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastVisitedAt,
      },
    ],
  };
}

test("projection normalization reconciles optimistic visits and recovery fields", () => {
  const current = projection("thread", "2026-01-03T00:00:00.000Z").threads as ConversationSummary[];
  const snapshot = workbenchProjectionSnapshot({
    ...projection("thread", "2026-01-02T00:00:00.000Z"),
    conversationDeletions: [
      { threadId: "pending", status: "state_deleted" },
      { threadId: "done", status: "completed" },
    ],
    managedWorktreeCount: 2,
    managedWorktreePaths: ["/one", 7 as unknown as string, "/two"],
  });
  const reconciled = reconcileWorkbenchConversations(snapshot.conversations, current);
  assert.equal(reconciled[0]?.lastVisitedAt, "2026-01-03T00:00:00.000Z");
  assert.deepEqual(snapshot.incompleteDeletionIds, ["pending"]);
  assert.equal(snapshot.managedWorktreeCount, 2);
  assert.deepEqual(snapshot.managedWorktreePaths, ["/one", "/two"]);
});

test("synchronization serializes startup and coalesces event bursts", async () => {
  const requests: Array<(value: WorkbenchStateProjection) => void> = [];
  const listeners = new Map<string, (event: { data: string }) => void>();
  const accepted: WorkbenchProjectionSnapshot[] = [];
  let closed = false;
  const synchronization = createWorkbenchProjectionSynchronization({
    load: () => new Promise((resolve) => requests.push(resolve)),
    createEventSource: () => ({
      addEventListener: (type, listener) =>
        listeners.set(type, listener as (event: { data: string }) => void),
      close: () => {
        closed = true;
      },
    }),
    accept: (snapshot) => accepted.push(snapshot),
  });

  synchronization.start();
  listeners.get("open")?.({ data: "" });
  listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "running", at: "2026-01-01" }),
  });
  listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "completed", at: "2026-01-02" }),
  });
  assert.equal(requests.length, 1);
  requests[0]?.(projection("initial"));
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[1]?.(projection("fresh"));
  await Promise.resolve();
  assert.deepEqual(
    accepted.map((item) => item.conversations[0]?.id),
    ["initial", "fresh"],
  );

  listeners.get("thread_status")?.({ data: "not-json" });
  assert.equal(requests.length, 2);
  listeners.get("thread_status")?.({ data: "{}" });
  assert.equal(requests.length, 2);
  listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "running", at: "2026-01-01" }),
  });
  assert.equal(requests.length, 3);
  listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "completed", at: "2026-01-02" }),
  });
  assert.equal(requests.length, 3);
  requests[2]?.(projection("status"));
  await Promise.resolve();
  assert.equal(accepted.at(-1)?.conversations[0]?.id, "status");
  assert.equal(requests.length, 4);
  requests[3]?.(projection("follow-up"));
  await Promise.resolve();
  assert.equal(accepted.at(-1)?.conversations[0]?.id, "follow-up");

  synchronization.dispose();
  assert.equal(closed, true);
  listeners.get("open")?.({ data: "" });
  assert.equal(requests.length, 4);
});

test("synchronization releases hidden streams and reconnects fresh when visible", async () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let visibilityListener: (() => void) | undefined;
  const requests: boolean[] = [];
  const streams: Array<{
    listeners: Map<string, (event: { data: string }) => void>;
    closed: boolean;
  }> = [];
  const synchronization = createWorkbenchProjectionSynchronization({
    load: async (fresh) => {
      requests.push(fresh);
      return projection(`request-${requests.length}`);
    },
    createEventSource: () => {
      const stream = {
        listeners: new Map<string, (event: { data: string }) => void>(),
        closed: false,
      };
      streams.push(stream);
      return {
        addEventListener: (type, listener) =>
          stream.listeners.set(type, listener as (event: { data: string }) => void),
        close: () => {
          stream.closed = true;
        },
      };
    },
    accept: () => undefined,
    visibility: {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (_type, listener) => {
        visibilityListener = listener;
      },
      removeEventListener: (_type, listener) => {
        if (visibilityListener === listener) visibilityListener = undefined;
      },
    },
  });

  synchronization.start();
  await Promise.resolve();
  assert.deepEqual(requests, [false]);
  assert.equal(streams.length, 1);

  visibilityState = "hidden";
  visibilityListener?.();
  assert.equal(streams[0]?.closed, true);
  streams[0]?.listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "running", at: "2026-01-01" }),
  });
  await Promise.resolve();
  assert.deepEqual(requests, [false]);

  await synchronization.refresh();
  assert.deepEqual(requests, [false, true]);
  assert.equal(streams.length, 1);

  visibilityState = "visible";
  visibilityListener?.();
  assert.equal(streams.length, 2);
  streams[1]?.listeners.get("open")?.({ data: "" });
  await Promise.resolve();
  assert.deepEqual(requests, [false, true, true]);

  synchronization.dispose();
  assert.equal(streams[1]?.closed, true);
  assert.equal(visibilityListener, undefined);
});

test("hidden startup loads the cached projection without opening a stream", async () => {
  let visibilityListener: (() => void) | undefined;
  const requests: boolean[] = [];
  let streams = 0;
  const synchronization = createWorkbenchProjectionSynchronization({
    load: async (fresh) => {
      requests.push(fresh);
      return projection("hidden");
    },
    createEventSource: () => {
      streams += 1;
      return { addEventListener: () => undefined, close: () => undefined };
    },
    accept: () => undefined,
    visibility: {
      visibilityState: "hidden",
      addEventListener: (_type, listener) => {
        visibilityListener = listener;
      },
      removeEventListener: (_type, listener) => {
        if (visibilityListener === listener) visibilityListener = undefined;
      },
    },
  });

  synchronization.start();
  await Promise.resolve();
  assert.deepEqual(requests, [false]);
  assert.equal(streams, 0);
  synchronization.dispose();
  assert.equal(visibilityListener, undefined);
});

test("explicit refresh waits behind background work and owns its failure", async () => {
  const requests: Array<{
    resolve(value: WorkbenchStateProjection): void;
    reject(error: Error): void;
  }> = [];
  const synchronization = createWorkbenchProjectionSynchronization({
    load: () =>
      new Promise((resolve, reject) => {
        requests.push({ resolve, reject });
      }),
    createEventSource: () => ({
      addEventListener: () => undefined,
      close: () => undefined,
    }),
    accept: () => undefined,
  });

  synchronization.start();
  const refresh = synchronization.refresh();
  assert.equal(requests.length, 1);
  requests[0]?.resolve(projection("initial"));
  await Promise.resolve();
  assert.equal(requests.length, 2);
  requests[1]?.reject(new Error("projection unavailable"));
  await assert.rejects(refresh, /projection unavailable/);
  synchronization.dispose();
});

test("disposal clears queued refreshes and suppresses late publication", async () => {
  const requests: Array<(value: WorkbenchStateProjection) => void> = [];
  const accepted: WorkbenchProjectionSnapshot[] = [];
  const synchronization = createWorkbenchProjectionSynchronization({
    load: () => new Promise((resolve) => requests.push(resolve)),
    createEventSource: () => ({
      addEventListener: () => undefined,
      close: () => undefined,
    }),
    accept: (snapshot) => accepted.push(snapshot),
  });

  synchronization.start();
  const refresh = synchronization.refresh();
  synchronization.dispose();
  await refresh;
  requests[0]?.(projection("disposed"));
  await Promise.resolve();
  assert.deepEqual(accepted, []);
  assert.equal(requests.length, 1);
});

test("imperative refresh preserves failures while background start soft-fails", async () => {
  let calls = 0;
  const synchronization = createWorkbenchProjectionSynchronization({
    load: async () => {
      calls += 1;
      throw new Error("projection unavailable");
    },
    createEventSource: () => ({
      addEventListener: () => undefined,
      close: () => undefined,
    }),
    accept: () => assert.fail("failed loads cannot publish a snapshot"),
  });
  synchronization.start();
  await Promise.resolve();
  await assert.rejects(synchronization.refresh(), /projection unavailable/);
  assert.equal(calls, 2);
  synchronization.dispose();
});
