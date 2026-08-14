import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { handleMailboxRoute, type MailboxRouteContext } from "./mailbox-routes.ts";
import { LocalStateError, type MailboxTransfer } from "./state.ts";

const response = {} as ServerResponse;
const unused = async () => {
  throw new Error("dependency must not be called");
};

function request(): IncomingMessage {
  return new EventEmitter() as IncomingMessage;
}

function transfer(overrides: Partial<MailboxTransfer> = {}): MailboxTransfer {
  return {
    schemaVersion: 2,
    id: "11111111-1111-4111-8111-111111111111",
    sourceThreadId: "thread-a",
    destinationThreadId: "thread-b",
    text: "Please review the plan.",
    mode: "ask",
    createdAt: "t0",
    destinationTurnId: null,
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ status: number; value: unknown }> = [];
  return {
    sent,
    state: { saveMailboxTransfer: unused, inspectThreadBusy: unused, inspect: unused },
    remoteRequest: false,
    managed: false,
    deliver: unused,
    abandonMailboxDelivery: unused,
    readJson: unused,
    sendJson: (_response: ServerResponse, status: number, value: unknown) =>
      sent.push({ status, value }),
    ...overrides,
  };
}

test("mailbox module leaves unrelated routes to local dispatch", async () => {
  assert.equal(
    await handleMailboxRoute(
      "/api/state/load",
      request(),
      response,
      context() as unknown as MailboxRouteContext,
    ),
    false,
  );
});

test("remote and managed clients cannot send mailbox messages", async () => {
  await assert.rejects(
    () =>
      handleMailboxRoute(
        "/api/mailbox/send",
        request(),
        response,
        context({ remoteRequest: true }) as unknown as MailboxRouteContext,
      ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
  await assert.rejects(
    () =>
      handleMailboxRoute(
        "/api/mailbox/send",
        request(),
        response,
        context({ managed: true }) as unknown as MailboxRouteContext,
      ),
    (error: unknown) => error instanceof LocalStateError && error.status === 403,
  );
});

test("mailbox send persists then delivers a destination turn", async () => {
  const saved = transfer();
  const module = context({
    readJson: async () => ({
      sourceThreadId: saved.sourceThreadId,
      destinationThreadId: saved.destinationThreadId,
      text: saved.text,
      mode: saved.mode,
      idempotencyKey: saved.idempotencyKey,
    }),
    state: {
      saveMailboxTransfer: async () => ({ transfer: saved, created: true }),
    },
    deliver: async (item: MailboxTransfer) => {
      assert.equal(item.id, saved.id);
      return { turnId: "turn-b" };
    },
  });
  assert.equal(
    await handleMailboxRoute(
      "/api/mailbox/send",
      request(),
      response,
      module as unknown as MailboxRouteContext,
    ),
    true,
  );
  assert.deepEqual(module.sent, [
    { status: 200, value: { transfer: { ...saved, destinationTurnId: "turn-b" } } },
  ]);
});

test("failed mailbox delivery abandons the pre-created destination turn", async () => {
  const saved = transfer({ destinationTurnId: "turn-b" });
  let abandoned = 0;
  const module = context({
    readJson: async () => ({
      sourceThreadId: saved.sourceThreadId,
      destinationThreadId: saved.destinationThreadId,
      text: saved.text,
      mode: saved.mode,
      idempotencyKey: saved.idempotencyKey,
    }),
    state: {
      saveMailboxTransfer: async () => ({ transfer: saved, created: true }),
      abandonMailboxDelivery: async (input: {
        transferId: string;
        destinationThreadId?: string;
        destinationTurnId?: string | null;
      }) => {
        assert.equal(input.transferId, saved.id);
        assert.equal(input.destinationThreadId, saved.destinationThreadId);
        assert.equal(input.destinationTurnId, saved.destinationTurnId);
        abandoned += 1;
      },
    },
    deliver: async () => {
      throw new LocalStateError("The destination provider is unavailable.", 503);
    },
  });
  await assert.rejects(
    () =>
      handleMailboxRoute(
        "/api/mailbox/send",
        request(),
        response,
        module as unknown as MailboxRouteContext,
      ),
    /destination provider is unavailable/,
  );
  assert.equal(abandoned, 1);
});

test("idempotent mailbox send does not deliver again", async () => {
  const saved = transfer({ destinationTurnId: "turn-existing" });
  let delivered = 0;
  const module = context({
    readJson: async () => ({
      sourceThreadId: saved.sourceThreadId,
      destinationThreadId: saved.destinationThreadId,
      text: saved.text,
      mode: saved.mode,
      idempotencyKey: saved.idempotencyKey,
    }),
    state: {
      saveMailboxTransfer: async () => ({ transfer: saved, created: false }),
    },
    deliver: async () => {
      delivered += 1;
      return { turnId: "turn-new" };
    },
  });
  await handleMailboxRoute(
    "/api/mailbox/send",
    request(),
    response,
    module as unknown as MailboxRouteContext,
  );
  assert.equal(delivered, 0);
  assert.deepEqual(module.sent, [{ status: 200, value: { transfer: saved } }]);
});
