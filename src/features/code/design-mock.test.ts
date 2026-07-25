import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIGN_MOCK_MANAGED_WORKTREE_COUNT,
  DESIGN_MOCK_PRIMARY_ID,
  DESIGN_MOCK_REPOSITORY,
  DESIGN_MOCK_WORKTREE_LIMIT,
  designMockConversations,
} from "./design-mock";

test("design mock fixtures cover active + settled sample list", () => {
  const rows = designMockConversations();
  assert.ok(rows.length >= 9);
  assert.ok(rows.some((row) => row.id === DESIGN_MOCK_PRIMARY_ID));
  assert.equal(rows.filter((row) => row.settledAt).length, 3);
  assert.equal(rows.filter((row) => !row.settledAt).length, 6);
  assert.equal(DESIGN_MOCK_REPOSITORY.projectId, "design-mock-project");
  assert.equal(DESIGN_MOCK_WORKTREE_LIMIT, 8);
  assert.equal(DESIGN_MOCK_MANAGED_WORKTREE_COUNT, 6);
});

test("design mock thread ids are namespaced so server paths can skip them", () => {
  for (const row of designMockConversations()) {
    assert.ok(row.id.startsWith("mock-"), row.id);
    assert.equal(row.projectId, DESIGN_MOCK_REPOSITORY.projectId);
  }
});

test("local settle patch keeps list membership and marks settledAt", () => {
  const rows = designMockConversations();
  const target = rows.find((row) => row.id === "mock-kiro");
  assert.ok(target);
  assert.equal(target.settledAt, undefined);
  const settledAt = "2026-07-25T12:00:00.000Z";
  const next = rows.map((row) => (
    row.id === target.id ? { ...row, settledAt } : row
  ));
  assert.equal(next.find((row) => row.id === target.id)?.settledAt, settledAt);
  assert.equal(next.length, rows.length);
  assert.equal(next.filter((row) => !row.settledAt).length, 5);
  assert.equal(next.filter((row) => row.settledAt).length, 4);
});
