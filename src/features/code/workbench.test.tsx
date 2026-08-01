import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConversationSummary,
  DelegatedApprovalProjection,
  DelegatedConversationRelationship,
  DelegatedInputProjection,
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

test("delegated parent exposes a human-started child action", () => {
  const html = renderToStaticMarkup(createElement(DelegatedChildrenPanel, {
    parent,
    conversations: [parent, child],
    relationships: [relationship],
    outcomes: [],
    approvals: [],
    onOpen: () => undefined,
    onChanged: async () => undefined,
  }));
  assert.match(html, />Start child</);
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

test("delegated child candidates exclude every ancestor of the focused parent", () => {
  const ancestor = {
    ...parent,
    id: "ancestor",
    title: "Ancestor conversation",
  };
  const focusedParent = {
    ...parent,
    id: "focused-parent",
    title: "Focused parent",
  };
  const available = {
    ...child,
    id: "available",
    title: "Available conversation",
    status: "idle" as const,
  };
  const html = renderToStaticMarkup(createElement(DelegatedChildrenPanel, {
    parent: focusedParent,
    conversations: [ancestor, focusedParent, available],
    relationships: [{
      id: "ancestor-link",
      parentThreadId: ancestor.id,
      childThreadId: focusedParent.id,
      createdAt: "2026-07-30T10:00:00.000Z",
    }],
    outcomes: [],
    approvals: [],
    onOpen: () => undefined,
    onChanged: async () => undefined,
  }));

  assert.doesNotMatch(html, /Ancestor conversation/);
  assert.match(html, /Available conversation/);
});

test("delegated child input identifies its recipient, choices, and recommendation", () => {
  const input: DelegatedInputProjection = {
    parentThreadId: parent.id,
    childThreadId: child.id,
    request: {
      id: "request",
      threadId: child.id,
      question: "Choose the migration strategy",
      choices: [{
        id: "safe",
        label: "Safe migration",
        description: "Preserve compatibility",
      }],
      recommendation: "Safe migration",
      responseMode: "child_follow_up",
      state: "pending",
      createdAt: "2026-07-30T10:02:00.000Z",
      expiresAt: null,
      allowFreeForm: false,
    },
  };
  const html = renderToStaticMarkup(createElement(DelegatedChildrenPanel, {
    parent,
    conversations: [parent, { ...child, status: "awaiting_input" }],
    relationships: [relationship],
    outcomes: [],
    approvals: [],
    inputs: [input],
    onOpen: () => undefined,
    onChanged: async () => undefined,
  }));
  for (const expected of [
    "Input required for Child delivery: Choose the migration strategy",
    "Recommendation: Safe migration",
    "Answer for Child delivery",
    "Send to Child delivery",
  ]) {
    assert.match(html, new RegExp(expected));
  }
});
