import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { DEFAULT_PREFERENCES, PreferencesStore } from "./preferences.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import { LocalStateError, LocalStateStore } from "./state.ts";

test("parent resolves one exact delegated input and records a child-bound receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-input-"));
  const state = new LocalStateStore(directory);
  const followedUp: Array<Record<string, unknown>> = [];
  let followUpAttempts = 0;
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
    undefined,
    undefined,
    undefined,
    async (body) => {
      followUpAttempts += 1;
      if (followUpAttempts === 1) {
        throw new LocalStateError("Worktree checkpoint is still closing.", 409);
      }
      followedUp.push(body);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await fetch(`http://127.0.0.1:${address.port}/api/state/load`, { method: "POST" });
  await state.saveProject({ id: "project", name: "Project", root: directory });
  const parent = await state.startTurn({
    projectId: "project",
    worktree: directory,
    prompt: "Coordinate",
    mode: "ask",
    provider: "codex-cli",
  });
  const child = await state.startTurn({
    projectId: "project",
    worktree: directory,
    prompt: "Work",
    mode: "plan",
    provider: "shikigami",
    contextPins: [{ kind: "file", path: "src/example.ts" }],
  });
  await state.linkDelegatedConversation(parent.thread.id, child.thread.id);
  await state.bindProviderRun(child.turn.id, "run-child");
  await state.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
    kind: "session_started",
    sessionId: "shikigami-session",
    model: "selected-model",
  });
  await state.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
    kind: "input_requested",
    id: "00000000-0000-4000-8000-000000000001",
    question: "Continue?",
    choices: [],
    recommendation: null,
    responseMode: "child_follow_up",
    providerRequestId: null,
    expiresAt: null,
    allowFreeForm: true,
  });
  await new PreferencesStore(directory).save({
    ...DEFAULT_PREFERENCES,
    orchestrationThreadsBeta: true,
  });
  try {
    const loaded = await fetch(
      `http://127.0.0.1:${address.port}/api/state/load`,
      { method: "POST" },
    ).then((response) => response.json()) as {
      delegatedInputs: Array<{ request: { id: string } }>;
    };
    assert.deepEqual(
      loaded.delegatedInputs.map((item) => item.request.id),
      ["00000000-0000-4000-8000-000000000001"],
    );
    const route = `http://127.0.0.1:${address.port}/api/provider/input-requests/00000000-0000-4000-8000-000000000001/respond`;
    const body = JSON.stringify({
      childThreadId: child.thread.id,
      parentThreadId: parent.thread.id,
      answer: "Continue",
    });
    const responses = await Promise.all([
      fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body }),
      fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const projection = await state.load();
    assert.equal(projection.inputReceipts.length, 1);
    assert.equal(projection.inputReceipts[0].parentThreadId, parent.thread.id);
    assert.equal(projection.inputRequests[0].state, "answered");
    assert.equal(followedUp.length, 1);
    assert.equal(followUpAttempts, 2);
    assert.equal(followedUp[0].threadId, child.thread.id);
    assert.equal(followedUp[0].mode, "plan");
    assert.equal(followedUp[0].model, "selected-model");
    assert.equal(followedUp[0].inputRequestId, "00000000-0000-4000-8000-000000000001");
    assert.deepEqual(followedUp[0].contextPins, [{ kind: "file", path: "src/example.ts" }]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("beta-disabled parent routing fails while the child route remains actionable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-input-"));
  const state = new LocalStateStore(directory);
  let childFollowUps = 0;
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
    undefined,
    undefined,
    undefined,
    async () => { childFollowUps += 1; },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    await fetch(`http://127.0.0.1:${address.port}/api/state/load`, { method: "POST" });
    await state.saveProject({ id: "project", name: "Project", root: directory });
    const child = await state.startTurn({
      projectId: "project",
      worktree: directory,
      prompt: "Work",
      mode: "build",
      provider: "shikigami",
    });
    await state.bindProviderRun(child.turn.id, "run-child");
    await state.recordProviderEvent(child.thread.id, child.turn.id, "shikigami", {
      kind: "input_requested",
      id: "00000000-0000-4000-8000-000000000001",
      question: "Continue?",
      choices: [],
      recommendation: null,
      responseMode: "child_follow_up",
      providerRequestId: null,
      expiresAt: null,
      allowFreeForm: true,
    });
    const parentResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/provider/input-requests/00000000-0000-4000-8000-000000000001/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          childThreadId: child.thread.id,
          parentThreadId: "parent",
          answer: "Continue",
        }),
      },
    );
    assert.equal(parentResponse.status, 403);
    const invalidResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/provider/input-requests/00000000-0000-4000-8000-000000000001/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadId: child.thread.id, answer: "" }),
      },
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal(childFollowUps, 0);
    const childResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/provider/input-requests/00000000-0000-4000-8000-000000000001/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadId: child.thread.id, answer: "Continue" }),
      },
    );
    assert.equal(childResponse.status, 200);
    assert.equal(childFollowUps, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
