import assert from "node:assert/strict";
import test from "node:test";
import { readyComposerPlaceholder } from "./conversation";

test("ready composer copy distinguishes new work from an existing conversation", () => {
  assert.equal(
    readyComposerPlaceholder("Codex CLI", null),
    "Describe what you want to work on…",
  );
  assert.equal(
    readyComposerPlaceholder("Codex CLI", "thread-1"),
    "Reply to Codex CLI…",
  );
});
