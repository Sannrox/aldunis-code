import assert from "node:assert/strict";
import test from "node:test";
import { appendAssistantTextChunk, joinAssistantTextChunks } from "./assistant-text";

test("joinAssistantTextChunks concatenates streaming tokens without separators", () => {
  assert.equal(
    joinAssistantTextChunks(["I'll", " check", " the", " project"]),
    "I'll check the project",
  );
  assert.equal(joinAssistantTextChunks([" sh", "ik", "ig", "ami"]), " shikigami");
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
  assert.equal(joinAssistantTextChunks(["steps", ".", "##", " Install"]), "steps.\n## Install");
  assert.equal(
    joinAssistantTextChunks(["vars.", "\n\n", "###", " Requirements"]),
    "vars.\n\n### Requirements",
  );
  // Mid-word tokens must not gain a break.
  assert.equal(joinAssistantTextChunks(["TO", "ML"]), "TOML");
});

test("joinAssistantTextChunks joins many chunks without changing their content", () => {
  const chunks = Array.from({ length: 2_000 }, (_, index) => `${index % 10}`.repeat(1_024));
  const joined = joinAssistantTextChunks(chunks);

  assert.equal(joined.length, 2_048_000);
  assert.equal(joined, chunks.join(""));
});

test("appendAssistantTextChunk matches batch reconstruction across stream boundaries", () => {
  const chunks = [
    "Result",
    ".",
    "##",
    " Verified",
    "\n\n",
    "```",
    "ts\n",
    "const value = '🙂';",
    "\n```",
    " ",
    "done",
  ];
  assert.equal(chunks.reduce(appendAssistantTextChunk, ""), joinAssistantTextChunks(chunks));
});

test("appendAssistantTextChunk retains long token streams without changing content", () => {
  const chunks = Array.from({ length: 20_000 }, (_, index) => String(index % 10));
  assert.equal(chunks.reduce(appendAssistantTextChunk, ""), chunks.join(""));
});
