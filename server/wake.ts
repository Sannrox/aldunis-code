import type { ThreadStatus } from "./state.ts";

/**
 * Loopback wake event for thread status transitions.
 * Intentionally omits prompts, tool output, diffs, and repository paths.
 */
export interface ThreadWakeEvent {
  threadId: string;
  status: ThreadStatus;
  at: string;
}

export class WakeBroker {
  readonly #subscribers = new Set<(event: ThreadWakeEvent) => void>();

  subscribe(handler: (event: ThreadWakeEvent) => void): () => void {
    this.#subscribers.add(handler);
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  publish(event: ThreadWakeEvent): void {
    for (const handler of this.#subscribers) {
      try {
        handler(event);
      } catch {
        // A single subscriber failure must not break other listeners.
      }
    }
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }
}
