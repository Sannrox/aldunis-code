import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutonomyEngine, AutonomyScheduler } from "./autonomy-engine.ts";
import {
  AutonomyError,
  parseAutonomyHook,
  parseHeartbeatMonitor,
  parseStandingOrder,
  type AutonomyHookEvent,
  type HeartbeatMonitor,
} from "./autonomy.ts";
import type { LocalStateStore } from "./state.ts";

export interface AutonomyRouteContext {
  autonomy: AutonomyEngine;
  autonomyScheduler: AutonomyScheduler;
  state: LocalStateStore;
  remoteRequest: boolean;
  managed: boolean;
  visibleProjectIds: () => Promise<Set<string>>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  now?: () => string;
}

const AUTONOMY_ROUTES = new Set([
  "/api/autonomy/load",
  "/api/autonomy/gardener/start",
  "/api/autonomy/runs/cancel",
  "/api/autonomy/runs/resume",
  "/api/autonomy/heartbeats/create",
  "/api/autonomy/heartbeats/update",
  "/api/autonomy/heartbeats/delete",
  "/api/autonomy/heartbeats/run-now",
  "/api/autonomy/standing-orders/create",
  "/api/autonomy/standing-orders/update",
  "/api/autonomy/standing-orders/delete",
  "/api/autonomy/hooks/create",
  "/api/autonomy/hooks/update",
  "/api/autonomy/hooks/delete",
]);

/** Dispatches the local Autonomy route family without granting new authority. */
export async function handleAutonomyRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: AutonomyRouteContext,
): Promise<boolean> {
  if (!AUTONOMY_ROUTES.has(route)) return false;
  const { autonomy, autonomyScheduler, state, remoteRequest, managed, readJson, sendJson } =
    context;
  const now = context.now ?? (() => new Date().toISOString());
  const assertLocalMutation = (message: string) => {
    if (remoteRequest || managed) throw new AutonomyError(message, 403);
  };

  if (route === "/api/autonomy/load") {
    const snapshot = await autonomy.snapshot(200);
    if (!managed) {
      sendJson(response, 200, snapshot);
      return true;
    }
    const projectIds = await context.visibleProjectIds();
    const runs = snapshot.runs.filter(
      (run) => run.projectId === null || projectIds.has(run.projectId),
    );
    const runIds = new Set(runs.map((run) => run.id));
    sendJson(response, 200, {
      ...snapshot,
      runs,
      tasks: snapshot.tasks.filter((task) => runIds.has(task.runId)),
      heartbeatMonitors: snapshot.heartbeatMonitors.filter(
        (monitor) => monitor.projectId === null || projectIds.has(monitor.projectId),
      ),
      standingOrders: snapshot.standingOrders.filter(
        (order) => order.projectId === null || projectIds.has(order.projectId),
      ),
      hooks: snapshot.hooks.filter(
        (hook) => hook.projectId === null || projectIds.has(hook.projectId),
      ),
    });
    return true;
  }

  if (route === "/api/autonomy/gardener/start") {
    assertLocalMutation("Autonomous runs can only be started from the local host.");
    const body = (await readJson(request)) as {
      projectId?: unknown;
      worktree?: unknown;
      goal?: unknown;
      standingOrderIds?: unknown;
    };
    if (typeof body.projectId !== "string") throw new AutonomyError("A project is required.");
    if (body.worktree !== undefined && body.worktree !== null && typeof body.worktree !== "string")
      throw new AutonomyError("The worktree is invalid.");
    if (body.goal !== undefined && typeof body.goal !== "string")
      throw new AutonomyError("The gardener goal is invalid.");
    const standingOrderIds =
      body.standingOrderIds === undefined
        ? undefined
        : Array.isArray(body.standingOrderIds) &&
            body.standingOrderIds.every((item) => typeof item === "string")
          ? (body.standingOrderIds as string[])
          : (() => {
              throw new AutonomyError("Standing order ids are invalid.");
            })();
    sendJson(
      response,
      202,
      await autonomy.startGardener({
        projectId: body.projectId,
        worktree: typeof body.worktree === "string" ? body.worktree : null,
        goal: typeof body.goal === "string" ? body.goal : undefined,
        standingOrderIds,
      }),
    );
    return true;
  }

  if (route === "/api/autonomy/runs/cancel" || route === "/api/autonomy/runs/resume") {
    assertLocalMutation(
      route.endsWith("cancel")
        ? "Remote clients cannot cancel autonomy runs."
        : "Remote clients cannot resume autonomy runs.",
    );
    const body = (await readJson(request)) as { runId?: unknown };
    if (typeof body.runId !== "string") throw new AutonomyError("An autonomy run is required.");
    const run = route.endsWith("cancel")
      ? await state.cancelAutonomyRun(body.runId)
      : await state.resumeAutonomyRun(body.runId);
    if (route.endsWith("resume")) await autonomy.resumeRun(run.id);
    sendJson(response, route.endsWith("resume") ? 202 : 200, run);
    return true;
  }

  if (route === "/api/autonomy/heartbeats/create") {
    assertLocalMutation("Remote clients cannot create heartbeats.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (
      typeof body.name !== "string" ||
      typeof body.goal !== "string" ||
      typeof body.everySeconds !== "number"
    )
      throw new AutonomyError("Heartbeat name, goal, and interval are required.");
    if (
      body.projectId !== undefined &&
      body.projectId !== null &&
      typeof body.projectId !== "string"
    )
      throw new AutonomyError("Heartbeat project is invalid.");
    if (body.worktree !== undefined && body.worktree !== null && typeof body.worktree !== "string")
      throw new AutonomyError("Heartbeat worktree is invalid.");
    const heartbeat = await autonomy.addHeartbeat({
      name: body.name,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      worktree: typeof body.worktree === "string" ? body.worktree : null,
      goal: body.goal,
      everySeconds: body.everySeconds,
      flowId: typeof body.flowId === "string" ? body.flowId : undefined,
      activeHours: body.activeHours as HeartbeatMonitor["activeHours"] | undefined,
    });
    await autonomyScheduler.refresh();
    sendJson(response, 200, heartbeat);
    return true;
  }

  if (route === "/api/autonomy/heartbeats/update") {
    assertLocalMutation("Remote clients cannot update heartbeats.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (typeof body.id !== "string") throw new AutonomyError("A heartbeat is required.");
    const current = (await state.inspect()).heartbeatMonitors.find((item) => item.id === body.id);
    if (!current) throw new AutonomyError("Heartbeat not found.", 404);
    const updated = parseHeartbeatMonitor({
      ...current,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.projectId === "string" || body.projectId === null
        ? { projectId: body.projectId }
        : {}),
      ...(typeof body.worktree === "string" || body.worktree === null
        ? { worktree: body.worktree }
        : {}),
      ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
      ...(typeof body.everySeconds === "number" ? { everySeconds: body.everySeconds } : {}),
      ...(typeof body.flowId === "string" ? { flowId: body.flowId } : {}),
      ...(body.activeHours !== undefined ? { activeHours: body.activeHours } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      updatedAt: now(),
    });
    await state.saveAutonomyRecords({ heartbeatMonitors: [updated] });
    await autonomyScheduler.refresh();
    sendJson(response, 200, updated);
    return true;
  }

  if (route === "/api/autonomy/heartbeats/delete" || route === "/api/autonomy/heartbeats/run-now") {
    assertLocalMutation(
      route.endsWith("delete")
        ? "Remote clients cannot delete heartbeats."
        : "Remote clients cannot run heartbeats.",
    );
    const body = (await readJson(request)) as { id?: unknown };
    if (typeof body.id !== "string") throw new AutonomyError("A heartbeat is required.");
    if (route.endsWith("delete")) {
      await state.removeAutonomyRecord("heartbeat", body.id);
      await autonomyScheduler.refresh();
      sendJson(response, 200, { ok: true });
      return true;
    }
    const monitor = (await state.inspect()).heartbeatMonitors.find((item) => item.id === body.id);
    if (!monitor) throw new AutonomyError("Heartbeat not found.", 404);
    const run = await autonomy.startHeartbeat(monitor, "manual");
    const timestamp = now();
    await state.saveAutonomyRecords({
      heartbeatMonitors: [
        {
          ...monitor,
          lastRunAt: timestamp,
          lastRunId: run.id,
          lastStatus: "queued",
          updatedAt: timestamp,
        },
      ],
    });
    sendJson(response, 202, run);
    return true;
  }

  if (route === "/api/autonomy/standing-orders/create") {
    assertLocalMutation("Remote clients cannot create standing orders.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (
      typeof body.name !== "string" ||
      typeof body.instruction !== "string" ||
      (body.scope !== "global" && body.scope !== "project")
    )
      throw new AutonomyError("Standing order name, scope, and instruction are required.");
    sendJson(
      response,
      200,
      await autonomy.addStandingOrder({
        name: body.name,
        scope: body.scope,
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        instruction: body.instruction,
      }),
    );
    return true;
  }

  if (route === "/api/autonomy/standing-orders/update") {
    assertLocalMutation("Remote clients cannot update standing orders.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (typeof body.id !== "string") throw new AutonomyError("A standing order is required.");
    const current = (await state.inspect()).standingOrders.find((item) => item.id === body.id);
    if (!current) throw new AutonomyError("Standing order not found.", 404);
    const updated = parseStandingOrder({
      ...current,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.scope === "global" || body.scope === "project" ? { scope: body.scope } : {}),
      ...(typeof body.projectId === "string" || body.projectId === null
        ? { projectId: body.projectId }
        : {}),
      ...(typeof body.instruction === "string" ? { instruction: body.instruction } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      updatedAt: now(),
    });
    await state.saveAutonomyRecords({ standingOrders: [updated] });
    sendJson(response, 200, updated);
    return true;
  }

  if (route === "/api/autonomy/standing-orders/delete") {
    assertLocalMutation("Remote clients cannot delete standing orders.");
    const body = (await readJson(request)) as { id?: unknown };
    if (typeof body.id !== "string") throw new AutonomyError("A standing order is required.");
    await state.removeAutonomyRecord("standingOrder", body.id);
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (route === "/api/autonomy/hooks/create") {
    assertLocalMutation("Remote clients cannot create autonomy hooks.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (
      typeof body.name !== "string" ||
      typeof body.event !== "string" ||
      typeof body.flowId !== "string"
    )
      throw new AutonomyError("Hook name, event, and workflow are required.");
    const hook = await autonomy.addHook({
      name: body.name,
      event: body.event as AutonomyHookEvent,
      flowId: body.flowId,
      projectId: typeof body.projectId === "string" ? body.projectId : null,
      cooldownSeconds: typeof body.cooldownSeconds === "number" ? body.cooldownSeconds : undefined,
    });
    await autonomyScheduler.refresh();
    sendJson(response, 200, hook);
    return true;
  }

  if (route === "/api/autonomy/hooks/update") {
    assertLocalMutation("Remote clients cannot update autonomy hooks.");
    const body = (await readJson(request)) as Record<string, unknown>;
    if (typeof body.id !== "string") throw new AutonomyError("A hook is required.");
    const projection = await state.inspect();
    const current = projection.autonomyHooks.find((item) => item.id === body.id);
    if (!current) throw new AutonomyError("Hook not found.", 404);
    const updated = parseAutonomyHook({
      ...current,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.event === "string" ? { event: body.event } : {}),
      ...(typeof body.flowId === "string" ? { flowId: body.flowId } : {}),
      ...(typeof body.projectId === "string" || body.projectId === null
        ? { projectId: body.projectId }
        : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.cooldownSeconds === "number"
        ? { cooldownSeconds: body.cooldownSeconds }
        : {}),
      updatedAt: now(),
    });
    if (!projection.autonomyFlows.find((item) => item.id === updated.flowId)?.readOnly)
      throw new AutonomyError("Only built-in read-only workflows can be hooked.", 400);
    await state.saveAutonomyRecords({ hooks: [updated] });
    await autonomyScheduler.refresh();
    sendJson(response, 200, updated);
    return true;
  }

  if (route === "/api/autonomy/hooks/delete") {
    assertLocalMutation("Remote clients cannot delete autonomy hooks.");
    const body = (await readJson(request)) as { id?: unknown };
    if (typeof body.id !== "string") throw new AutonomyError("A hook is required.");
    await state.removeAutonomyRecord("hook", body.id);
    await autonomyScheduler.refresh();
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}
