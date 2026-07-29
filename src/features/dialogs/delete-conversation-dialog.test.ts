import assert from "node:assert/strict";
import test from "node:test";
import { affectedDeletionRecords } from "./delete-conversation-dialog";

test("deletion preview keeps only affected records", () => {
  assert.deepEqual(
    affectedDeletionRecords({
      affectedRecords: {
        conversations: 1,
        messages: 4,
        approvals: 0,
      },
    }),
    [["conversations", 1], ["messages", 4]],
  );
});

test("deletion preview handles an absent record summary", () => {
  assert.deepEqual(affectedDeletionRecords({}), []);
});
