import type { IncomingMessage, ServerResponse } from "node:http";
import type { ManagedHost } from "./managed-host.ts";
import type { StateProjection } from "./state.ts";
import type { ThreadWakeEvent } from "./wake.ts";
import { WakeStreamCoordinator } from "./wake-stream.ts";
import { filterManagedThreadSearchProjection } from "./workbench-projection-routes.ts";

export const WAKE_STREAM_ROUTE = "/api/state/events";
export const MAX_CONCURRENT_WAKE_STREAMS = 32;

export class WakeStreamAdmission {
  readonly #maximum: number;
  #active = 0;

  constructor(maximum = MAX_CONCURRENT_WAKE_STREAMS) {
    this.#maximum = Number.isFinite(maximum)
      ? Math.max(1, Math.floor(maximum))
      : MAX_CONCURRENT_WAKE_STREAMS;
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#maximum) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }

  get activeCount(): number {
    return this.#active;
  }
}

export interface WakeStreamRouteContext {
  method: string | undefined;
  wake: { subscribe(handler: (event: ThreadWakeEvent) => void): () => void };
  loadProjection: () => Promise<Readonly<StateProjection>>;
  admission: WakeStreamAdmission;
  managedHost?: Pick<ManagedHost, "repositoryForRoot">;
  heartbeatMs?: number;
}

/**
 * Dispatch wake SSE route recognition, response headers, coordinator
 * construction (including managed visibility filtering), heartbeat, and
 * cleanup behind one interface while WakeStreamCoordinator retains bounded
 * delivery authority.
 */
export async function handleWakeStreamRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: WakeStreamRouteContext,
): Promise<boolean> {
  if (context.method !== "GET" || route !== WAKE_STREAM_ROUTE) return false;

  const releaseAdmission = context.admission.tryAcquire();
  if (!releaseAdmission) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    response.end("retry: 1000\nevent: capacity\ndata: retry\n\n");
    return true;
  }

  let cleaned = false;
  let stream: WakeStreamCoordinator<Readonly<StateProjection>> | WakeStreamCoordinator | null =
    null;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.off("close", cleanup);
    response.off("close", cleanup);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    stream?.close();
    releaseAdmission();
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
  if (request.aborted || response.destroyed || response.writableEnded) {
    cleanup();
    return true;
  }

  try {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    response.write("event: ready\ndata: ready\n\n");

    stream = context.managedHost
      ? new WakeStreamCoordinator<Readonly<StateProjection>>({
          response,
          loadProjection: context.loadProjection,
          selectEvents: (projection, events) => {
            const visible = filterManagedThreadSearchProjection(
              projection as StateProjection,
              context.managedHost!,
            );
            const threadIds = new Set(visible.threads.map((thread) => thread.id));
            return events.filter((event) => threadIds.has(event.threadId));
          },
        })
      : new WakeStreamCoordinator({ response });

    unsubscribe = context.wake.subscribe((event) => stream?.publish(event));
    if (cleaned) {
      unsubscribe();
      unsubscribe = null;
      stream.close();
      stream = null;
      return true;
    }
    heartbeat = setInterval(() => {
      stream?.heartbeat();
    }, context.heartbeatMs ?? 30_000);
    heartbeat.unref();
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}
