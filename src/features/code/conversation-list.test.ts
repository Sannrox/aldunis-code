import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchFromWorktree,
  formatElapsed,
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
