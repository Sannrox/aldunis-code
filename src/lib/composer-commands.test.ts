import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderCapabilities } from "../types";
import {
  buildComposerCommandItems,
  buildComposerPathItems,
  buildComposerSkillItems,
  filterComposerCommandItems,
  getComposerTrigger,
  groupComposerCommandItems,
  replaceComposerTrigger,
} from "./composer-commands";

const claudeCapabilities: ProviderCapabilities = {
  provider: "claude-code",
  commands: [
    { name: "/help", description: "Show help" },
    { name: "/compact", description: "Compact context" },
  ],
  attachments: {
    maxCount: 8,
    textMaxBytes: 64 * 1024,
    imageMaxBytes: 2 * 1024 * 1024,
    imageTypes: ["image/png"],
  },
  workspace: {
    shared: true,
    aldunisManaged: true,
    providerNative: false,
    providerNativeDetail: "Not available",
  },
};

test("composer trigger parsing separates slash commands, skills, and files", () => {
  assert.deepEqual(getComposerTrigger("/con"), { mode: "slash-command", query: "con" });
  assert.deepEqual(getComposerTrigger("please use $review"), { mode: "skill", query: "review" });
  assert.deepEqual(getComposerTrigger("inspect @src/"), { mode: "path", query: "src/" });
  assert.equal(getComposerTrigger("plain prompt"), null);
});

test("composer trigger replacement preserves text and leading whitespace", () => {
  assert.equal(replaceComposerTrigger("please use /con", "/context "), "please use /context ");
  assert.equal(replaceComposerTrigger("use $review", "$review "), "use $review ");
  assert.equal(replaceComposerTrigger("@src/app.ts", ""), "");
});

test("provider commands are scoped to the selected provider and grouped separately", () => {
  const claude = buildComposerCommandItems({
    provider: "claude-code",
    capabilities: claudeCapabilities,
    query: "",
  });
  const codex = buildComposerCommandItems({
    provider: "codex-cli",
    capabilities: claudeCapabilities,
    query: "",
  });

  assert.deepEqual(claude.map((item) => item.label), ["/context", "/help", "/compact"]);
  assert.deepEqual(codex.map((item) => item.label), ["/context"]);
  assert.deepEqual(groupComposerCommandItems(claude, "slash-command").map((group) => [
    group.label,
    group.items.map((item) => item.label),
  ]), [
    ["Built-in", ["/context"]],
    ["Provider", ["/help", "/compact"]],
  ]);
});

test("command and skill search ranks matching names before descriptions", () => {
  const commands = buildComposerCommandItems({
    provider: "claude-code",
    capabilities: claudeCapabilities,
    query: "comp",
  });
  const skills = buildComposerSkillItems("codex-cli", [
    { name: "review", description: "Review the current changes" },
    { name: "docs", description: "Run a review helper" },
  ], "review");

  assert.deepEqual(commands.map((item) => item.label), ["/compact"]);
  assert.deepEqual(skills.map((item) => item.label), ["$review", "$docs"]);
  assert.deepEqual(buildComposerPathItems(["src/app.ts"])[0], {
    id: "path:src/app.ts",
    type: "path",
    path: "src/app.ts",
    label: "src/app.ts",
    description: "Local repository file",
  });
  assert.equal(filterComposerCommandItems(skills, "$review")[0]?.label, "$review");
});
