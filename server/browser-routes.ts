import type { IncomingMessage, ServerResponse } from "node:http";
import { BrowserError, type SharedBrowserBroker } from "./browser.ts";
import type { StateProjection } from "./state.ts";

interface BrowserRouteContext {
  browser?: SharedBrowserBroker | null;
  remoteRequest: boolean;
  managed: boolean;
  loadState: () => Promise<StateProjection>;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const BROWSER_ROUTES = new Set([
  "/api/browser/tools",
  "/api/browser/sessions/open",
  "/api/browser/sessions/status",
  "/api/browser/sessions/control",
  "/api/browser/sessions/close",
  "/api/browser/sessions/picture-in-picture",
]);

/**
 * Dispatch the shared-browser route family behind one domain interface.
 * Returns false for routes outside that family so the local dispatcher can
 * continue without learning browser session lifecycle or authorization rules.
 */
export async function handleBrowserRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: BrowserRouteContext,
): Promise<boolean> {
  if (!BROWSER_ROUTES.has(route)) return false;

  const { browser, remoteRequest, managed, loadState, selectWorktree, readJson, sendJson } =
    context;
  const assertBrowserContext = async (body: Record<string, unknown>) => {
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.conversationId !== "string" ||
      !body.conversationId
    ) {
      throw new BrowserError("A repository, worktree, and conversation are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    const projection = await loadState();
    const thread = projection.threads.find((candidate) => candidate.id === body.conversationId);
    const project = thread
      ? projection.projects.find((candidate) => candidate.id === thread.projectId)
      : undefined;
    if (
      !thread ||
      !project ||
      project.root !== selected.root ||
      thread.worktree !== selected.worktree
    ) {
      throw new BrowserError(
        "The selected conversation is not bound to this repository and worktree.",
        403,
      );
    }
    return body.conversationId;
  };

  if (route === "/api/browser/tools") {
    if (!browser || remoteRequest || managed) {
      throw new BrowserError(
        "Shared browser tools are available in the local desktop host only.",
        403,
      );
    }
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      throw new BrowserError(
        "Browser tool authorization is required.",
        403,
        "browser_authorization_denied",
      );
    }
    const body = (await readJson(request)) as { conversationId?: unknown; operation?: unknown };
    if (typeof body.conversationId !== "string") {
      throw new BrowserError("A browser conversation is required.");
    }
    sendJson(
      response,
      200,
      await browser.executeProvider(
        body.conversationId,
        authorization.slice("Bearer ".length),
        body.operation,
      ),
    );
    return true;
  }

  if (!browser) {
    throw new BrowserError(
      "Shared browser sessions are available in the desktop application only.",
      503,
    );
  }
  const body = (await readJson(request)) as Record<string, unknown>;
  const conversationId = await assertBrowserContext(body);
  if (typeof body.sessionId !== "string" && route !== "/api/browser/sessions/open") {
    throw new BrowserError("A browser session and loopback origin are required.");
  }
  if (typeof body.origin !== "string") {
    throw new BrowserError("A loopback browser origin is required.");
  }

  if (route === "/api/browser/sessions/open") {
    sendJson(response, 200, browser.open(conversationId, body.origin));
    return true;
  }
  if (route === "/api/browser/sessions/status") {
    const snapshot = await browser.snapshot(body.sessionId as string);
    if (snapshot.conversationId !== conversationId || snapshot.origin !== body.origin) {
      throw new BrowserError(
        "The browser session is bound to a different conversation or origin.",
        403,
      );
    }
    sendJson(response, 200, snapshot);
    return true;
  }
  if (route === "/api/browser/sessions/control") {
    if (typeof body.enabled !== "boolean") {
      throw new BrowserError("A browser session, loopback origin, and control state are required.");
    }
    sendJson(
      response,
      200,
      await browser.setAgentControl(
        body.sessionId as string,
        { conversationId, origin: body.origin },
        body.enabled,
      ),
    );
    return true;
  }
  if (route === "/api/browser/sessions/close") {
    sendJson(
      response,
      200,
      await browser.close(body.sessionId as string, { conversationId, origin: body.origin }),
    );
    return true;
  }
  if (route === "/api/browser/sessions/picture-in-picture") {
    if (typeof body.open !== "boolean") {
      throw new BrowserError(
        "A browser session, loopback origin, and picture-in-picture state are required.",
      );
    }
    sendJson(
      response,
      200,
      await browser.setPictureInPicture(
        body.sessionId as string,
        { conversationId, origin: body.origin },
        body.open,
      ),
    );
    return true;
  }
  return false;
}
