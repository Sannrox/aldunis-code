import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreferencesStore } from "./preferences.ts";
import { LocalStateError, type LocalStateStore, type StateProjection } from "./state.ts";
import type { WorktreeManager } from "./worktrees.ts";

type DelegatedControlLock = <T>(action: () => Promise<T>) => Promise<T>;

interface ConversationLifecycleRouteContext {
  state: Pick<
    LocalStateStore,
    | "inspect"
    | "renameConversation"
    | "setConversationPinned"
    | "archiveConversation"
    | "restoreConversation"
    | "settleConversation"
    | "unsettleConversation"
    | "snoozeConversation"
    | "unsnoozeConversation"
    | "markConversationVisited"
    | "previewConversationDeletion"
    | "deleteConversation"
    | "linkDelegatedConversation"
    | "unlinkDelegatedConversation"
  >;
  preferences: Pick<PreferencesStore, "load">;
  worktrees: Pick<WorktreeManager, "releaseManagedPath">;
  managed: boolean;
  assertManagedThread: (
    projection: StateProjection,
    threadId: string,
  ) => {
    thread: StateProjection["threads"][number];
    project: StateProjection["projects"][number];
  };
  selectManagedWorktree: (root: string, worktree: string) => Promise<unknown>;
  withDelegatedControlLock: DelegatedControlLock;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const ROUTES = new Set([
  "/api/state/conversations/rename",
  "/api/state/conversations/pin",
  "/api/state/conversations/archive",
  "/api/state/conversations/restore",
  "/api/state/conversations/settle",
  "/api/state/conversations/unsettle",
  "/api/state/conversations/snooze",
  "/api/state/conversations/unsnooze",
  "/api/state/conversations/visit",
  "/api/state/conversations/release-worktree",
  "/api/state/conversations/delete/preview",
  "/api/state/conversations/delete",
  "/api/state/delegated-conversations/link",
  "/api/state/delegated-conversations/unlink",
]);

/**
 * Dispatch conversation lifecycle routes behind one interface. The module owns
 * request validation, managed-host admission, explicit worktree release guards,
 * deletion ordering, and delegated relationship admission.
 */
export async function handleConversationLifecycleRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ConversationLifecycleRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const {
    state,
    preferences,
    worktrees,
    managed,
    assertManagedThread,
    selectManagedWorktree,
    withDelegatedControlLock,
    readJson,
    sendJson,
  } = context;

  const requireThreadId = (body: { threadId?: unknown }): string => {
    if (typeof body.threadId !== "string") {
      throw new LocalStateError("A conversation is required.", 400);
    }
    return body.threadId;
  };
  const admitManagedThread = async (threadId: string) => {
    if (managed) assertManagedThread(await state.inspect(), threadId);
  };

  if (route === "/api/state/conversations/rename") {
    const body = (await readJson(request)) as { threadId?: unknown; title?: unknown };
    if (typeof body.threadId !== "string" || typeof body.title !== "string") {
      throw new LocalStateError("A conversation and title are required.", 400);
    }
    await admitManagedThread(body.threadId);
    sendJson(response, 200, await state.renameConversation(body.threadId, body.title));
    return true;
  }
  if (route === "/api/state/conversations/pin") {
    const body = (await readJson(request)) as { threadId?: unknown; pinned?: unknown };
    if (typeof body.threadId !== "string" || typeof body.pinned !== "boolean") {
      throw new LocalStateError("A conversation and pin state are required.", 400);
    }
    await admitManagedThread(body.threadId);
    sendJson(response, 200, await state.setConversationPinned(body.threadId, body.pinned));
    return true;
  }

  const simpleTransitions = new Map<string, (threadId: string) => Promise<unknown>>([
    ["/api/state/conversations/archive", (id) => state.archiveConversation(id)],
    ["/api/state/conversations/restore", (id) => state.restoreConversation(id)],
    ["/api/state/conversations/settle", (id) => state.settleConversation(id)],
    ["/api/state/conversations/unsettle", (id) => state.unsettleConversation(id)],
    ["/api/state/conversations/unsnooze", (id) => state.unsnoozeConversation(id)],
    ["/api/state/conversations/visit", (id) => state.markConversationVisited(id)],
  ]);
  const transition = simpleTransitions.get(route);
  if (transition) {
    const threadId = requireThreadId((await readJson(request)) as { threadId?: unknown });
    await admitManagedThread(threadId);
    sendJson(response, 200, await transition(threadId));
    return true;
  }

  if (route === "/api/state/conversations/snooze") {
    const body = (await readJson(request)) as { threadId?: unknown; snoozedUntil?: unknown };
    const threadId = requireThreadId(body);
    if (typeof body.snoozedUntil !== "string") {
      throw new LocalStateError("A snooze wake time is required.", 400);
    }
    await admitManagedThread(threadId);
    sendJson(response, 200, await state.snoozeConversation(threadId, body.snoozedUntil));
    return true;
  }

  if (route === "/api/state/conversations/release-worktree") {
    const body = (await readJson(request)) as { threadId?: unknown; confirm?: unknown };
    if (typeof body.threadId !== "string" || body.confirm !== true) {
      throw new LocalStateError("A confirmed conversation worktree release is required.", 400);
    }
    const projection = await state.inspect();
    const thread = projection.threads.find((item) => item.id === body.threadId);
    if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
    const project = projection.projects.find((item) => item.id === thread.projectId);
    if (managed) {
      assertManagedThread(projection, thread.id);
      if (!project) throw new LocalStateError("The selected conversation is not available.", 404);
      await selectManagedWorktree(project.root, thread.worktree);
    }
    const blocking = projection.turns.find(
      (turn) =>
        turn.threadId === thread.id &&
        ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status),
    );
    if (blocking) {
      throw new LocalStateError(
        "This conversation cannot release its worktree while provider work is active. Stop or resolve it, then retry.",
        409,
      );
    }
    const result = await worktrees.releaseManagedPath(thread.worktree);
    const { preferences: currentPreferences } = await preferences.load();
    sendJson(response, 200, {
      threadId: thread.id,
      released: result.released,
      managedWorktreeCount: result.count,
      managedWorktreeLimit: currentPreferences.managedWorktreeLimit,
    });
    return true;
  }

  if (route === "/api/state/conversations/delete/preview") {
    const threadId = requireThreadId((await readJson(request)) as { threadId?: unknown });
    await admitManagedThread(threadId);
    sendJson(response, 200, {
      threadId,
      affectedRecords: await state.previewConversationDeletion(threadId),
      excluded: ["repository", "worktree", "branch", "provider credentials", "remote content"],
    });
    return true;
  }
  if (route === "/api/state/conversations/delete") {
    const body = (await readJson(request)) as { threadId?: unknown; confirm?: unknown };
    if (typeof body.threadId !== "string" || body.confirm !== true) {
      throw new LocalStateError("A confirmed conversation deletion is required.", 400);
    }
    sendJson(
      response,
      200,
      await withDelegatedControlLock(async () => {
        await admitManagedThread(body.threadId as string);
        return state.deleteConversation(body.threadId as string);
      }),
    );
    return true;
  }

  const body = (await readJson(request)) as {
    parentThreadId?: unknown;
    childThreadId?: unknown;
  };
  if (typeof body.parentThreadId !== "string" || typeof body.childThreadId !== "string") {
    throw new LocalStateError("A parent and child conversation are required.", 400);
  }
  const mutateRelationship = async () => {
    const { preferences: currentPreferences } = await preferences.load();
    if (!currentPreferences.orchestrationThreadsBeta) {
      throw new LocalStateError("Orchestration threads beta is disabled.", 403);
    }
    if (managed) {
      const projection = await state.inspect();
      assertManagedThread(projection, body.parentThreadId as string);
      assertManagedThread(projection, body.childThreadId as string);
    }
    if (route === "/api/state/delegated-conversations/link") {
      return state.linkDelegatedConversation(
        body.parentThreadId as string,
        body.childThreadId as string,
      );
    }
    await state.unlinkDelegatedConversation(
      body.parentThreadId as string,
      body.childThreadId as string,
    );
    return { status: "unlinked" };
  };
  sendJson(response, 200, await withDelegatedControlLock(mutateRelationship));
  return true;
}
