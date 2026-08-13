import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "../types";
import type { ConversationRunAction } from "./conversation-run";
import {
  ConversationTurnSessionModule,
  type ConversationTurnStartBody,
} from "./conversation-turn-session";

const startBody = (): ConversationTurnStartBody => ({
  root: "/repo",
  worktree: "/repo",
  prompt: "hello",
  mode: "ask",
  conversationId: "conv-1",
  projectId: "project-1",
  contextPins: [],
  profileId: null,
  model: "default",
  provider: "codex-cli",
  workspaceMode: "shared",
  elementReferences: [],
});

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n") + (lines.length ? "\n" : "")));
      controller.close();
    },
  });
}

test("start streams NDJSON events and reports accepted turn identities", async () => {
  const actions: ConversationRunAction[] = [];
  const accepted: Array<{ runId: string | null; threadId: string | null; turnId: string | null }> =
    [];
  const session = new ConversationTurnSessionModule({
    now: () => "2026-08-12T10:00:00.000Z",
    request: async (input, init) => {
      assert.equal(input, "/api/provider/runs");
      assert.equal(init?.method, "POST");
      const headers = new Headers({
        "x-provider-run-id": "run-1",
        "x-thread-id": "thread-1",
        "x-turn-id": "turn-1",
      });
      return new Response(
        ndjsonStream([
          JSON.stringify({ kind: "assistant_text", text: "hi" }),
          JSON.stringify({ kind: "turn_completed", sessionId: "session-1", costUsd: null }),
        ]),
        { status: 200, headers },
      );
    },
  });

  const result = await session.start({
    body: startBody(),
    epoch: 3,
    providerName: "Codex",
    dispatch: (action) => actions.push(action),
    onAccepted: (ids) => {
      accepted.push(ids);
    },
  });

  assert.deepEqual(result, {
    status: "completed",
    runId: "run-1",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.deepEqual(accepted, [{ runId: "run-1", threadId: "thread-1", turnId: "turn-1" }]);
  assert.equal(actions[0]?.type, "stream_opened");
  assert.equal(actions[1]?.type, "provider_event");
  assert.equal(actions[2]?.type, "provider_event");
  assert.equal(actions.filter((action) => action.type === "provider_event").length, 2);
});

test("start failure before accept restores through failed/unaccepted result", async () => {
  const actions: ConversationRunAction[] = [];
  const session = new ConversationTurnSessionModule({
    now: () => "2026-08-12T10:00:00.000Z",
    request: async () =>
      new Response(JSON.stringify({ error: "Worktree busy." }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  });

  const result = await session.start({
    body: startBody(),
    epoch: 1,
    providerName: "Codex",
    dispatch: (action) => actions.push(action),
  });

  assert.deepEqual(result, {
    status: "failed",
    accepted: false,
    message: "Worktree busy.",
    runId: null,
    threadId: null,
    turnId: null,
  });
  assert.deepEqual(actions, [
    {
      type: "transport_failed",
      epoch: 1,
      message: "Worktree busy.",
      occurredAt: "2026-08-12T10:00:00.000Z",
    },
  ]);
});

test("mid-stream failure keeps accepted true so drafts are not restored", async () => {
  const actions: ConversationRunAction[] = [];
  const session = new ConversationTurnSessionModule({
    now: () => "2026-08-12T10:00:00.000Z",
    request: async () => {
      const headers = new Headers({
        "x-provider-run-id": "run-2",
        "x-thread-id": "thread-2",
        "x-turn-id": "turn-2",
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{not-json\n"));
            controller.close();
          },
        }),
        { status: 200, headers },
      );
    },
  });

  const result = await session.start({
    body: startBody(),
    epoch: 2,
    providerName: "Codex",
    dispatch: (action) => actions.push(action),
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.accepted, true);
    assert.equal(result.threadId, "thread-2");
  }
  assert.equal(actions[0]?.type, "stream_opened");
  assert.equal(actions.at(-1)?.type, "transport_failed");
});

test("cancel and decideApproval and answerInput use the same dispatch seam", async () => {
  const actions: ConversationRunAction[] = [];
  const calls: string[] = [];
  const session = new ConversationTurnSessionModule({
    now: () => "2026-08-12T10:00:00.000Z",
    request: async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      if (input.includes("/cancel")) return new Response(null, { status: 200 });
      if (input.includes("/decide")) {
        return Response.json({
          kind: "approval_pending",
          id: "approval-1",
          runId: "run-9",
          conversationId: "conv-1",
          repository: "/repo",
          worktree: "/repo",
          provider: "codex-cli",
          toolCallId: "tool-1",
          toolName: "write",
          scope: { summary: "Write", target: "file", details: [] },
          state: "allowed_once",
          expiresAt: "2026-08-12T11:00:00.000Z",
        } satisfies ProviderEvent);
      }
      return Response.json({});
    },
  });

  const pendingApproval = {
    kind: "approval_pending",
    id: "approval-1",
    runId: "run-9",
    conversationId: "conv-1",
    repository: "/repo",
    worktree: "/repo",
    provider: "codex-cli",
    toolCallId: "tool-1",
    toolName: "write",
    scope: { summary: "Write", target: "file", details: [] },
    state: "pending",
    expiresAt: "2026-08-12T11:00:00.000Z",
  } satisfies ProviderEvent;
  const pendingInput = {
    kind: "input_requested",
    id: "input-1",
    threadId: "thread-9",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    state: "pending",
    createdAt: "2026-08-12T10:00:00.000Z",
    expiresAt: null,
    allowFreeForm: true,
  } satisfies ProviderEvent;

  await session.cancel("run-9", 4, (action) => actions.push(action));
  await session.decideApproval(pendingApproval, "allow_once", (action) => actions.push(action));
  const answered = await session.answerInput(pendingInput, " yes ", "thread-9", (action) =>
    actions.push(action),
  );

  assert.equal(answered, true);
  assert.deepEqual(calls, [
    "POST /api/provider/runs/run-9/cancel",
    "POST /api/provider/approvals/approval-1/decide",
    "POST /api/provider/input-requests/input-1/respond",
  ]);
  assert.equal(actions[0]?.type, "cancel_requested");
  assert.deepEqual(actions[1], {
    type: "approval_decided",
    id: "approval-1",
    state: "allowed_once",
  });
  assert.deepEqual(actions[2], { type: "input_answered", id: "input-1" });
});

test("delegated child start posts parentThreadId and drains without run dispatch", async () => {
  let posted: unknown;
  let pullCount = 0;
  const session = new ConversationTurnSessionModule({
    request: async (input, init) => {
      assert.equal(input, "/api/provider/runs");
      posted = JSON.parse(String(init?.body ?? "{}"));
      const headers = new Headers({
        "x-provider-run-id": "run-child",
        "x-thread-id": "child-1",
        "x-turn-id": "turn-child",
      });
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(encoder.encode('{"kind":"assistant_text","text":"hi"}\n'));
              return;
            }
            controller.close();
          },
        }),
        { status: 200, headers },
      );
    },
  });

  const created: string[] = [];
  const result = await session.startDelegatedChild({
    providerName: "Codex CLI",
    onCreated: (threadId) => created.push(threadId),
    body: {
      ...startBody(),
      parentThreadId: "parent-1",
      prompt: "focused child task",
      workspaceMode: "aldunis-managed",
    },
  });

  assert.deepEqual(result, {
    status: "completed",
    runId: "run-child",
    threadId: "child-1",
    turnId: "turn-child",
  });
  assert.deepEqual(created, ["child-1"]);
  assert.equal((posted as { parentThreadId: string }).parentThreadId, "parent-1");
  assert.ok(pullCount >= 1);
});

test("delegated child start reports an existing thread when the run is rejected", async () => {
  const session = new ConversationTurnSessionModule({
    request: async () =>
      new Response(JSON.stringify({ error: "The parent relationship is not available." }), {
        status: 409,
        headers: {
          "content-type": "application/json",
          "x-thread-id": "child-partial",
        },
      }),
  });
  const created: string[] = [];
  const result = await session.startDelegatedChild({
    providerName: "Codex CLI",
    onCreated: (threadId) => created.push(threadId),
    body: { ...startBody(), parentThreadId: "parent-1" },
  });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.accepted, false);
    assert.equal(result.threadId, "child-partial");
    assert.match(result.message, /parent relationship/);
  }
  assert.deepEqual(created, ["child-partial"]);
});

test("delegated child start keeps the fallback when the error payload is malformed", async () => {
  const session = new ConversationTurnSessionModule({
    request: async () =>
      new Response("null", {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  });
  const result = await session.startDelegatedChild({
    providerName: "Codex CLI",
    body: { ...startBody(), parentThreadId: "parent-1" },
  });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.message, "Codex CLI could not start the child conversation.");
  }
});
