import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationSummary,
  DelegatedApprovalProjection,
  DelegatedConversationRelationship,
  DelegatedInputProjection,
} from "../types";
import { DelegatedHumanControlSessionModule } from "./delegated-human-control-session";

const conversation = (overrides: Partial<ConversationSummary> = {}): ConversationSummary =>
  ({
    id: "child-1",
    title: "Child",
    projectId: "project-1",
    projectName: "Project",
    provider: "codex-cli",
    worktree: "/repo",
    status: "running",
    archivedAt: null,
    ...overrides,
  }) as ConversationSummary;

const relationship = (
  overrides: Partial<DelegatedConversationRelationship> = {},
): DelegatedConversationRelationship =>
  ({
    id: "rel-1",
    parentThreadId: "parent-1",
    childThreadId: "child-1",
    createdAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  }) as DelegatedConversationRelationship;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("link candidates omit parent, archived, linked, and ancestor conversations", () => {
  const session = new DelegatedHumanControlSessionModule("parent-1", {
    refresh: async () => undefined,
  });
  const relationships = [
    relationship({ childThreadId: "child-linked" }),
    relationship({
      id: "rel-2",
      parentThreadId: "grandparent",
      childThreadId: "parent-1",
    }),
  ];
  const candidates = session.linkCandidates(
    [
      conversation({ id: "parent-1", title: "Parent" }),
      conversation({ id: "child-linked", title: "Linked" }),
      conversation({ id: "grandparent", title: "Grandparent" }),
      conversation({ id: "archived", title: "Archived", archivedAt: "2026-08-01T00:00:00.000Z" }),
      conversation({ id: "available", title: "Available" }),
    ],
    relationships,
  );
  assert.deepEqual(
    candidates.map((item) => item.id),
    ["available"],
  );
});

test("link posts parent-bound body, clears selection, and refreshes", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let refreshed = 0;
  const session = new DelegatedHumanControlSessionModule("parent-1", {
    request: async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({});
    },
    refresh: async () => {
      refreshed += 1;
    },
  });
  session.setSelectedChildId("child-2");

  await session.execute({ kind: "link", childThreadId: "child-2" });
  await flush();

  assert.deepEqual(calls, [
    {
      path: "/api/state/delegated-conversations/link",
      body: { parentThreadId: "parent-1", childThreadId: "child-2" },
    },
  ]);
  assert.equal(session.getSnapshot().selectedChildId, "");
  assert.equal(session.getSnapshot().busy, false);
  assert.equal(refreshed, 1);
});

test("decideApproval optimistically resolves and preserves refresh failure messaging", async () => {
  const session = new DelegatedHumanControlSessionModule("parent-1", {
    request: async () => Response.json({}),
    refresh: async () => {
      throw new Error("offline");
    },
  });
  const delegated = {
    parentThreadId: "parent-1",
    childThreadId: "child-1",
    approval: {
      id: "approval-1",
      runId: "run-1",
      conversationId: "child-1",
      repository: "/repo",
      worktree: "/repo",
      provider: "codex-cli",
      toolCallId: "tool-1",
      toolName: "write",
      scope: { summary: "Write", target: "file", details: [] },
      state: "pending",
      expiresAt: "2026-08-12T11:00:00.000Z",
    },
  } satisfies DelegatedApprovalProjection;

  await session.execute({ kind: "decide_approval", delegated, decision: "allow_once" });

  assert.equal(session.getSnapshot().resolvedApprovalIds.has("approval-1"), true);
  assert.equal(
    session.getSnapshot().error,
    "Approval resolved. Status refresh failed; reconnect to confirm child state.",
  );
  assert.equal(session.getSnapshot().approvalBusyId, null);
  assert.equal(session.pendingApprovalsForChild([delegated], "child-1").length, 0);
});

test("answerInput posts child-bound body using the draft answer", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const session = new DelegatedHumanControlSessionModule("parent-1", {
    request: async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({});
    },
    refresh: async () => undefined,
  });
  const delegated = {
    parentThreadId: "parent-1",
    childThreadId: "child-1",
    request: {
      id: "input-1",
      threadId: "child-1",
      question: "Continue?",
      choices: [],
      recommendation: null,
      responseMode: "child_follow_up",
      state: "pending",
      createdAt: "2026-08-12T10:00:00.000Z",
      expiresAt: null,
      allowFreeForm: true,
    },
  } satisfies DelegatedInputProjection;
  session.setInputAnswer("input-1", "  ship it  ");

  await session.execute({ kind: "answer_input", delegated });

  assert.deepEqual(calls, [
    {
      path: "/api/provider/input-requests/input-1/respond",
      body: {
        childThreadId: "child-1",
        parentThreadId: "parent-1",
        answer: "ship it",
      },
    },
  ]);
  assert.equal(session.getSnapshot().inputBusyId, null);
});

test("childStatus prefers pending approval and awaiting input over store status", () => {
  const session = new DelegatedHumanControlSessionModule("parent-1", {
    refresh: async () => undefined,
  });
  const child = conversation({ status: "running" });
  const approvals = [
    {
      parentThreadId: "parent-1",
      childThreadId: "child-1",
      approval: {
        id: "approval-1",
        runId: "run-1",
        conversationId: "child-1",
        repository: "/repo",
        worktree: "/repo",
        provider: "codex-cli",
        toolCallId: "tool-1",
        toolName: "write",
        scope: { summary: "Write", target: "file", details: [] },
        state: "pending",
        expiresAt: "2026-08-12T11:00:00.000Z",
      },
    },
  ] satisfies DelegatedApprovalProjection[];
  const inputs = [
    {
      parentThreadId: "parent-1",
      childThreadId: "child-1",
      request: {
        id: "input-1",
        threadId: "child-1",
        question: "?",
        choices: [],
        recommendation: null,
        responseMode: "child_follow_up",
        state: "pending",
        createdAt: "2026-08-12T10:00:00.000Z",
        expiresAt: null,
        allowFreeForm: true,
      },
    },
  ] satisfies DelegatedInputProjection[];

  assert.equal(session.childStatus(child, approvals, []), "pending_approval");
  assert.equal(session.childStatus(child, [], inputs), "awaiting_input");
  assert.equal(session.childStatus(child, [], []), "running");
});
