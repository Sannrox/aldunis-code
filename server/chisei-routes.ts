import type { IncomingMessage, ServerResponse } from "node:http";
import { ChiseiClientError, type ChiseiProjectionClient } from "./chisei-client.ts";
import { LocalStateError, type Project, type StateProjection } from "./state.ts";

interface ChiseiRouteState {
  inspect: () => Promise<StateProjection>;
  bindProjectChiseiNamespace: (projectId: string, namespace: string | null) => Promise<Project>;
}

interface ChiseiRouteContext {
  state: ChiseiRouteState;
  chisei: ChiseiProjectionClient;
  remoteRequest: boolean;
  managed: boolean;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const CHISEI_ROUTES = new Set([
  "/api/integrations/chisei/bind",
  "/api/integrations/chisei/actions/list",
  "/api/integrations/chisei/actions/detail",
  "/api/integrations/chisei/observations/detail",
  "/api/integrations/chisei/operations/detail",
]);

async function boundProject(
  state: ChiseiRouteState,
  projectId: string,
): Promise<Project & { chiseiNamespace: string }> {
  const project = (await state.inspect()).projects.find((item) => item.id === projectId);
  if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
  if (!project.chiseiNamespace) {
    throw new ChiseiClientError(
      "This project is not bound to a Chisei namespace.",
      409,
      "unconfigured",
    );
  }
  return project as Project & { chiseiNamespace: string };
}

/**
 * Dispatch server-owned Chisei project projections through one internal interface.
 * This module owns route validation, project namespace authority, correlation
 * ownership, bounded projection reads, and response shaping.
 */
export async function handleChiseiRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ChiseiRouteContext,
): Promise<boolean> {
  if (!CHISEI_ROUTES.has(route)) return false;

  if (route === "/api/integrations/chisei/bind") {
    if (context.remoteRequest || context.managed) {
      throw new LocalStateError(
        "This host cannot administer Chisei project bindings in the active mode.",
        403,
      );
    }
    const body = (await context.readJson(request)) as {
      projectId?: unknown;
      namespace?: unknown;
    };
    if (
      typeof body.projectId !== "string" ||
      (body.namespace !== null && typeof body.namespace !== "string")
    ) {
      throw new LocalStateError("A project and Chisei namespace are required.", 400);
    }
    const project = await context.state.bindProjectChiseiNamespace(
      body.projectId,
      body.namespace as string | null,
    );
    context.sendJson(response, 200, {
      projectId: project.id,
      chiseiNamespace: project.chiseiNamespace ?? null,
    });
    return true;
  }

  if (route === "/api/integrations/chisei/actions/list") {
    const body = (await context.readJson(request)) as {
      projectId?: unknown;
      typeId?: unknown;
      status?: unknown;
      limit?: unknown;
    };
    if (
      typeof body.projectId !== "string" ||
      (body.typeId !== undefined && typeof body.typeId !== "string") ||
      (body.status !== undefined && typeof body.status !== "string") ||
      (body.limit !== undefined &&
        (typeof body.limit !== "number" || !Number.isInteger(body.limit)))
    ) {
      throw new LocalStateError("A valid local project and bounded filters are required.", 400);
    }
    const project = await boundProject(context.state, body.projectId);
    context.sendJson(
      response,
      200,
      await context.chisei.listActions(project.id, project.chiseiNamespace, {
        typeId: body.typeId?.trim().slice(0, 200),
        status: body.status?.trim().slice(0, 50),
        limit: body.limit as number | undefined,
      }),
    );
    return true;
  }

  if (route === "/api/integrations/chisei/actions/detail") {
    const body = (await context.readJson(request)) as { projectId?: unknown; instanceId?: unknown };
    if (
      typeof body.projectId !== "string" ||
      typeof body.instanceId !== "string" ||
      !body.instanceId ||
      body.instanceId.length > 200
    ) {
      throw new LocalStateError("A valid local project and Action id are required.", 400);
    }
    const project = await boundProject(context.state, body.projectId);
    context.sendJson(
      response,
      200,
      await context.chisei.actionDetail(project.chiseiNamespace, body.instanceId),
    );
    return true;
  }

  if (route === "/api/integrations/chisei/observations/detail") {
    const body = (await context.readJson(request)) as { projectId?: unknown; requestId?: unknown };
    if (
      typeof body.projectId !== "string" ||
      typeof body.requestId !== "string" ||
      !body.requestId ||
      body.requestId.length > 512 ||
      body.requestId.includes("\0")
    ) {
      throw new LocalStateError(
        "A local project and bounded observation identity are required.",
        400,
      );
    }
    const project = await boundProject(context.state, body.projectId);
    const observation = await context.chisei.sampleObservation(
      project.chiseiNamespace,
      body.requestId,
    );
    if (!observation) {
      throw new LocalStateError("The Chisei observation is unavailable on the read surface.", 404);
    }
    context.sendJson(response, 200, observation);
    return true;
  }

  const body = (await context.readJson(request)) as {
    projectId?: unknown;
    correlationId?: unknown;
  };
  if (typeof body.projectId !== "string" || typeof body.correlationId !== "string") {
    throw new LocalStateError("A project and governance correlation are required.", 400);
  }
  const projection = await context.state.inspect();
  const correlation = projection.governanceCorrelations.find(
    (item) => item.id === body.correlationId,
  );
  const thread = correlation
    ? projection.threads.find((item) => item.id === correlation.threadId)
    : null;
  if (!correlation || !thread || thread.projectId !== body.projectId) {
    throw new LocalStateError("The governance correlation is unavailable.", 404);
  }
  context.sendJson(response, 200, await context.chisei.operationReceipt(correlation.operationId));
  return true;
}
