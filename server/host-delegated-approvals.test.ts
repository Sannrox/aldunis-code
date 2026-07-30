import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalHost } from "./host.ts";
import { PermissionBroker } from "./permission.ts";
import { DEFAULT_PREFERENCES, PreferencesStore } from "./preferences.ts";
import { ClaudeProfileStore } from "./profiles.ts";
import { LocalStateStore } from "./state.ts";

test("beta-disabled host rejects parent-routed approval decisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-approval-"));
  const state = new LocalStateStore(directory);
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/provider/approvals/00000000-0000-0000-0000-000000000000/decide`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run",
          conversationId: "child",
          repository: "/repo",
          worktree: "/repo/child",
          toolCallId: "tool",
          decision: "deny",
          parentThreadId: "parent",
        }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Parent-routed approvals require beta orchestration.",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("parent-routed decisions resolve the original child approval once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-delegated-approval-"));
  const state = new LocalStateStore(directory);
  const permissions = new PermissionBroker();
  const server = createLocalHost(
    directory,
    state,
    new ClaudeProfileStore(directory),
    undefined,
    undefined,
    permissions,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  await fetch(`http://127.0.0.1:${address.port}/api/state/load`, { method: "POST" });
  await state.saveProject({ id: "project", name: "Project", root: "/repo" });
  const parent = await state.startTurn({
    projectId: "project",
    worktree: "/repo/parent",
    prompt: "Coordinate",
    mode: "ask",
    provider: "codex-cli",
  });
  const child = await state.startTurn({
    projectId: "project",
    worktree: "/repo/child",
    prompt: "Change a file",
    mode: "build",
    provider: "codex-cli",
  });
  await state.linkDelegatedConversation(parent.thread.id, child.thread.id);
  await state.bindProviderRun(child.turn.id, "run-child");
  const approval = permissions.register({
    runId: "run-child",
    conversationId: child.thread.id,
    repository: "/repo",
    worktree: "/repo/child",
    provider: "codex-cli",
    toolCallId: "tool",
    toolName: "Edit",
    toolInput: { path: "src/a.ts" },
  });
  assert.ok(approval);
  const siblingApproval = permissions.register({
    runId: "run-child",
    conversationId: child.thread.id,
    repository: "/repo",
    worktree: "/repo/child",
    provider: "codex-cli",
    toolCallId: "tool-sibling",
    toolName: "Write",
    toolInput: { path: "src/b.ts" },
  });
  assert.ok(siblingApproval);
  await state.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "approval_pending",
    ...approval,
  });
  await state.recordProviderEvent(child.thread.id, child.turn.id, "codex-cli", {
    kind: "approval_pending",
    ...siblingApproval,
  });
  await new PreferencesStore(directory).save({
    ...DEFAULT_PREFERENCES,
    orchestrationThreadsBeta: true,
  });
  try {
    const stateResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/state/load`,
      { method: "POST" },
    );
    assert.equal(stateResponse.status, 200);
    const loaded = await stateResponse.json() as {
      delegatedApprovals: Array<{
        parentThreadId: string;
        childThreadId: string;
        approval: { id: string };
      }>;
    };
    assert.deepEqual(
      loaded.delegatedApprovals.map((item) => item.approval.id).sort(),
      [approval.id, siblingApproval.id].sort(),
    );
    const body = {
      runId: approval.runId,
      conversationId: approval.conversationId,
      repository: approval.repository,
      worktree: approval.worktree,
      toolCallId: approval.toolCallId,
      decision: "deny",
      parentThreadId: parent.thread.id,
    };
    const route = `http://127.0.0.1:${address.port}/api/provider/approvals/${approval.id}/decide`;
    const eventController = new AbortController();
    const eventResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/state/events`,
      { signal: eventController.signal },
    );
    assert.equal(eventResponse.status, 200);
    const eventReader = eventResponse.body?.getReader();
    assert.ok(eventReader);
    await eventReader.read();
    const responses = await Promise.all([fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const success = responses.find((response) => response.status === 200);
    const conflict = responses.find((response) => response.status === 409);
    assert.ok(success);
    assert.ok(conflict);
    assert.equal((await success.json() as { state: string }).state, "denied");
    assert.deepEqual(await conflict.json(), {
      error: "The approval request has already been resolved.",
    });
    const notification = await Promise.race([
      eventReader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Approval status event timed out.")), 1_000);
      }),
    ]);
    assert.match(
      new TextDecoder().decode(notification.value),
      new RegExp(`event: thread_status[\\s\\S]*${child.thread.id}`),
    );
    eventController.abort();
    const afterResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/state/load`,
      { method: "POST" },
    );
    assert.deepEqual(
      (await afterResponse.json() as {
        delegatedApprovals: Array<{ approval: { id: string } }>;
      }).delegatedApprovals.map((item) => item.approval.id),
      [siblingApproval.id],
    );
    const projection = await state.load();
    assert.equal(
      projection.turns.find((turn) => turn.id === child.turn.id)?.status,
      "waiting_for_approval",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
