import assert from "node:assert/strict";
import test from "node:test";
import {
  persistedConversationRestorationFingerprint,
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

test("restoration fingerprint changes only with normalized renderer state", () => {
  const first = restorePersistedConversation(projection(), target);
  const equivalent = restorePersistedConversation(projection(), { ...target });
  assert.equal(
    persistedConversationRestorationFingerprint(first),
    persistedConversationRestorationFingerprint(equivalent),
  );

  const changedMessage = projection();
  changedMessage.messages[1] = { ...changedMessage.messages[1]!, text: "changed" };
  assert.notEqual(
    persistedConversationRestorationFingerprint(first),
    persistedConversationRestorationFingerprint(
      restorePersistedConversation(changedMessage, target),
    ),
  );

  const changedBinding = projection();
  changedBinding.threads[0] = {
    ...changedBinding.threads[0]!,
    contextPins: [
      ...(changedBinding.threads[0]!.contextPins ?? []),
      { kind: "file", path: "new.ts" },
    ],
  };
  assert.notEqual(
    persistedConversationRestorationFingerprint(first),
    persistedConversationRestorationFingerprint(
      restorePersistedConversation(changedBinding, target),
    ),
  );
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
