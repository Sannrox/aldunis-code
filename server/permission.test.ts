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

test("multi-file mutation scopes expose bounded paths without file contents", () => {
  assert.deepEqual(describeMutation("Edit", {
    path: "src/first.ts",
    paths: ["src/first.ts", "src/second.ts"],
    patch: "private source text",
  }), {
    summary: "Edit a file",
    target: "path: src/first.ts",
    details: ["path: src/first.ts", "path: src/second.ts", "patch: [content redacted]"],
  });
});

test("network approval scopes display destination and protocol", () => {
  assert.deepEqual(describeMutation("Bash", {
    host: "api.example.test",
    protocol: "https",
    reason: "Fetch metadata",
  }), {
    summary: "Allow network access",
    target: "host: api.example.test",
    details: ["protocol: https", "reason: Fetch metadata"],
  });
});

test("multi-file approval display is bounded with an explicit omitted count", () => {
  const scope = describeMutation("Edit", {
    path: "src/0.ts",
    paths: Array.from({ length: 52 }, (_, index) => `src/${index}.ts`),
  });
  assert.equal(scope.details.length, 51);
  assert.equal(scope.details.at(-1), "paths omitted: 2");
});

test("allow-once is bound to one exact call and cannot be replayed", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  const waiting = broker.awaitRegisteredDecision(context.runId, token, approval.id);
  const allowed = broker.decide(approval.id, decisionContext(), "allow_once");
  assert.equal(allowed.state, "allowed_once");
  assert.deepEqual(await waiting, { behavior: "allow", updatedInput: context.toolInput });
  assert.deepEqual(
    await broker.awaitRegisteredDecision(context.runId, token, approval.id),
    { behavior: "deny", message: "Aldunis Code rejected an unmatched permission request." },
  );
  assert.throws(
    () => broker.decide(approval.id, decisionContext(), "allow_once"),
    (error: unknown) => error instanceof PermissionError && error.status === 409,
  );
});

test("identical concurrent callbacks atomically claim distinct registered approvals", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const first = broker.register(context);
  const secondContext = { ...context, toolCallId: "tool-2" };
  const second = broker.register(secondContext);
  assert.ok(first);
  assert.ok(second);

  const firstWaiting = broker.awaitDecision(
    context.runId,
    token,
    context.toolName,
    context.toolInput,
  );
  const secondWaiting = broker.awaitDecision(
    context.runId,
    token,
    secondContext.toolName,
    secondContext.toolInput,
  );
  assert.equal(broker.decide(first.id, decisionContext(), "allow_once").state, "allowed_once");
  assert.deepEqual(await firstWaiting, { behavior: "allow", updatedInput: context.toolInput });

  assert.equal(
    broker.decide(second.id, decisionContext(secondContext), "deny").state,
    "denied",
  );
  assert.equal((await secondWaiting).behavior, "deny");
});

test("registered decision identifiers fail closed when missing, mismatched, or replayed", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const otherToken = broker.createRunToken("run-other");
  const approval = broker.register(context);
  assert.ok(approval);

  const unmatched = { behavior: "deny", message: "Aldunis Code rejected an unmatched permission request." };
  assert.deepEqual(
    await broker.awaitRegisteredDecision(context.runId, token, "missing"),
    unmatched,
  );
  assert.deepEqual(
    await broker.awaitRegisteredDecision("run-other", otherToken, approval.id),
    unmatched,
  );

  const waiting = broker.awaitRegisteredDecision(context.runId, token, approval.id);
  assert.equal(broker.decide(approval.id, decisionContext(), "deny").state, "denied");
  assert.equal((await waiting).behavior, "deny");
  assert.deepEqual(
    await broker.awaitRegisteredDecision(context.runId, token, approval.id),
    unmatched,
  );
});

test("approval persistence completes before the provider is released", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  const waiting = broker.awaitRegisteredDecision(context.runId, token, approval.id);
  let persisted = false;
  const deciding = broker.decideAfter(
    approval.id,
    decisionContext(),
    "allow_once",
    async () => {
      persisted = true;
    },
  );
  assert.equal(persisted, true);
  assert.equal((await deciding).state, "allowed_once");
  assert.deepEqual(await waiting, { behavior: "allow", updatedInput: context.toolInput });
});

test("approval persistence failure denies the provider action", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  const waiting = broker.awaitRegisteredDecision(context.runId, token, approval.id);
  await assert.rejects(
    () => broker.decideAfter(approval.id, decisionContext(), "allow_once", async () => {
      throw new Error("fixture persistence failure");
    }),
    /fixture persistence failure/,
  );
  assert.equal((await waiting).behavior, "deny");
  assert.equal(broker.approvalFor(context.runId, context.toolCallId)?.state, "provider_failed");
});

test("run cancellation revokes an approval while persistence is in flight", async () => {
  const broker = new PermissionBroker();
  const token = broker.createRunToken(context.runId);
  const approval = broker.register(context);
  assert.ok(approval);
  const waiting = broker.awaitRegisteredDecision(context.runId, token, approval.id);
  let finishPersistence!: () => void;
  const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
  const deciding = broker.decideAfter(
    approval.id,
    decisionContext(),
    "allow_once",
    () => persistence,
  );
  broker.closeRun(context.runId, "cancelled");
  finishPersistence();
  await assert.rejects(deciding, /closed before it could be released/);
  assert.equal((await waiting).behavior, "deny");
  assert.equal(broker.approvalFor(context.runId, context.toolCallId)?.state, "cancelled");
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
