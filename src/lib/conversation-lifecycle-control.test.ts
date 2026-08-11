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
