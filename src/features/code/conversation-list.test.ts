import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationSummary } from "../../types";
import {
  branchFromWorktree,
  formatElapsed,
  groupSidebarConversations,
  isBlockingStatus,
  isUnread,
  providerLabel,
} from "./conversation-list";

test("unread is lastVisitedAt < wokeAt and never stored", () => {
  assert.equal(isUnread({ wokeAt: "2026-01-02T00:00:00.000Z", lastVisitedAt: null } as never), true);
  assert.equal(
    isUnread({
      wokeAt: "2026-01-02T00:00:00.000Z",
      lastVisitedAt: "2026-01-01T00:00:00.000Z",
    } as never),
    true,
  );
  assert.equal(
    isUnread({
      wokeAt: "2026-01-01T00:00:00.000Z",
      lastVisitedAt: "2026-01-02T00:00:00.000Z",
    } as never),
    false,
  );
  assert.equal(isUnread({ wokeAt: null, lastVisitedAt: null } as never), false);
});

test("blocking statuses are approval, input, and failed only", () => {
  assert.equal(isBlockingStatus("pending_approval"), true);
  assert.equal(isBlockingStatus("awaiting_input"), true);
  assert.equal(isBlockingStatus("failed"), true);
  assert.equal(isBlockingStatus("running"), false);
  assert.equal(isBlockingStatus("completed"), false);
  assert.equal(isBlockingStatus("idle"), false);
});

test("sidebar groups every blocking state ahead of active conversations", () => {
  const conversations = [
    { id: "idle-pinned", status: "idle", pinnedAt: "2026-01-05T00:00:00.000Z" },
    { id: "approval-pinned", status: "pending_approval", pinnedAt: "2026-01-04T00:00:00.000Z" },
    { id: "input", status: "awaiting_input", pinnedAt: null },
    { id: "failed", status: "failed", pinnedAt: null },
    { id: "running", status: "running", pinnedAt: null },
    { id: "completed-unread", status: "completed", wokeAt: "2026-01-03T00:00:00.000Z" },
  ] as ConversationSummary[];

  const grouped = groupSidebarConversations(conversations);

  assert.deepEqual(grouped.attention.map(({ id }) => id), [
    "approval-pinned",
    "input",
    "failed",
  ]);
  assert.deepEqual(grouped.active.map(({ id }) => id), [
    "idle-pinned",
    "running",
    "completed-unread",
  ]);
});

test("settled and archived conversations never require sidebar attention", () => {
  const blockingSettled = {
    id: "settled",
    status: "failed",
    settledAt: "2026-01-03T00:00:00.000Z",
  } as ConversationSummary;
  const blockingArchived = {
    id: "archived",
    status: "pending_approval",
    archivedAt: "2026-01-04T00:00:00.000Z",
  } as ConversationSummary;

  const activeView = groupSidebarConversations([blockingArchived, blockingSettled]);
  assert.deepEqual(activeView.attention, []);
  assert.deepEqual(activeView.active.map(({ id }) => id), ["archived"]);
  assert.deepEqual(activeView.settled.map(({ id }) => id), ["settled"]);

  const archivedView = groupSidebarConversations([blockingArchived], true);
  assert.deepEqual(archivedView.attention, []);
  assert.deepEqual(archivedView.active.map(({ id }) => id), ["archived"]);
});

test("elapsed formatting floors to now / m / h / d", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(formatElapsed("2026-01-01T11:59:30.000Z", now), "now");
  assert.equal(formatElapsed("2026-01-01T11:40:00.000Z", now), "20m");
  assert.equal(formatElapsed("2026-01-01T08:00:00.000Z", now), "4h");
  assert.equal(formatElapsed("2025-12-28T12:00:00.000Z", now), "4d");
});

test("provider and branch labels are display helpers only", () => {
  assert.equal(providerLabel("claude-code"), "Claude");
  assert.equal(providerLabel("codex-cli"), "Codex");
  assert.equal(providerLabel("shikigami"), "Shikigami");
  assert.equal(providerLabel("adapter:kiro@1.0.0"), "Kiro CLI");
  assert.equal(providerLabel("adapter:dev.xai.grok-build@1.0.0"), "Grok Build");
  assert.equal(providerLabel("adapter:dev.kiro.cli@1.0.0"), "Kiro CLI");
  assert.equal(branchFromWorktree("/tmp/repo/.aldunis/feature-x"), "feature-x");
});
