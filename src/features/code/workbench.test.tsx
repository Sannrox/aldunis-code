import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConversationSummary,
  DelegatedApprovalProjection,
  DelegatedConversationRelationship,
} from "../../types";
import { DelegatedChildrenPanel } from "./workbench";

const parent: ConversationSummary = {
  id: "parent",
  projectId: "project",
  title: "Parent",
  worktree: "/repo/parent",
  provider: "codex-cli",
  updatedAt: "2026-07-30T10:00:00.000Z",
};
const child: ConversationSummary = {
  id: "child",
  projectId: "project",
  projectName: "Example",
  title: "Child delivery",
  worktree: "/repo/child",
  provider: "codex-cli",
  updatedAt: "2026-07-30T10:01:00.000Z",
  status: "pending_approval",
};
const relationship: DelegatedConversationRelationship = {
  id: "relationship",
  parentThreadId: parent.id,
  childThreadId: child.id,
  createdAt: "2026-07-30T10:00:00.000Z",
};
const delegatedApproval: DelegatedApprovalProjection = {
  parentThreadId: parent.id,
  childThreadId: child.id,
  approval: {
    id: "approval",
    runId: "run",
    conversationId: child.id,
    repository: "/repo",
    worktree: child.worktree,
    provider: "codex-cli",
    toolCallId: "tool",
    toolName: "Edit",
    scope: {
      summary: "Edit a file",
      target: "path: src/example.ts",
      details: ["path: src/example.ts"],
    },
    state: "pending",
    expiresAt: "2026-07-30T10:05:00.000Z",
  },
};

test("delegated child approval card exposes its complete scoped context", () => {
  const html = renderToStaticMarkup(createElement(DelegatedChildrenPanel, {
    parent,
    conversations: [parent, child],
    relationships: [relationship],
    outcomes: [],
    approvals: [delegatedApproval],
    onOpen: () => undefined,
    onChanged: async () => undefined,
  }));
  for (const expected of [
    "Approval required for Child delivery: Edit a file",
    "Conversation",
    "Child delivery",
    "Project",
    "Example",
    "Worktree",
    "/repo/child",
    "Provider",
    "Codex",
    "Tool",
    "Edit",
    "Target",
    "path: src/example.ts",
    "Expires",
    "Deny",
    "Allow once",
  ]) {
    assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("a projected approval overrides a running child status in parent attention", () => {
  const html = renderToStaticMarkup(createElement(DelegatedChildrenPanel, {
    parent,
    conversations: [parent, { ...child, status: "running" }],
    relationships: [relationship],
    outcomes: [],
    approvals: [delegatedApproval],
    onOpen: () => undefined,
    onChanged: async () => undefined,
  }));
  assert.match(html, />0 working</);
  assert.match(html, />1 approval</);
  assert.match(html, />pending approval</);
  assert.doesNotMatch(html, />1 working</);
});
