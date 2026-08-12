import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSummary } from "../types";
import {
  bulkReleaseFailureMessage,
  ConversationLifecycleControl,
  repairConversationPanesAfterRemoval,
} from "./conversation-lifecycle-control";

const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

const conversation = (id: string, title = id) => ({ id, title }) as ConversationSummary;

test("conversation lifecycle repairs both pane selections after deletion", () => {
  assert.deepEqual(repairConversationPanesAfterRemoval({ primaryId: "a", secondaryId: "b" }, "a"), {
    primaryId: null,
    secondaryId: "b",
  });
  assert.deepEqual(repairConversationPanesAfterRemoval({ primaryId: "a", secondaryId: "a" }, "a"), {
    primaryId: null,
    secondaryId: null,
  });
});

test("conversation lifecycle deletes before refresh and reports refresh recovery", async () => {
  const calls: string[] = [];
  const control = new ConversationLifecycleControl(
    async () => {
      calls.push("refresh");
      throw new Error("projection unavailable");
    },
    (async () => {
      calls.push("delete");
      return response({});
    }) as typeof fetch,
  );
  const result = await control.deleteConversation("a", { primaryId: "a", secondaryId: "b" });
  assert.deepEqual(calls, ["delete", "refresh"]);
  assert.equal(result.refreshFailed, true);
  assert.deepEqual(result.selection, { primaryId: null, secondaryId: "b" });
});

test("conversation lifecycle settle-then-release stops when settle fails", async () => {
  const calls: string[] = [];
  const control = new ConversationLifecycleControl(
    async () => {
      calls.push("refresh");
    },
    (async (input) => {
      calls.push(String(input));
      return response({ error: "busy" }, false);
    }) as typeof fetch,
  );
  await assert.rejects(() => control.settleAndRelease("thread-1"), /busy/);
  assert.deepEqual(calls, ["/api/state/conversations/settle"]);
});

test("conversation lifecycle settle-then-release orders settle before release", async () => {
  const calls: string[] = [];
  const control = new ConversationLifecycleControl(
    async () => {
      calls.push("refresh");
    },
    (async (input, init) => {
      calls.push(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as { confirm?: boolean };
      if (String(input).includes("release-worktree")) assert.equal(body.confirm, true);
      return response({ released: true });
    }) as typeof fetch,
  );
  await control.settleAndRelease("thread-1");
  assert.deepEqual(calls, [
    "/api/state/conversations/settle",
    "refresh",
    "/api/state/conversations/release-worktree",
    "refresh",
  ]);
});

test("conversation lifecycle named pin hides the host route from callers", async () => {
  const calls: Array<{ route: string; body: unknown }> = [];
  const control = new ConversationLifecycleControl(async () => undefined, (async (input, init) => {
    calls.push({
      route: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return response({});
  }) as typeof fetch);
  await control.pin("thread-1", true);
  await control.snooze("thread-1", "2026-08-13T00:00:00.000Z");
  assert.deepEqual(calls, [
    { route: "/api/state/conversations/pin", body: { threadId: "thread-1", pinned: true } },
    {
      route: "/api/state/conversations/snooze",
      body: { threadId: "thread-1", snoozedUntil: "2026-08-13T00:00:00.000Z" },
    },
  ]);
});

test("conversation lifecycle preserves bounded partial bulk-release evidence", async () => {
  const targets = [conversation("a", "Alpha"), conversation("b", "Beta")];
  const replies = [
    response({ released: true, managedWorktreeCount: 2 }),
    response({ error: "busy" }, false),
  ];
  const counts: number[] = [];
  const control = new ConversationLifecycleControl(
    async () => undefined,
    (async () => replies.shift() ?? response({})) as typeof fetch,
  );
  await assert.rejects(
    control.releaseSettled(targets, (count) => counts.push(count)),
    /Released 1 of 2\. Beta: busy/,
  );
  assert.deepEqual(counts, [2]);
  assert.equal(
    bulkReleaseFailureMessage(0, [conversation("a")], ["A failed"]),
    "Released 0 of 1. A failed",
  );
});
