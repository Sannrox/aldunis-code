import type { IncomingMessage, ServerResponse } from "node:http";
import { RemoteAuthError, type RemoteAuth } from "./remote-auth.ts";

interface RemoteAccessRouteContext {
  remoteAuth?: Pick<RemoteAuth, "descriptor" | "listSessions" | "issuePairing" | "revoke" | "pair">;
  managed: boolean;
  localControlRequest: boolean;
  publicOrigin?: string | (() => string | undefined);
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const ADMIN_ROUTE = /^\/api\/remote\/admin\/(status|pair|revoke)$/;
const PAIR_ROUTE = "/api/remote/pair";
const DESCRIPTOR_ROUTE = "/api/remote/descriptor";

function pairingOrigin(
  request: IncomingMessage,
  publicOrigin: RemoteAccessRouteContext["publicOrigin"],
): string {
  const configured = typeof publicOrigin === "function" ? publicOrigin() : publicOrigin;
  if (publicOrigin !== undefined && !configured) {
    throw new RemoteAuthError("The public remote origin is not ready.", 503);
  }
  if (configured) return new URL(configured).origin;
  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
  return `${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
}

/**
 * Dispatch remote-access routes behind one interface. The module owns route
 * recognition, local-control and managed admission, pairing-link origin,
 * request validation, and response mapping. RemoteAuth retains credential,
 * proof, session, and persistence authority.
 */
export async function handleRemoteAccessRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: RemoteAccessRouteContext,
): Promise<boolean> {
  const admin = route.match(ADMIN_ROUTE);
  if (admin) {
    if (!context.localControlRequest || context.managed) {
      throw new RemoteAuthError(
        "Remote access administration is available only from the local host.",
        403,
      );
    }
    const action = admin[1];
    if (action === "status") {
      context.sendJson(response, 200, {
        remoteEnabled: Boolean(context.remoteAuth),
        descriptor: context.remoteAuth ? await context.remoteAuth.descriptor() : null,
        sessions: context.remoteAuth ? await context.remoteAuth.listSessions() : [],
      });
      return true;
    }
    if (!context.remoteAuth) throw new RemoteAuthError("Remote access is disabled.", 404);
    if (action === "pair") {
      const origin = pairingOrigin(request, context.publicOrigin);
      const pairing = await context.remoteAuth.issuePairing();
      context.sendJson(response, 200, {
        ...pairing,
        pairingUrl: `${origin}/#pair=${pairing.credential}`,
      });
      return true;
    }
    const body = (await context.readJson(request)) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      throw new RemoteAuthError("A remote session is required.", 400);
    }
    context.sendJson(response, 200, { revoked: await context.remoteAuth.revoke(body.sessionId) });
    return true;
  }

  if (route === PAIR_ROUTE) {
    if (context.managed) {
      throw new RemoteAuthError("Remote pairing is unavailable in managed hosted mode.", 404);
    }
    if (!context.remoteAuth) throw new RemoteAuthError("Remote access is disabled.", 404);
    const body = (await context.readJson(request)) as {
      credential?: unknown;
      label?: unknown;
      publicKey?: unknown;
    };
    context.sendJson(response, 200, await context.remoteAuth.pair(body));
    return true;
  }

  if (route === DESCRIPTOR_ROUTE) {
    if (context.managed) {
      context.sendJson(response, 200, { remoteEnabled: false, hostedMode: true });
    } else if (!context.remoteAuth) {
      context.sendJson(response, 200, { remoteEnabled: false });
    } else {
      context.sendJson(response, 200, {
        remoteEnabled: true,
        ...(await context.remoteAuth.descriptor()),
      });
    }
    return true;
  }

  return false;
}
