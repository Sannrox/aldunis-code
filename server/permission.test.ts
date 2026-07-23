import assert from "node:assert/strict";
import test from "node:test";
import {
  describeMutation,
  PermissionBroker,
  PermissionError,
} from "./permission.ts";

const context = {
  runId: "run-1",
  conversationId: "conversation-1",
  repository: "/repository",
  worktree: "/repository/worktree",
  toolCallId: "tool-1",
  toolName: "Write",
  toolInput: {
    file_path: "/repository/worktree/src/main.ts",
    content: "const token = 'private';",
    api_key: "sk-secret",
  },
};

function decisionContext(overrides: Partial<typeof context> = {}) {
  const value = { ...context, ...overrides };
  return {
    runId: value.runId,
    conversationId: value.conversationId,
    repository: value.repository,
    worktree: value.worktree,
    toolCallId: value.toolCallId,
  };
}

test("mutation scopes retain targets while redacting sensitive values", () => {
  const scope = describeMutation("Write", context.toolInput);
  assert.match(scope.target, /src\/main\.ts/);
  assert.equal(scope.details.some((detail) => detail.includes("sk-secret")), false);
  assert.equal(scope.details.some((detail) => detail.includes("[redacted]")), true);
});

test("allow-once is bound to one exact call and cannot be replayed", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  const waiting = broker.awaitDecision(context.runId, token, context.toolName, context.toolInput);
  const allowed = broker.decide(approval.id, decisionContext(), "allow_once");
  assert.equal(allowed.state, "allowed_once");
  assert.deepEqual(await waiting, { behavior: "allow", updatedInput: context.toolInput });
  assert.throws(
    () => broker.decide(approval.id, decisionContext(), "allow_once"),
    (error: unknown) => error instanceof PermissionError && error.status === 409,
  );
});

test("deny, cancellation, expiry, and provider failure resolve fail-closed", async () => {
  const deniedBroker = new PermissionBroker();
  const deniedToken = deniedBroker.createRunToken("run-denied");
  const deniedInput = { ...context, runId: "run-denied" };
  const deniedApproval = deniedBroker.register(deniedInput);
  assert.ok(deniedApproval);
  const deniedWaiting = deniedBroker.awaitDecision(
    deniedInput.runId,
    deniedToken,
    deniedInput.toolName,
    deniedInput.toolInput,
  );
  assert.equal(
    deniedBroker.decide(deniedApproval.id, decisionContext(deniedInput), "deny").state,
    "denied",
  );
  assert.equal((await deniedWaiting).behavior, "deny");

  for (const state of ["cancelled", "provider_failed"] as const) {
    const broker = new PermissionBroker();
    const runId = `run-${state}`;
    const token = broker.createRunToken(runId);
    const input = { ...context, runId };
    assert.ok(broker.register(input));
    const waiting = broker.awaitDecision(runId, token, input.toolName, input.toolInput);
    broker.closeRun(runId, state);
    assert.deepEqual(await waiting, {
      behavior: "deny",
      message: `Aldunis Code closed the approval request (${state.replace("_", " ")}).`,
    });
  }

  const expiring = new PermissionBroker(5);
  const expiryToken = expiring.createRunToken("run-expired");
  const expiryInput = { ...context, runId: "run-expired" };
  assert.ok(expiring.register(expiryInput));
  const expired = await expiring.awaitDecision(
    expiryInput.runId,
    expiryToken,
    expiryInput.toolName,
    expiryInput.toolInput,
  );
  assert.equal(expired.behavior, "deny");
  assert.match("message" in expired ? expired.message : "", /expired/);
});

test("cross-worktree and unmatched provider requests are rejected", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  assert.throws(
    () => broker.decide(
      approval.id,
      decisionContext({ worktree: "/repository/other-worktree" }),
      "allow_once",
    ),
    (error: unknown) => error instanceof PermissionError && error.status === 403,
  );
  assert.deepEqual(
    await broker.awaitDecision(context.runId, token, "Edit", { file_path: "other" }),
    { behavior: "deny", message: "Aldunis Code rejected an unmatched permission request." },
  );
});
