import assert from "node:assert/strict";
import test from "node:test";
import type { StateProjection } from "./state.ts";
import { projectConversationHistory, projectWorkbenchState } from "./state-projection.ts";

function sampleProjection(): StateProjection {
  const base = {
    schemaVersion: 2 as const,
    sequence: 3,
    projects: [
      {
        schemaVersion: 2 as const,
        id: "p1",
        name: "demo",
        root: "/repo",
        openedAt: "t0",
      },
    ],
    threads: [
      {
        schemaVersion: 2 as const,
        id: "thread-a",
        projectId: "p1",
        worktree: "/repo",
        workspaceMode: "shared" as const,
        title: "A",
        provider: "claude-code" as const,
        createdAt: "t0",
        updatedAt: "t1",
      },
      {
        schemaVersion: 2 as const,
        id: "thread-b",
        projectId: "p1",
        worktree: "/repo",
        workspaceMode: "shared" as const,
        title: "B",
        provider: "claude-code" as const,
        createdAt: "t0",
        updatedAt: "t1",
      },
    ],
    turns: [
      {
        schemaVersion: 2 as const,
        id: "turn-a",
        threadId: "thread-a",
        status: "completed" as const,
        mode: "build" as const,
        createdAt: "t0",
        completedAt: "t1",
      },
      {
        schemaVersion: 2 as const,
        id: "turn-b",
        threadId: "thread-b",
        status: "completed" as const,
        mode: "build" as const,
        createdAt: "t0",
        completedAt: "t1",
      },
    ],
    messages: [
      {
        schemaVersion: 2 as const,
        id: "m1",
        turnId: "turn-a",
        role: "user" as const,
        text: "hello a",
        createdAt: "t0",
      },
      {
        schemaVersion: 2 as const,
        id: "m2",
        turnId: "turn-b",
        role: "user" as const,
        text: "hello b",
        createdAt: "t0",
      },
    ],
    activities: [
      {
        schemaVersion: 2 as const,
        id: "act1",
        turnId: "turn-a",
        kind: "tool_started" as const,
        toolCallId: "tool-1",
        name: "Read",
        failed: null,
        message: null,
        createdAt: "t0",
      },
    ],
    plans: [],
    contextReceipts: [],
    usageReceipts: [],
    governanceCorrelations: [],
    providerSessions: [
      {
        schemaVersion: 2 as const,
        threadId: "thread-a",
        provider: "claude-code" as const,
        sessionId: "sess-a",
        model: "default",
        createdAt: "t0",
        updatedAt: "t0",
      },
    ],
    checkpoints: [],
    annotations: [],
    fileReviews: [],
    conversationDeletions: [],
    forks: [],
    delegatedRelationships: [],
    inputRequests: [],
    inputReceipts: [],
    automationFires: [],
    autonomyRuns: [],
    autonomyTasks: [],
    autonomyFlows: [],
    heartbeatMonitors: [],
    standingOrders: [],
    autonomyHooks: [],
  };
  return base as StateProjection;
}

test("workbench projection drops transcript bodies while keeping threads", () => {
  const projection = sampleProjection();
  const workbench = projectWorkbenchState(projection);
  assert.equal(workbench.threads.length, 2);
  assert.equal(workbench.messages.length, 0);
  assert.equal(workbench.activities.length, 0);
  assert.equal(workbench.plans.length, 0);
  assert.equal(workbench.contextReceipts.length, 0);
  assert.equal(workbench.inputRequests.length, 0);
  // Source projection is untouched.
  assert.equal(projection.messages.length, 2);
});

test("conversation history is scoped to one thread", () => {
  const projection = sampleProjection();
  const history = projectConversationHistory(projection, "thread-a");
  assert.ok(history);
  assert.deepEqual(
    history.threads.map((thread) => thread.id),
    ["thread-a"],
  );
  assert.deepEqual(
    history.messages.map((message) => message.id),
    ["m1"],
  );
  assert.deepEqual(
    history.activities.map((activity) => activity.id),
    ["act1"],
  );
  assert.equal(projectConversationHistory(projection, "missing"), null);
});
