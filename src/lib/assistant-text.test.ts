import assert from "node:assert/strict";
import test from "node:test";
import { joinAssistantTextChunks } from "./assistant-text";

test("joinAssistantTextChunks concatenates streaming tokens without separators", () => {
  assert.equal(
    joinAssistantTextChunks(["I'll", " check", " the", " project"]),
    "I'll check the project",
  );
  assert.equal(
    joinAssistantTextChunks([" sh", "ik", "ig", "ami"]),
    " shikigami",
  );
  assert.equal(
    joinAssistantTextChunks(["shikigami", "\n\n", "There", " is"]),
    "shikigami\n\nThere is",
  );
});

test("joinAssistantTextChunks preserves whitespace-only frames", () => {
  assert.equal(joinAssistantTextChunks(["a", "\n\n", "b"]), "a\n\nb");
  assert.equal(joinAssistantTextChunks(["a", " ", "b"]), "a b");
});

test("joinAssistantTextChunks inserts a break before bare markdown blocks", () => {
  assert.equal(
    joinAssistantTextChunks(["steps", ".", "##", " Install"]),
    "steps.\n## Install",
  );
  assert.equal(
    joinAssistantTextChunks(["vars.", "\n\n", "###", " Requirements"]),
    "vars.\n\n### Requirements",
  );
  // Mid-word tokens must not gain a break.
  assert.equal(joinAssistantTextChunks(["TO", "ML"]), "TOML");
});
