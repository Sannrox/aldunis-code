import type { IncomingMessage, ServerResponse } from "node:http";
import type { ManagedHost } from "./managed-host.ts";
import type { StateProjection } from "./state.ts";
import type { ThreadWakeEvent } from "./wake.ts";
import { WakeStreamCoordinator } from "./wake-stream.ts";
import { filterManagedThreadSearchProjection } from "./workbench-projection-routes.ts";

export const WAKE_STREAM_ROUTE = "/api/state/events";

export interface WakeStreamRouteContext {
  method: string | undefined;
  wake: { subscribe(handler: (event: ThreadWakeEvent) => void): () => void };
  loadProjection: () => Promise<Readonly<StateProjection>>;
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

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
  response.write(": connected\n\n");

  const stream = context.managedHost
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

  const unsubscribe = context.wake.subscribe((event) => stream.publish(event));
  const heartbeat = setInterval(() => {
    stream.heartbeat();
  }, context.heartbeatMs ?? 30_000);
  heartbeat.unref();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    request.off("close", cleanup);
    response.off("close", cleanup);
    clearInterval(heartbeat);
    unsubscribe();
    stream.close();
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
  return true;
}
