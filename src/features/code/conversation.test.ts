import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProviderEvent,
  assistantTextFromEvents,
  composerAcceptsInput,
  filterSelectableWorktrees,
  formatHostLabel,
  formatWorktreeOptionLabel,
  preserveInputResolution,
  providerProfileDisplayName,
  readyComposerPlaceholder,
  restoredTurnTerminalEvent,
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

test("composer rejects input when the conversation worktree is missing", () => {
  const ready = {
    hasRunnableWorktree: true,
    conversationWorktreeMissing: false,
    providerReady: true,
    runActive: false,
    historyRestored: true,
  };
  assert.equal(composerAcceptsInput(ready), true);
  assert.equal(composerAcceptsInput({ ...ready, conversationWorktreeMissing: true }), false);
  assert.equal(composerAcceptsInput({ ...ready, hasRunnableWorktree: false }), false);
  assert.equal(composerAcceptsInput({ ...ready, providerReady: false }), false);
  assert.equal(composerAcceptsInput({ ...ready, runActive: true }), false);
  assert.equal(composerAcceptsInput({ ...ready, historyRestored: false }), false);
});

test("ready composer copy distinguishes new work from an existing conversation", () => {
  assert.equal(
    readyComposerPlaceholder("Codex CLI", null),
    "What should we build, fix, or review?",
  );
  assert.equal(readyComposerPlaceholder("Codex CLI", "thread-1"), "Reply to Codex CLI…");
});

test("assistantTextFromEvents preserves text block boundaries around tools", () => {
  const events = [
    { kind: "assistant_text", text: "First paragraph." },
    { kind: "tool_started", toolCallId: "t1", name: "Read" },
    { kind: "tool_finished", toolCallId: "t1", failed: false },
    { kind: "assistant_text", text: "Second paragraph." },
  ] as ProviderEvent[];
  assert.equal(assistantTextFromEvents(events), "First paragraph.\n\nSecond paragraph.");
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

test("input resolutions replace requests with a sanitized durable marker", () => {
  const request = {
    kind: "input_requested",
    id: "input-1",
    threadId: "thread-1",
    question: "Sensitive question",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    state: "pending",
    createdAt: "2026-08-08T10:00:00.000Z",
    expiresAt: null,
    allowFreeForm: true,
  } satisfies ProviderEvent;
  const resolution = {
    kind: "input_resolved",
    id: "input-1",
    state: "answered",
  } satisfies ProviderEvent;

  assert.deepEqual(preserveInputResolution([request], resolution), [resolution]);
  assert.deepEqual(preserveInputResolution([resolution], resolution), [resolution]);
  assert.deepEqual(preserveInputResolution([], resolution), [resolution]);
});

test("restored terminal state becomes graph-safe provider evidence", () => {
  assert.deepEqual(restoredTurnTerminalEvent("completed", "session-1"), {
    kind: "turn_completed",
    sessionId: "session-1",
    costUsd: null,
  });
  assert.deepEqual(restoredTurnTerminalEvent("cancelled", null), { kind: "cancelled" });
  assert.deepEqual(restoredTurnTerminalEvent("interrupted", null), { kind: "cancelled" });
  assert.deepEqual(restoredTurnTerminalEvent("failed", null), {
    kind: "failed",
    message: "The run ended without a detailed error.",
  });
  assert.equal(restoredTurnTerminalEvent("running", null), null);
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
