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

test("synchronization accepts only the newest request and owns event refresh", async () => {
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
  requests[1]?.(projection("fresh"));
  await Promise.resolve();
  requests[0]?.(projection("stale"));
  await Promise.resolve();
  assert.deepEqual(
    accepted.map((item) => item.conversations[0]?.id),
    ["fresh"],
  );

  listeners.get("thread_status")?.({ data: "not-json" });
  assert.equal(requests.length, 2);
  listeners.get("thread_status")?.({ data: "{}" });
  assert.equal(requests.length, 2);
  listeners.get("thread_status")?.({
    data: JSON.stringify({ threadId: "thread", status: "running", at: "2026-01-01" }),
  });
  assert.equal(requests.length, 3);
  requests[2]?.(projection("status"));
  await Promise.resolve();
  assert.equal(accepted.at(-1)?.conversations[0]?.id, "status");

  synchronization.dispose();
  assert.equal(closed, true);
  listeners.get("open")?.({ data: "" });
  assert.equal(requests.length, 3);
  requests[3]?.(projection("disposed"));
  await Promise.resolve();
  assert.equal(accepted.at(-1)?.conversations[0]?.id, "status");
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
