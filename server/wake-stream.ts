import type { ThreadWakeEvent } from "./wake.ts";

export const MAX_PENDING_WAKE_EVENTS = 256;

export interface WakeStreamResponse {
  readonly writableEnded: boolean;
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

interface WakeStreamCoordinatorOptions<Projection> {
  response: WakeStreamResponse;
  loadProjection?: () => Promise<Projection>;
  selectEvents?: (
    projection: Projection,
    events: readonly ThreadWakeEvent[],
  ) => Iterable<ThreadWakeEvent>;
  maxPending?: number;
}

function retainLatestBounded(
  pending: Map<string, ThreadWakeEvent>,
  event: ThreadWakeEvent,
  maximum: number,
): void {
  pending.delete(event.threadId);
  if (pending.size >= maximum) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(event.threadId, event);
}

/**
 * Bounded invalidation delivery for one state-event response.
 *
 * A slow client retains only the latest status for a bounded set of threads.
 * Managed visibility projection is serialized and performed once per burst.
 */
export class WakeStreamCoordinator<Projection = never> {
  readonly #response: WakeStreamResponse;
  readonly #loadProjection: (() => Promise<Projection>) | undefined;
  readonly #selectEvents:
    | ((projection: Projection, events: readonly ThreadWakeEvent[]) => Iterable<ThreadWakeEvent>)
    | undefined;
  readonly #maxPending: number;
  readonly #projectionPending = new Map<string, ThreadWakeEvent>();
  readonly #writePending = new Map<string, ThreadWakeEvent>();
  #projecting = false;
  #blocked = false;
  #closed = false;

  constructor(options: WakeStreamCoordinatorOptions<Projection>) {
    this.#response = options.response;
    this.#loadProjection = options.loadProjection;
    this.#selectEvents = options.selectEvents;
    this.#maxPending = Math.max(1, options.maxPending ?? MAX_PENDING_WAKE_EVENTS);
  }

  readonly #onDrain = (): void => {
    if (this.#closed) return;
    this.#blocked = false;
    this.#pumpWrites();
    this.#pumpProjection();
  };

  publish(event: ThreadWakeEvent): void {
    if (this.#closed || this.#response.writableEnded) return;
    if (this.#loadProjection && this.#selectEvents) {
      retainLatestBounded(this.#projectionPending, event, this.#maxPending);
      this.#pumpProjection();
      return;
    }
    this.#queueWrite(event);
  }

  heartbeat(): void {
    if (this.#closed || this.#blocked || this.#response.writableEnded) return;
    this.#write(": heartbeat\n\n");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#response.off("drain", this.#onDrain);
    this.#projectionPending.clear();
    this.#writePending.clear();
  }

  get pendingCount(): number {
    return this.#projectionPending.size + this.#writePending.size;
  }

  #queueWrite(event: ThreadWakeEvent): void {
    retainLatestBounded(this.#writePending, event, this.#maxPending);
    this.#pumpWrites();
  }

  #pumpWrites(): void {
    while (!this.#closed && !this.#blocked && !this.#response.writableEnded) {
      const next = this.#writePending.entries().next().value;
      if (!next) return;
      const [threadId, event] = next;
      this.#writePending.delete(threadId);
      this.#write(`event: thread_status\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  #write(chunk: string): void {
    try {
      if (this.#response.write(chunk)) return;
      this.#blocked = true;
      this.#response.once("drain", this.#onDrain);
    } catch {
      this.close();
    }
  }

  #pumpProjection(): void {
    if (
      this.#closed ||
      this.#blocked ||
      this.#projecting ||
      this.#writePending.size > 0 ||
      this.#projectionPending.size === 0 ||
      !this.#loadProjection ||
      !this.#selectEvents
    )
      return;
    const events = [...this.#projectionPending.values()];
    this.#projectionPending.clear();
    this.#projecting = true;
    void this.#loadProjection()
      .then((projection) => {
        if (this.#closed) return;
        for (const event of this.#selectEvents!(projection, events)) {
          retainLatestBounded(this.#writePending, event, this.#maxPending);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.#projecting = false;
        this.#pumpWrites();
        this.#pumpProjection();
      });
  }
}
