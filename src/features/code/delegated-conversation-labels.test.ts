import assert from "node:assert/strict";
import test from "node:test";
import { delegatedConversationLabels } from "./delegated-conversation-labels";

test("delegated conversation choices include project and provider context", () => {
  const labels = delegatedConversationLabels([{
    id: "thread-1",
    title: "Repeated prompt",
    projectName: "aldunis-code",
    provider: "codex-cli",
  }]);
  assert.equal(labels.get("thread-1"), "Repeated prompt · aldunis-code · Codex");
});

test("delegated conversation choices add stable suffixes to exact collisions", () => {
  const labels = delegatedConversationLabels([
    {
      id: "thread-1",
      title: "Repeated prompt",
      projectName: "aldunis-code",
      provider: "codex-cli",
    },
    {
      id: "thread-2",
      title: "Repeated prompt",
      projectName: "aldunis-code",
      provider: "codex-cli",
    },
  ]);
  assert.deepEqual([...labels], [
    ["thread-1", "Repeated prompt · aldunis-code · Codex · Task thread-1"],
    ["thread-2", "Repeated prompt · aldunis-code · Codex · Task thread-2"],
  ]);
});
