import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderRunExecution } from "./provider-run.ts";
import { LocalStateError } from "./state.ts";
import { PermissionError, type PermissionBroker } from "./permission.ts";
import { RepositoryError } from "./repository.ts";

interface CancellableProvider {
  cancel(runId: string): boolean;
}

interface ProviderControlRouteContext {
  provider: CancellableProvider & { capabilities(): unknown };
  codex: CancellableProvider & { skills(worktree: string): Promise<unknown> };
  shikigami: CancellableProvider;
  permissions: Pick<PermissionBroker, "approvalsFor" | "awaitDecision">;
  activeAcp: Map<string, CancellableProvider>;
  managed: boolean;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  startRun: (
    body: unknown,
    localPort: number | undefined,
    response: ServerResponse,
  ) => ProviderRunExecution;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

interface ProviderPermissionRequestContext {
  permissions: Pick<PermissionBroker, "awaitDecision">;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const CAPABILITIES_ROUTE = "/api/provider/capabilities";
const SKILLS_ROUTE = "/api/provider/skills";
const APPROVALS_ROUTE = "/api/provider/approvals/list";
const RUNS_ROUTE = "/api/provider/runs";
export const PROVIDER_PERMISSION_ROUTE = "/api/provider/permissions/request";
const CANCEL_ROUTE = /^\/api\/provider\/runs\/([0-9a-f-]+)\/cancel$/;

/**
 * Resolve one provider permission request through the same interface used by
 * the host and private provider callback adapters.
 */
export async function handleProviderPermissionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ProviderPermissionRequestContext,
): Promise<void> {
  const body = (await context.readJson(request)) as {
    runId?: unknown;
    toolName?: unknown;
    input?: unknown;
  };
  const authorization = request.headers.authorization;
  if (
    typeof body.runId !== "string" ||
    typeof body.toolName !== "string" ||
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    throw new PermissionError("A valid provider permission request is required.", 403);
  }
  context.sendJson(
    response,
    200,
    await context.permissions.awaitDecision(
      body.runId,
      authorization.slice("Bearer ".length),
      body.toolName,
      body.input,
    ),
  );
}

/**
 * Dispatch provider control routes behind one interface. Provider-specific
 * protocol behavior, permission authority, and run execution remain in their
 * existing adapters and deep modules.
 */
export async function handleProviderControlRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ProviderControlRouteContext,
): Promise<boolean> {
  if (route === CAPABILITIES_ROUTE) {
    const capabilities = context.provider.capabilities() as {
      attachments?: unknown;
    };
    context.sendJson(
      response,
      200,
      context.managed
        ? {
            provider: "shikigami",
            commands: [],
            attachments: capabilities.attachments,
            workspace: {
              shared: true,
              aldunisManaged: true,
              providerNative: false,
              providerNativeDetail:
                "Managed hosted mode supplies the workspace; provider-native worktree creation is unavailable.",
            },
          }
        : capabilities,
    );
    return true;
  }

  if (route === SKILLS_ROUTE) {
    if (context.managed) {
      throw new LocalStateError("Codex skills are unavailable in managed hosted mode.", 403);
    }
    const body = (await context.readJson(request)) as {
      provider?: unknown;
      root?: unknown;
      worktree?: unknown;
    };
    if (
      body.provider !== "codex-cli" ||
      typeof body.root !== "string" ||
      typeof body.worktree !== "string"
    ) {
      throw new RepositoryError("A Codex provider, repository, and worktree are required.");
    }
    const selected = await context.selectWorktree(body.root, body.worktree);
    context.sendJson(response, 200, { skills: await context.codex.skills(selected.worktree) });
    return true;
  }

  if (route === APPROVALS_ROUTE) {
    const body = (await context.readJson(request)) as { runId?: unknown };
    if (typeof body.runId !== "string") throw new PermissionError("A provider run is required.");
    context.sendJson(response, 200, { approvals: context.permissions.approvalsFor(body.runId) });
    return true;
  }

  if (route === RUNS_ROUTE) {
    const execution = context.startRun(
      await context.readJson(request),
      request.socket.localPort,
      response,
    );
    void execution.accepted.catch(() => undefined);
    return await execution.completed;
  }

  if (route === PROVIDER_PERMISSION_ROUTE) {
    await handleProviderPermissionRequest(request, response, context);
    return true;
  }

  const cancellation = route.match(CANCEL_ROUTE);
  if (cancellation) {
    const runId = cancellation[1];
    const acp = context.activeAcp.get(runId);
    if (
      !context.provider.cancel(runId) &&
      !context.codex.cancel(runId) &&
      !context.shikigami.cancel(runId) &&
      !acp?.cancel(runId)
    ) {
      throw new RepositoryError("The provider run is no longer active.", 404);
    }
    context.sendJson(response, 202, { status: "cancelling" });
    return true;
  }

  return false;
}
