import assert from "node:assert/strict";
import test from "node:test";
import {
  delegatedConversationAncestorIds,
  wouldCreateDelegatedConversationCycle,
} from "./delegated-conversation-graph";

const relationships = [
  { parentThreadId: "a", childThreadId: "b" },
  { parentThreadId: "b", childThreadId: "c" },
  { parentThreadId: "a", childThreadId: "d" },
];

test("delegated ancestor traversal is bounded and cycle-aware", () => {
  assert.deepEqual([...delegatedConversationAncestorIds(relationships, "c")].sort(), ["a", "b"]);
  assert.equal(wouldCreateDelegatedConversationCycle(relationships, "b", "a"), true);
  assert.equal(wouldCreateDelegatedConversationCycle(relationships, "c", "a"), true);
  assert.equal(wouldCreateDelegatedConversationCycle(relationships, "a", "c"), false);
  assert.equal(wouldCreateDelegatedConversationCycle(relationships, "a", "a"), true);
});
