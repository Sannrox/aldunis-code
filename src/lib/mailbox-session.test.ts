import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationMailboxSessionModule,
  MAILBOX_TEXT_MAX_CHARS,
  clampMailboxText,
  interleaveMailboxOutbound,
  mailboxTextLength,
  partitionMailboxOutbound,
} from "./mailbox-session";

test("mailbox text length trims and counts unicode characters", () => {
  assert.equal(mailboxTextLength("  café  "), 4);
  assert.equal(MAILBOX_TEXT_MAX_CHARS, 4_000);
  const emoji = "🙂".repeat(MAILBOX_TEXT_MAX_CHARS + 8);
  assert.equal(Array.from(clampMailboxText(emoji)).length, MAILBOX_TEXT_MAX_CHARS);
  assert.equal(clampMailboxText(emoji).length, MAILBOX_TEXT_MAX_CHARS * 2);
});

test("mailbox outbound cards interleave with turns by createdAt", () => {
  const { before, after } = partitionMailboxOutbound(
    [
      { id: "early", createdAt: "2026-08-14T10:00:00.000Z" },
      { id: "late", createdAt: "2026-08-14T12:00:00.000Z" },
    ],
    "2026-08-14T11:00:00.000Z",
  );
  assert.deepEqual(
    before.map((item) => item.id),
    ["early"],
  );
  assert.deepEqual(
    after.map((item) => item.id),
    ["late"],
  );
  assert.deepEqual(
    interleaveMailboxOutbound([{ id: "turn-a" }, { id: "turn-b" }], before, (turn) =>
      turn.id === "turn-a" ? "2026-08-14T09:00:00.000Z" : "2026-08-14T10:30:00.000Z",
    ).map((item) => (item.kind === "mailbox" ? item.transfer.id : item.turn.id)),
    ["turn-a", "early", "turn-b"],
  );
});

test("mailbox session posts the reviewed payload", async () => {
  const session = new ConversationMailboxSessionModule({
    request: (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      assert.equal(body.text, "Please review the plan.");
      return new Response(
        JSON.stringify({
          transfer: {
            id: "transfer-1",
            sourceThreadId: "a",
            destinationThreadId: "b",
            text: body.text,
            destinationTurnId: "turn-b",
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  const transfer = await session.send({
    sourceThreadId: "a",
    destinationThreadId: "b",
    text: "Please review the plan.",
    mode: "ask",
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(transfer.destinationTurnId, "turn-b");
});

test("mailbox session surfaces host errors", async () => {
  const session = new ConversationMailboxSessionModule({
    request: (async () =>
      new Response(JSON.stringify({ error: "The destination conversation is busy." }), {
        status: 409,
      })) as typeof fetch,
  });
  await assert.rejects(
    session.send({
      sourceThreadId: "a",
      destinationThreadId: "b",
      text: "Hello",
      mode: "ask",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    }),
    /destination conversation is busy/,
  );
});
