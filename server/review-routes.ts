import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  annotationView,
  captureAnnotationContext,
  formatRevisionContext,
  MAX_ANNOTATION_TEXT,
} from "./annotations.ts";
import type { ChangedFile, FileDiff } from "./changes.ts";
import { LocalStateError, type LocalStateStore, type StateProjection } from "./state.ts";
import { RepositoryError } from "./repository.ts";

interface ReviewChangesAdapter {
  listChangedFiles: (worktree: string, signal?: AbortSignal) => Promise<ChangedFile[]>;
  listChangedFilesPage: (
    worktree: string,
    signal?: AbortSignal,
  ) => Promise<{ files: ChangedFile[]; truncated: boolean }>;
  readFileDiff: (
    worktree: string,
    path: string,
    changedFiles?: readonly ChangedFile[],
  ) => Promise<FileDiff>;
}

interface ReviewRouteContext {
  state: Pick<
    LocalStateStore,
    "inspect" | "saveAnnotation" | "setAnnotationResolution" | "setFileReview"
  >;
  changes: ReviewChangesAdapter;
  managed: boolean;
  assertManagedThread: (projection: StateProjection, threadId: string) => unknown;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  createId?: () => string;
  now?: () => string;
}

const REVIEW_ROUTES = new Set([
  "/api/changes",
  "/api/changes/diff",
  "/api/reviews/set",
  "/api/annotations/list",
  "/api/annotations/create",
  "/api/annotations/preview",
]);
const ANNOTATION_RESOLUTION_ROUTE = /^\/api\/annotations\/([0-9a-f-]+)\/resolution$/;

async function withRequestCancellation<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortUnfinishedResponse = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abortUnfinishedResponse);
  if (request.aborted || (response.destroyed && !response.writableEnded)) controller.abort();
  try {
    return await operation(controller.signal);
  } finally {
    request.off("aborted", abort);
    response.off("close", abortUnfinishedResponse);
  }
}

/**
 * Dispatch changed-file review routes behind one interface. The module owns
 * request validation, repository and conversation scope, current-diff
 * identity, annotation projection, and persistence ordering.
 */
export async function handleReviewRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ReviewRouteContext,
): Promise<boolean> {
  const resolutionMatch = route.match(ANNOTATION_RESOLUTION_ROUTE);
  if (!REVIEW_ROUTES.has(route) && !resolutionMatch) return false;

  const { state, changes, managed, assertManagedThread, selectWorktree, readJson, sendJson } =
    context;

  const resolveConversation = async (body: {
    root?: unknown;
    worktree?: unknown;
    threadId?: unknown;
  }) => {
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.threadId !== "string"
    ) {
      throw new RepositoryError("A repository, worktree, and conversation are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    const projection = await state.inspect();
    const project = projection.projects.find((item) => item.root === selected.root);
    const thread = projection.threads.find(
      (item) =>
        item.id === body.threadId &&
        item.projectId === project?.id &&
        item.worktree === selected.worktree,
    );
    if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
    return { selected, projection, thread };
  };

  if (route === "/api/changes") {
    const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
    if (typeof body.root !== "string" || typeof body.worktree !== "string") {
      throw new RepositoryError("A repository and worktree are required.");
    }
    await withRequestCancellation(request, response, async (signal) => {
      const selected = await selectWorktree(body.root, body.worktree);
      signal.throwIfAborted();
      const { files, truncated } = await changes.listChangedFilesPage(selected.worktree, signal);
      signal.throwIfAborted();
      sendJson(response, 200, { files, truncated });
    });
    return true;
  }

  if (route === "/api/changes/diff") {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      path?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.path !== "string"
    ) {
      throw new RepositoryError("A repository, worktree, and changed file are required.");
    }
    const selected = await selectWorktree(body.root, body.worktree);
    sendJson(response, 200, await changes.readFileDiff(selected.worktree, body.path));
    return true;
  }

  if (route === "/api/reviews/set") {
    const body = (await readJson(request)) as {
      threadId?: unknown;
      path?: unknown;
      previousPath?: unknown;
      diffIdentity?: unknown;
      reviewed?: unknown;
    };
    if (
      typeof body.threadId !== "string" ||
      typeof body.path !== "string" ||
      typeof body.diffIdentity !== "string" ||
      typeof body.reviewed !== "boolean" ||
      (body.previousPath !== undefined &&
        body.previousPath !== null &&
        typeof body.previousPath !== "string")
    ) {
      throw new LocalStateError(
        "A conversation, file path, content identity, and reviewed flag are required.",
        400,
      );
    }
    if (managed) assertManagedThread(await state.inspect(), body.threadId);
    sendJson(
      response,
      200,
      await state.setFileReview({
        threadId: body.threadId,
        path: body.path,
        previousPath: typeof body.previousPath === "string" ? body.previousPath : null,
        diffIdentity: body.diffIdentity,
        reviewed: body.reviewed,
      }),
    );
    return true;
  }

  if (route === "/api/annotations/list") {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      threadId?: unknown;
    };
    const { selected, projection, thread } = await resolveConversation(body);
    const annotations = projection.annotations.filter((item) => item.threadId === thread.id);
    const diffs = new Map<string, FileDiff | null>();
    const changedFiles =
      annotations.length > 0 ? await changes.listChangedFiles(selected.worktree) : [];
    for (const path of new Set(annotations.map((item) => item.path))) {
      try {
        diffs.set(path, await changes.readFileDiff(selected.worktree, path, changedFiles));
      } catch {
        diffs.set(path, null);
      }
    }
    sendJson(response, 200, {
      annotations: annotations.map((item) => annotationView(item, diffs.get(item.path) ?? null)),
    });
    return true;
  }

  if (route === "/api/annotations/create") {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      threadId?: unknown;
      path?: unknown;
      diffIdentity?: unknown;
      scope?: unknown;
      lineIndex?: unknown;
      text?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.path !== "string" ||
      typeof body.diffIdentity !== "string" ||
      (body.scope !== "file" && body.scope !== "line") ||
      (body.scope === "line" &&
        (!Number.isInteger(body.lineIndex) || (body.lineIndex as number) < 0)) ||
      typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.trim().length > MAX_ANNOTATION_TEXT
    ) {
      throw new RepositoryError("A valid annotation target and comment are required.");
    }
    const { selected, projection, thread } = await resolveConversation(body);
    const diff = await changes.readFileDiff(selected.worktree, body.path);
    if (diff.identity !== body.diffIdentity) {
      throw new RepositoryError(
        "The diff changed before the annotation was saved. Refresh and select it again.",
        409,
      );
    }
    const lineIndex = body.scope === "line" ? (body.lineIndex as number) : null;
    const line = lineIndex === null ? null : diff.lines.find((item) => item.index === lineIndex);
    if (body.scope === "line" && (!line || line.side === "metadata")) {
      throw new RepositoryError("Select an added, deleted, or context line.", 409);
    }
    const checkpoint = projection.checkpoints
      .filter((item) => item.threadId === thread.id && item.state === "completed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const now = context.now?.() ?? new Date().toISOString();
    sendJson(
      response,
      201,
      await state.saveAnnotation({
        id: context.createId?.() ?? randomUUID(),
        threadId: thread.id,
        checkpointId: checkpoint?.id ?? null,
        diffIdentity: diff.identity,
        path: diff.path,
        previousPath: diff.previousPath,
        targetState: diff.state,
        scope: body.scope,
        side: line?.side ?? null,
        oldLine: line?.oldLine ?? null,
        newLine: line?.newLine ?? null,
        text: body.text.trim(),
        capturedContext: captureAnnotationContext(diff, lineIndex),
        resolution: "unresolved",
        createdAt: now,
      }),
    );
    return true;
  }

  if (resolutionMatch) {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      threadId?: unknown;
      resolved?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.threadId !== "string" ||
      typeof body.resolved !== "boolean"
    ) {
      throw new RepositoryError(
        "A repository, worktree, conversation, and resolution state are required.",
      );
    }
    const { thread } = await resolveConversation(body);
    sendJson(
      response,
      200,
      await state.setAnnotationResolution(
        resolutionMatch[1],
        thread.id,
        body.resolved ? "resolved" : "unresolved",
      ),
    );
    return true;
  }

  if (route === "/api/annotations/preview") {
    const body = (await readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      threadId?: unknown;
      annotationIds?: unknown;
    };
    if (
      typeof body.root !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.threadId !== "string" ||
      !Array.isArray(body.annotationIds) ||
      body.annotationIds.some((id) => typeof id !== "string")
    ) {
      throw new RepositoryError("A conversation and selected annotations are required.");
    }
    const { selected: selectedWorktree, projection, thread } = await resolveConversation(body);
    const requested = new Set(body.annotationIds as string[]);
    const selected = projection.annotations.filter(
      (item) => item.threadId === thread.id && requested.has(item.id),
    );
    if (selected.length !== requested.size) {
      throw new LocalStateError("One or more selected annotations are unavailable.", 404);
    }
    const diffs = new Map<string, FileDiff | null>();
    const changedFiles = await changes.listChangedFiles(selectedWorktree.worktree);
    for (const path of new Set(selected.map((item) => item.path))) {
      let current = null;
      try {
        current = await changes.readFileDiff(selectedWorktree.worktree, path, changedFiles);
      } catch {
        // Missing and no-longer-changed targets are represented as stale.
      }
      diffs.set(path, current);
    }
    const views = selected.map((item) => annotationView(item, diffs.get(item.path) ?? null));
    sendJson(response, 200, { prompt: formatRevisionContext(views), annotations: views });
    return true;
  }

  return false;
}
