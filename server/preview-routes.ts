import type { IncomingMessage, ServerResponse } from "node:http";
import { PreviewError, type PreviewManager } from "./preview.ts";

interface PreviewRouteContext {
  previews: Pick<PreviewManager, "requestStart" | "decide" | "snapshot" | "stop">;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const REQUEST_ROUTE = "/api/previews/request";
const DECISION_ROUTE = /^\/api\/previews\/([0-9a-f-]+)\/decide$/;
const STATUS_ROUTE = /^\/api\/previews\/([0-9a-f-]+)\/status$/;
const STOP_ROUTE = /^\/api\/previews\/([0-9a-f-]+)\/stop$/;

/**
 * Dispatch constrained-preview lifecycle requests behind one interface. The
 * module owns route recognition, scoped payload validation, canonical
 * worktree selection, transition ordering, and response mapping while the
 * PreviewManager retains approval and process authority.
 */
export async function handlePreviewRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: PreviewRouteContext,
): Promise<boolean> {
  if (route === REQUEST_ROUTE) {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      origin?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.origin !== "string"
    ) {
      throw new PreviewError("A repository, worktree, and loopback origin are required.");
    }
    const selected = await context.selectWorktree(body.root, body.worktree);
    context.sendJson(
      response,
      200,
      await context.previews.requestStart(selected.root, selected.worktree, body.origin),
    );
    return true;
  }

  const decision = route.match(DECISION_ROUTE);
  if (decision) {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      decision?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      (body.decision !== "allow_once" && body.decision !== "deny")
    ) {
      throw new PreviewError("A scoped preview decision is required.");
    }
    const selected = await context.selectWorktree(body.root, body.worktree);
    context.sendJson(
      response,
      200,
      context.previews.decide(
        decision[1],
        { repository: selected.root, worktree: selected.worktree },
        body.decision,
      ),
    );
    return true;
  }

  const status = route.match(STATUS_ROUTE);
  if (status) {
    context.sendJson(response, 200, context.previews.snapshot(status[1]));
    return true;
  }

  const stop = route.match(STOP_ROUTE);
  if (stop) {
    const body = (await context.readJson(request)) as { root?: unknown; worktree?: unknown };
    if (typeof body.root !== "string" || typeof body.worktree !== "string") {
      throw new PreviewError("A repository and worktree are required.");
    }
    const selected = await context.selectWorktree(body.root, body.worktree);
    context.sendJson(
      response,
      200,
      await context.previews.stop(stop[1], {
        repository: selected.root,
        worktree: selected.worktree,
      }),
    );
    return true;
  }

  return false;
}
