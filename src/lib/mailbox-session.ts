import type { InteractionMode } from "../types";

export interface MailboxTransfer {
  id: string;
  sourceThreadId: string;
  destinationThreadId: string;
  sourceTitle: string;
  destinationTitle: string;
  text: string;
  mode: InteractionMode;
  createdAt: string;
  destinationTurnId: string | null;
  idempotencyKey: string;
}

export interface MailboxSendBody {
  sourceThreadId: string;
  destinationThreadId: string;
  text: string;
  mode: InteractionMode;
  idempotencyKey: string;
}

export const MAILBOX_TEXT_MAX_CHARS = 4_000;

export function mailboxTextLength(text: string): number {
  return Array.from(text.trim()).length;
}

export function clampMailboxText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAILBOX_TEXT_MAX_CHARS) return text;
  return chars.slice(0, MAILBOX_TEXT_MAX_CHARS).join("");
}

export type MailboxTimelineItem<TTurn, TTransfer extends { id: string; createdAt: string }> =
  | { kind: "mailbox"; transfer: TTransfer }
  | { kind: "archived"; turn: TTurn; index: number };

export function interleaveMailboxOutbound<
  TTurn,
  TTransfer extends { id: string; createdAt: string },
>(
  archivedTurns: TTurn[],
  transfers: TTransfer[],
  archivedCreatedAt: (turn: TTurn) => string | undefined,
): MailboxTimelineItem<TTurn, TTransfer>[] {
  const items: Array<MailboxTimelineItem<TTurn, TTransfer> & { at: string; order: number }> = [];
  archivedTurns.forEach((turn, index) => {
    items.push({
      kind: "archived",
      turn,
      index,
      at: archivedCreatedAt(turn) ?? "",
      order: index,
    });
  });
  transfers.forEach((transfer, order) => {
    items.push({
      kind: "mailbox",
      transfer,
      at: transfer.createdAt,
      order: archivedTurns.length + order,
    });
  });
  items.sort((left, right) => {
    if (left.at !== right.at) return left.at.localeCompare(right.at);
    return left.order - right.order;
  });
  return items.map(({ at: _at, order: _order, ...item }) => item);
}

export function partitionMailboxOutbound<T extends { createdAt: string }>(
  transfers: T[],
  currentCreatedAt?: string | null,
): { before: T[]; after: T[] } {
  if (!currentCreatedAt) return { before: [...transfers], after: [] };
  const before: T[] = [];
  const after: T[] = [];
  for (const transfer of transfers) {
    if (transfer.createdAt > currentCreatedAt) after.push(transfer);
    else before.push(transfer);
  }
  return { before, after };
}

export function mailboxSendError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

export class ConversationMailboxSessionModule {
  private readonly request: typeof fetch;

  constructor(adapters: { request?: typeof fetch } = {}) {
    this.request = adapters.request ?? fetch;
  }

  async send(body: MailboxSendBody): Promise<MailboxTransfer> {
    const response = await this.request("/api/mailbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | { transfer?: MailboxTransfer; error?: string }
      | null;
    if (!response.ok || !payload?.transfer) {
      throw new Error(mailboxSendError(payload, "The mailbox message could not be sent."));
    }
    return payload.transfer;
  }
}
