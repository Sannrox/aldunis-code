import type { ServerResponse } from "node:http";

export function beginProviderEventStream(
  response: ServerResponse,
  ids: { runId: string; threadId: string; turnId: string },
): void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-provider-run-id": ids.runId,
    "x-thread-id": ids.threadId,
    "x-turn-id": ids.turnId,
  });
  // The client needs the run ID to expose Cancel before a provider emits its
  // first event. Without an explicit flush, fetch can remain pending forever
  // behind a silent or stuck provider process.
  response.flushHeaders();
}
