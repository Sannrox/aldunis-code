import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcilePersistedRestorationApplication,
  restorePersistedConversation,
  type PersistedConversationProjection,
} from "./persisted-conversation-restoration";

function projection(): PersistedConversationProjection {
  return {
    sequence: 1,
    threads: [
      {
        id: "thread-1",
        projectId: "project-1",
        worktree: "/repo/worktree",
        provider: "codex-cli",
        contextPins: [
          { kind: "file", path: "src/main.ts" },
          { kind: "folder", path: "src/lib" },
        ],
      },
    ],
    turns: [
      {
        id: "turn-1",
        threadId: "thread-1",
        status: "completed",
        mode: "build",
        createdAt: "2026-08-10T10:00:00.000Z",
        completedAt: "2026-08-10T10:00:04.000Z",
      },
    ],
    messages: [
      {
        turnId: "turn-1",
        role: "user",
        text: "Fix it",
        createdAt: "2026-08-10T10:00:00.000Z",
      },
      {
        turnId: "turn-1",
        role: "assistant",
        text: "second sequenced event",
        createdAt: "2026-08-10T10:00:01.000Z",
        eventSequence: 2,
      },
      {
        turnId: "turn-1",
        role: "assistant",
        text: "first sequenced event",
        createdAt: "2026-08-10T10:00:03.000Z",
        eventSequence: 1,
      },
    ],
    governanceCorrelations: [
      {
        id: "correlation-1",
        turnId: "turn-1",
        runId: "run-1",
        operationId: "operation-1",
        governance: "sekai-chisei",
        createdAt: "2026-08-10T10:00:02.000Z",
      },
    ],
    providerSessions: [
      {
        threadId: "thread-1",
        provider: "codex-cli",
        sessionId: "session-1",
        model: "gpt-5",
      },
    ],
  };
}

const target = {
  conversationId: "thread-1",
  projectId: "project-1",
  worktree: "/repo/worktree",
  activeProvider: "codex-cli" as const,
  providerName: "Codex CLI",
};

test("restorePersistedConversation returns one complete renderer snapshot", () => {
  const restored = restorePersistedConversation(projection(), target);
  assert.equal(restored.kind, "restored");
  if (restored.kind !== "restored") return;

  assert.deepEqual(restored.thread.attachments, ["src/main.ts"]);
  assert.deepEqual(restored.thread.folderPins, ["src/lib"]);
  assert.equal(restored.thread.model, "gpt-5");
  assert.equal(restored.currentTurn.message.mode, "build");
  assert.equal(restored.currentTurn.events.at(-1)?.kind, "turn_completed");
  assert.equal(restored.providerState, "completed");
});

test("restoration application resets through an unbound composer", () => {
  const snapshot = { target: "thread-1", fingerprint: "same" };
  const first = reconcilePersistedRestorationApplication(null, snapshot);
  assert.equal(first.apply, true);
  assert.equal(reconcilePersistedRestorationApplication(first.current, snapshot).apply, false);
  const reset = reconcilePersistedRestorationApplication(first.current, null);
  assert.equal(reset.current, null);
  assert.equal(reconcilePersistedRestorationApplication(reset.current, snapshot).apply, true);
});

test("restoration event ordering is deterministic for mixed record generations", () => {
  const expected = [
    "first sequenced event",
    "second sequenced event",
    "governance_correlation",
    "turn_completed",
  ];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const input = projection();
    input.messages = [input.messages[0]!, ...input.messages.slice(1).reverse()];
    const restored = restorePersistedConversation(input, target);
    assert.equal(restored.kind, "restored");
    if (restored.kind !== "restored") return;
    assert.deepEqual(
      restored.currentTurn.events.map((event) =>
        event.kind === "assistant_text" ? event.text : event.kind,
      ),
      expected,
    );
  }
});

test("restoration preserves source stability across sequenced and projection-only records", () => {
  const input = projection();
  input.messages.push({
    turnId: "turn-1",
    role: "assistant",
    text: "unsequenced message",
    createdAt: "2026-08-10T10:00:02.000Z",
  });
  input.activities = [
    {
      turnId: "turn-1",
      kind: "tool_started",
      toolCallId: "tool-1",
      name: "Tool",
      failed: null,
      message: null,
      createdAt: "2026-08-10T10:00:03.000Z",
      eventSequence: 1,
    },
    {
      turnId: "turn-1",
      kind: "tool_finished",
      toolCallId: "tool-1",
      name: "Tool",
      failed: false,
      message: null,
      createdAt: "2026-08-10T10:00:02.000Z",
    },
    {
      turnId: "turn-1",
      kind: "tool_started",
      toolCallId: "",
      name: "Malformed",
      failed: null,
      message: null,
      createdAt: "2026-08-10T10:00:02.000Z",
    },
  ];
  input.plans = [
    {
      artifactId: "plan-1",
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "codex-cli",
      title: "Plan",
      updatedAt: "2026-08-10T10:00:02.000Z",
      createdAt: "2026-08-10T10:00:02.000Z",
    },
  ];
  input.inputRequests = [
    {
      kind: "input_requested",
      turnId: "turn-1",
      id: "input-1",
      threadId: "thread-1",
      question: "Continue?",
      choices: [],
      recommendation: null,
      responseMode: "child_follow_up",
      expiresAt: null,
      allowFreeForm: true,
      state: "pending",
      createdAt: "2026-08-10T10:00:02.000Z",
    },
  ];

  const restored = restorePersistedConversation(input, target);
  assert.equal(restored.kind, "restored");
  if (restored.kind !== "restored") return;
  assert.deepEqual(
    restored.currentTurn.events.map((event) => {
      if (event.kind === "assistant_text") return event.text;
      if (event.kind === "tool_started" || event.kind === "tool_finished") return event.kind;
      if (event.kind === "plan_updated") return event.kind;
      if (event.kind === "input_requested") return event.kind;
      return event.kind;
    }),
    [
      "first sequenced event",
      "tool_started",
      "second sequenced event",
      "unsequenced message",
      "tool_finished",
      "plan_updated",
      "input_requested",
      "governance_correlation",
      "turn_completed",
    ],
  );
});

test("multi-turn restoration keeps indexed records scoped to their owning turn", () => {
  const input = projection();
  input.turns.push({
    id: "turn-2",
    threadId: "thread-1",
    status: "completed",
    mode: "ask",
    createdAt: "2026-08-10T11:00:00.000Z",
    completedAt: "2026-08-10T11:00:02.000Z",
  });
  input.messages.push(
    {
      turnId: "turn-2",
      role: "user",
      text: "Explain it",
      createdAt: "2026-08-10T11:00:00.000Z",
    },
    {
      turnId: "turn-2",
      role: "assistant",
      text: "Only the second answer",
      createdAt: "2026-08-10T11:00:01.000Z",
    },
  );

  const restored = restorePersistedConversation(input, target);
  assert.equal(restored.kind, "restored");
  if (restored.kind !== "restored") return;
  assert.equal(restored.archivedTurns.length, 1);
  assert.equal(restored.archivedTurns[0]?.message.text, "Fix it");
  assert.ok(
    restored.archivedTurns[0]?.events.some((event) => event.kind === "governance_correlation"),
  );
  assert.equal(restored.currentTurn.message.text, "Explain it");
  assert.deepEqual(
    restored.currentTurn.events.map((event) =>
      event.kind === "assistant_text" ? event.text : event.kind,
    ),
    ["Only the second answer", "turn_completed"],
  );
});

test("restoration fails closed across identity and provider selection", () => {
  assert.deepEqual(restorePersistedConversation(projection(), { ...target, worktree: "/other" }), {
    kind: "thread_missing",
  });
  assert.deepEqual(
    restorePersistedConversation(projection(), {
      ...target,
      activeProvider: "claude-code",
    }),
    { kind: "provider_changed", provider: "codex-cli" },
  );
});
