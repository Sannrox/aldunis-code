import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AutomationError,
  type AutomationSchedule,
  type AutomationScheduler,
  type AutomationStore,
} from "./automations.ts";
import type { InteractionMode } from "./provider.ts";
import type { LocalStateStore } from "./state.ts";

export interface AutomationRouteContext {
  automations: AutomationStore;
  automationScheduler: AutomationScheduler;
  state: LocalStateStore;
  remoteRequest: boolean;
  managed: boolean;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const AUTOMATION_ROUTES = new Set([
  "/api/automations/list",
  "/api/automations/create",
  "/api/automations/update",
  "/api/automations/delete",
  "/api/automations/run-now",
]);

/** Dispatches timer-only Conversation Automation routes without granting new authority. */
export async function handleAutomationRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: AutomationRouteContext,
): Promise<boolean> {
  if (!AUTOMATION_ROUTES.has(route)) return false;
  const { automations, automationScheduler, state, remoteRequest, managed, readJson, sendJson } =
    context;
  const assertLocalMutation = (message: string) => {
    if (remoteRequest || managed) throw new AutomationError(message, 403);
  };

  if (route === "/api/automations/list") {
    if (managed) {
      sendJson(response, 200, { automations: [] });
      return true;
    }
    const items = await automations.list();
    sendJson(response, 200, {
      automations: await Promise.all(
        items.map(async (automation) => ({
          ...automation,
          lastFire: await state.latestAutomationFire(automation.id),
        })),
      ),
    });
    return true;
  }

  if (route === "/api/automations/create") {
    assertLocalMutation("Remote clients cannot create automations.");
    const body = (await readJson(request)) as {
      name?: unknown;
      threadId?: unknown;
      prompt?: unknown;
      mode?: unknown;
      enabled?: unknown;
      schedule?: unknown;
    };
    if (
      typeof body.name !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.prompt !== "string" ||
      !body.schedule ||
      typeof body.schedule !== "object"
    ) {
      throw new AutomationError("name, threadId, prompt, and schedule are required.");
    }
    const projection = await state.inspect();
    if (!projection.threads.some((thread) => thread.id === body.threadId)) {
      throw new AutomationError("Target conversation was not found.", 404);
    }
    const automation = await automations.create({
      name: body.name,
      threadId: body.threadId,
      prompt: body.prompt,
      mode: body.mode as InteractionMode | undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      schedule: body.schedule as AutomationSchedule,
    });
    await automationScheduler.refresh();
    sendJson(response, 200, automation);
    return true;
  }

  if (route === "/api/automations/update") {
    assertLocalMutation("Remote clients cannot update automations.");
    const body = (await readJson(request)) as {
      id?: unknown;
      name?: unknown;
      prompt?: unknown;
      mode?: unknown;
      enabled?: unknown;
      schedule?: unknown;
    };
    if (typeof body.id !== "string") throw new AutomationError("Automation id is required.");
    const automation = await automations.update(body.id, {
      name: typeof body.name === "string" ? body.name : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      mode: body.mode as InteractionMode | undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      schedule: body.schedule as AutomationSchedule | undefined,
    });
    await automationScheduler.refresh();
    sendJson(response, 200, automation);
    return true;
  }

  if (route === "/api/automations/delete") {
    assertLocalMutation("Remote clients cannot delete automations.");
    const body = (await readJson(request)) as { id?: unknown };
    if (typeof body.id !== "string") throw new AutomationError("Automation id is required.");
    await automations.remove(body.id);
    await automationScheduler.refresh();
    sendJson(response, 200, { ok: true });
    return true;
  }

  assertLocalMutation("Remote clients cannot run automations.");
  const body = (await readJson(request)) as {
    id?: unknown;
    idempotencyKey?: unknown;
    retryOf?: unknown;
  };
  if (typeof body.id !== "string") throw new AutomationError("Automation id is required.");
  if (
    body.idempotencyKey !== undefined &&
    (typeof body.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.idempotencyKey))
  ) {
    throw new AutomationError("A bounded automation idempotency key is required.");
  }
  if (
    body.retryOf !== undefined &&
    (typeof body.retryOf !== "string" || !/^[0-9a-f-]{36}$/i.test(body.retryOf))
  ) {
    throw new AutomationError("A valid automation fire retry identity is required.");
  }
  if (typeof body.retryOf === "string") {
    const original = await state.getAutomationFireById(body.retryOf);
    if (!original || original.automationId !== body.id || original.status !== "unknown") {
      throw new AutomationError("Only an unknown fire for this automation can be retried.", 409);
    }
  }
  const result = await automationScheduler.runNow(
    body.id,
    typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
    typeof body.retryOf === "string" ? body.retryOf : null,
  );
  sendJson(response, 200, {
    ...result,
    lastFire: await state.latestAutomationFire(result.id),
  });
  return true;
}
