import type { IncomingMessage, ServerResponse } from "node:http";
import type { InteractionMode } from "./provider.ts";
import { LocalStateError, type LocalStateStore, type MailboxTransfer } from "./state.ts";

export interface MailboxRouteContext {
  state: Pick<LocalStateStore, "saveMailboxTransfer" | "abandonMailboxDelivery">;
  remoteRequest: boolean;
  managed: boolean;
  deliver: (transfer: MailboxTransfer) => Promise<{ turnId: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const MAILBOX_ROUTES = new Set(["/api/mailbox/send"]);

/**
 * Dispatches human-reviewed mailbox sends without granting agent-originated
 * messaging or automatic tool approval.
 */
export async function handleMailboxRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: MailboxRouteContext,
): Promise<boolean> {
  if (!MAILBOX_ROUTES.has(route)) return false;
  const { state, remoteRequest, managed, deliver, readJson, sendJson } = context;
  if (remoteRequest || managed) {
    throw new LocalStateError("Remote clients cannot send mailbox messages.", 403);
  }
  const body = (await readJson(request)) as {
    sourceThreadId?: unknown;
    destinationThreadId?: unknown;
    text?: unknown;
    mode?: unknown;
    idempotencyKey?: unknown;
  };
  if (
    typeof body.sourceThreadId !== "string" ||
    typeof body.destinationThreadId !== "string" ||
    typeof body.text !== "string" ||
    typeof body.idempotencyKey !== "string"
  ) {
    throw new LocalStateError(
      "sourceThreadId, destinationThreadId, text, and idempotencyKey are required.",
      400,
    );
  }
  if (body.mode !== undefined && !["ask", "plan", "build"].includes(String(body.mode))) {
    throw new LocalStateError("A valid interaction mode is required.", 400);
  }
  const saved = await state.saveMailboxTransfer({
    sourceThreadId: body.sourceThreadId,
    destinationThreadId: body.destinationThreadId,
    text: body.text,
    mode: (body.mode as InteractionMode | undefined) ?? "ask",
    idempotencyKey: body.idempotencyKey,
  });
  if (!saved.created && saved.transfer.destinationTurnId) {
    sendJson(response, 200, { transfer: saved.transfer });
    return true;
  }
  try {
    const delivered = await deliver(saved.transfer);
    sendJson(response, 200, {
      transfer: { ...saved.transfer, destinationTurnId: delivered.turnId },
    });
  } catch (error) {
    await state.abandonMailboxDelivery({
      transferId: saved.transfer.id,
      destinationThreadId: saved.transfer.destinationThreadId,
      destinationTurnId: saved.transfer.destinationTurnId,
    });
    throw error;
  }
  return true;
}
