import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalStateError, LocalStateStore } from "./state.ts";
import { projectConversationHistory } from "./state-projection.ts";

async function fixtureStore() {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-mailbox-"));
  return { directory, store: new LocalStateStore(directory) };
}

test("mailbox persist is visible on both conversations and omitted from workbench lists", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const source = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Source",
    mode: "ask",
    provider: "codex-cli",
  });
  const destination = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Destination",
    mode: "ask",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(source.thread.id, source.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  await store.recordProviderEvent(destination.thread.id, destination.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  const { transfer, created } = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(created, true);
  const projection = await store.inspect();
  const sourceHistory = projectConversationHistory(projection, source.thread.id);
  const destHistory = projectConversationHistory(projection, destination.thread.id);
  assert.equal(sourceHistory?.mailboxTransfers.length, 1);
  assert.equal(destHistory?.mailboxTransfers.length, 1);
  assert.equal(sourceHistory?.mailboxTransfers[0]?.text, "Please review the plan.");
  assert.ok(transfer.destinationTurnId);
  assert.ok(sourceHistory?.threads.some((thread) => thread.id === destination.thread.id));
});

test("mailbox persist fails closed for same thread, busy dest, and replayed keys", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const source = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Source",
    mode: "ask",
    provider: "codex-cli",
  });
  const destination = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Destination",
    mode: "ask",
    provider: "codex-cli",
  });
  await assert.rejects(
    () =>
      store.saveMailboxTransfer({
        sourceThreadId: source.thread.id,
        destinationThreadId: source.thread.id,
        text: "loop",
        mode: "ask",
        idempotencyKey: "22222222-2222-4222-8222-222222222222",
      }),
    (error: unknown) => error instanceof LocalStateError && error.status === 400,
  );
  await assert.rejects(
    () =>
      store.saveMailboxTransfer({
        sourceThreadId: source.thread.id,
        destinationThreadId: destination.thread.id,
        text: "busy dest",
        mode: "ask",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
      }),
    (error: unknown) => error instanceof LocalStateError && error.status === 409,
  );
  await store.recordProviderEvent(destination.thread.id, destination.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  const first = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  });
  const replay = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "44444444-4444-4444-8444-444444444444",
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.transfer.id, first.transfer.id);
  assert.equal(replay.transfer.destinationTurnId, first.transfer.destinationTurnId);
});

test("abandoned mailbox delivery can be retried with the same key", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const source = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Source",
    mode: "ask",
    provider: "codex-cli",
  });
  const destination = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Destination",
    mode: "ask",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(source.thread.id, source.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  await store.recordProviderEvent(destination.thread.id, destination.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  const first = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
  });
  await store.abandonMailboxDelivery({ transferId: first.transfer.id });
  assert.equal(await store.inspectThreadBusy(destination.thread.id), false);
  const retry = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
  });
  assert.equal(retry.created, true);
  assert.equal(retry.transfer.id, first.transfer.id);
  assert.equal(await store.inspectThreadBusy(destination.thread.id), true);
});

test("mailbox persist rejects a pending fork destination", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const source = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Source",
    mode: "ask",
    provider: "codex-cli",
  });
  const destination = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Destination",
    mode: "ask",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(source.thread.id, source.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  await store.recordProviderEvent(destination.thread.id, destination.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  const preview = await store.previewFork(destination.thread.id);
  const pending = await store.createFork({
    sourceThreadId: destination.thread.id,
    provider: "claude-code",
    profileId: null,
    model: "default",
    worktree: "/fixture",
    expectedDigest: preview.digest,
  });
  await assert.rejects(
    () =>
      store.saveMailboxTransfer({
        sourceThreadId: source.thread.id,
        destinationThreadId: pending.thread.id,
        text: "Please review the plan.",
        mode: "ask",
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
      }),
    (error: unknown) =>
      error instanceof LocalStateError &&
      error.status === 409 &&
      /waiting to start as a fork/.test(error.message),
  );
});

test("deleting the source conversation interrupts an undelivered mailbox destination turn", async () => {
  const { store } = await fixtureStore();
  await store.saveProject({ id: "project-1", name: "fixture", root: "/fixture" });
  const source = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Source",
    mode: "ask",
    provider: "codex-cli",
  });
  const destination = await store.startTurn({
    projectId: "project-1",
    worktree: "/fixture",
    prompt: "Destination",
    mode: "ask",
    provider: "codex-cli",
  });
  await store.recordProviderEvent(source.thread.id, source.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  await store.recordProviderEvent(destination.thread.id, destination.turn.id, "codex-cli", {
    kind: "turn_completed",
  });
  const saved = await store.saveMailboxTransfer({
    sourceThreadId: source.thread.id,
    destinationThreadId: destination.thread.id,
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
  });
  assert.equal(await store.inspectThreadBusy(destination.thread.id), true);
  await store.deleteConversation(source.thread.id);
  assert.equal(await store.inspectThreadBusy(destination.thread.id), false);
  await store.abandonMailboxDelivery({
    transferId: saved.transfer.id,
    destinationThreadId: saved.transfer.destinationThreadId,
    destinationTurnId: saved.transfer.destinationTurnId,
  });
  assert.equal(await store.inspectThreadBusy(destination.thread.id), false);
});
