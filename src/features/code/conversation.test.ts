import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProviderEvent,
  filterSelectableWorktrees,
  formatHostLabel,
  formatWorktreeOptionLabel,
  providerProfileDisplayName,
  readyComposerPlaceholder,
} from "./conversation";
import type { ClaudeProfile, ProviderEvent, RepositoryMetadata } from "../../types";

const profiles = [
  { id: "work", name: "Work", provider: "claude-code" },
  { id: "personal", name: "Personal", provider: "claude-code" },
  { id: "shiki", name: "Shikigami", provider: "shikigami" },
] as ClaudeProfile[];

test("provider profile labels stay bound to the selected provider", () => {
  assert.equal(providerProfileDisplayName(profiles, "claude-code", "work"), "Work");
  assert.equal(providerProfileDisplayName(profiles, "claude-code", "shiki"), null);
  assert.equal(providerProfileDisplayName(profiles, "shikigami", "shiki"), "Shikigami");
  assert.equal(providerProfileDisplayName(profiles, "codex-cli", "work"), null);
});

test("ready composer copy distinguishes new work from an existing conversation", () => {
  assert.equal(
    readyComposerPlaceholder("Codex CLI", null),
    "What should we build, fix, or review?",
  );
  assert.equal(readyComposerPlaceholder("Codex CLI", "thread-1"), "Reply to Codex CLI…");
});

test("host copy keeps loopback details human-readable", () => {
  assert.equal(formatHostLabel("127.0.0.1"), "Local Aldunis host");
  assert.equal(formatHostLabel("localhost"), "Local Aldunis host");
  assert.equal(formatHostLabel("code.example.test"), "code.example.test");
});

test("provider browser observations replace the prior transient frame", () => {
  const first = {
    kind: "browser_observation",
    provider: "codex-cli",
    observationId: "frame-1",
    imageData: "data:image/jpeg;base64,AA==",
    mediaType: "image/jpeg",
  } satisfies ProviderEvent;
  const second = {
    ...first,
    observationId: "frame-2",
    imageData: "data:image/jpeg;base64,Ag==",
  } satisfies ProviderEvent;
  const next = appendProviderEvent(
    [{ kind: "assistant_text", text: "before" }, first, { kind: "assistant_text", text: "after" }],
    second,
  );
  assert.deepEqual(next, [
    { kind: "assistant_text", text: "before" },
    second,
    { kind: "assistant_text", text: "after" },
  ]);
});

test("worktree filtering groups branch search without hiding the selected worktree", () => {
  const worktrees = [
    {
      path: "/repo/.aldunis/wt/feature",
      head: "abc",
      branch: "feature/visible",
      state: "available",
      ownership: "aldunis",
      recovery: "available",
      originalPath: null,
    },
    {
      path: "/repo/user-worktree",
      head: "def",
      branch: "feature/other",
      state: "available",
      ownership: "user",
      recovery: "available",
      originalPath: null,
    },
  ] satisfies RepositoryMetadata["worktrees"];

  assert.deepEqual(
    filterSelectableWorktrees(worktrees, "user", worktrees[0]!.path).map((item) => item.path),
    [worktrees[0]!.path, worktrees[1]!.path],
  );
  assert.deepEqual(
    filterSelectableWorktrees(worktrees, "other", worktrees[0]!.path).map((item) => item.path),
    [worktrees[0]!.path, worktrees[1]!.path],
  );
});

test("detached worktree option labels stay distinguishable by path tail", () => {
  assert.equal(
    formatWorktreeOptionLabel({ branch: "feature/visible", path: "/repo/.aldunis/wt/feature" }),
    "feature/visible",
  );
  assert.equal(
    formatWorktreeOptionLabel({
      branch: null,
      path: "/Users/me/.codex/worktrees/04dcca78-ac4d-4cee-b630-e0dbcb5ab37f/aldunis-code",
    }),
    "Detached HEAD · 04dcca78-ac4d-4cee-b630-e0dbcb5ab37f/aldunis-code",
  );
  assert.equal(
    formatWorktreeOptionLabel({
      branch: null,
      path: "/Users/me/.codex/worktrees/a1fe3b83-23d3-49c3-b09e-6dd5545cb1f1/aldunis-code",
    }),
    "Detached HEAD · a1fe3b83-23d3-49c3-b09e-6dd5545cb1f1/aldunis-code",
  );
});

test("worktree filter matches detached path tails from the option label", () => {
  const worktrees = [
    {
      path: "/Users/me/.codex/worktrees/04dcca78-ac4d-4cee-b630-e0dbcb5ab37f/aldunis-code",
      head: "abc",
      branch: null,
      state: "available",
      ownership: "user",
      recovery: "available",
      originalPath: null,
    },
    {
      path: "/Users/me/.codex/worktrees/a1fe3b83-23d3-49c3-b09e-6dd5545cb1f1/aldunis-code",
      head: "def",
      branch: null,
      state: "available",
      ownership: "user",
      recovery: "available",
      originalPath: null,
    },
  ] satisfies RepositoryMetadata["worktrees"];

  assert.deepEqual(
    filterSelectableWorktrees(worktrees, "04dcca78", null).map((item) => item.path),
    [worktrees[0]!.path],
  );
});
