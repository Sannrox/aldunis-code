import assert from "node:assert/strict";
import test from "node:test";
import { normalizedConversationTitle } from "./rename-conversation-dialog";

test("conversation rename trims a meaningful title", () => {
  assert.equal(normalizedConversationTitle("  Updated title  "), "Updated title");
});

test("conversation rename rejects empty and whitespace-only titles", () => {
  assert.equal(normalizedConversationTitle(""), null);
  assert.equal(normalizedConversationTitle("   \n\t"), null);
});
