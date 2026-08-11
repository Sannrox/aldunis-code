import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assembleContextPackage,
  browseRepositoryFiles,
  previewRepositoryFile,
  resolveWorktreeImagePath,
  searchRepositoryFiles,
  stageComposerImage,
  stageWorktreeImageCopy,
  type ContextPin,
} from "./context.ts";
import { RepositoryError } from "./repository.ts";

export const MAX_STAGE_IMAGE_BODY_BYTES = 3 * 1024 * 1024;

interface ContextRouteContext {
  remote: boolean;
  managed: boolean;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage, maxBytes?: number) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  operations?: {
    assembleContextPackage?: typeof assembleContextPackage;
    browseRepositoryFiles?: typeof browseRepositoryFiles;
    previewRepositoryFile?: typeof previewRepositoryFile;
    resolveWorktreeImagePath?: typeof resolveWorktreeImagePath;
    searchRepositoryFiles?: typeof searchRepositoryFiles;
    stageComposerImage?: typeof stageComposerImage;
    stageWorktreeImageCopy?: typeof stageWorktreeImageCopy;
  };
}

const ROUTES = new Set([
  "/api/context/files",
  "/api/context/browse",
  "/api/context/preview",
  "/api/context/stage-image",
  "/api/context/package/preview",
]);

function repositorySelection(body: { root?: unknown; worktree?: unknown }): {
  root: string;
  worktree: string;
} {
  if (typeof body.root !== "string" || typeof body.worktree !== "string") {
    throw new RepositoryError("A repository and worktree are required.");
  }
  return { root: body.root, worktree: body.worktree };
}

/**
 * Dispatch the closed ConversationContextPin route family behind one interface.
 * This module owns request admission, canonical worktree selection, remote and
 * managed restrictions, cancellation, staging policy, and response shaping.
 */
export async function handleContextRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ContextRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const operations = {
    assembleContextPackage,
    browseRepositoryFiles,
    previewRepositoryFile,
    resolveWorktreeImagePath,
    searchRepositoryFiles,
    stageComposerImage,
    stageWorktreeImageCopy,
    ...context.operations,
  };

  if (route === "/api/context/files" || route === "/api/context/browse") {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      query?: unknown;
    };
    const selection = repositorySelection(body);
    if (typeof body.query !== "string") {
      throw new RepositoryError(
        route.endsWith("/files")
          ? "A repository, worktree, and file query are required."
          : "A repository, worktree, and search query are required.",
      );
    }
    const selected = await context.selectWorktree(selection.root, selection.worktree);
    if (route.endsWith("/files")) {
      context.sendJson(response, 200, {
        files: await operations.searchRepositoryFiles(selected.worktree, body.query),
      });
      return true;
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    context.sendJson(
      response,
      200,
      await operations.browseRepositoryFiles(selected.worktree, body.query, controller.signal),
    );
    return true;
  }

  if (route === "/api/context/preview") {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      path?: unknown;
    };
    const selection = repositorySelection(body);
    if (typeof body.path !== "string") {
      throw new RepositoryError(
        "A repository, worktree, and repository-relative path are required.",
      );
    }
    const selected = await context.selectWorktree(selection.root, selection.worktree);
    context.sendJson(response, 200, {
      preview: await operations.previewRepositoryFile(selected.worktree, body.path),
    });
    return true;
  }

  if (route === "/api/context/stage-image") {
    const body = (await context.readJson(request, MAX_STAGE_IMAGE_BODY_BYTES)) as {
      root?: unknown;
      worktree?: unknown;
      mediaType?: unknown;
      data?: unknown;
      name?: unknown;
      conversationId?: unknown;
      absolutePath?: unknown;
    };
    const selection = repositorySelection(body);
    if (typeof body.absolutePath === "string" && body.absolutePath) {
      if (context.remote || context.managed) {
        throw new RepositoryError(
          "Remote and managed hosts cannot pin absolute desktop paths; drop or paste the image bytes instead.",
          403,
        );
      }
      const selected = await context.selectWorktree(selection.root, selection.worktree);
      const resolved = await operations.resolveWorktreeImagePath(
        selected.worktree,
        body.absolutePath,
      );
      if (resolved) {
        context.sendJson(response, 200, { attachment: resolved, staged: false });
        return true;
      }
      const stagedCopy = await operations.stageWorktreeImageCopy(
        selected.worktree,
        body.absolutePath,
        typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {},
      );
      if (!stagedCopy) {
        throw new RepositoryError(
          "The dropped file is outside the selected worktree or is not a supported image.",
          400,
        );
      }
      context.sendJson(response, 200, { attachment: stagedCopy, staged: true });
      return true;
    }
    if (typeof body.mediaType !== "string" || typeof body.data !== "string") {
      throw new RepositoryError("Image media type and base64 data are required.");
    }
    const selected = await context.selectWorktree(selection.root, selection.worktree);
    const staged = await operations.stageComposerImage(selected.worktree, {
      mediaType: body.mediaType,
      data: body.data,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
    });
    context.sendJson(response, 200, { attachment: staged, staged: true });
    return true;
  }

  const body = (await context.readJson(request)) as {
    root?: unknown;
    worktree?: unknown;
    pins?: unknown;
  };
  const selection = repositorySelection(body);
  if (
    !Array.isArray(body.pins) ||
    body.pins.length > 100 ||
    body.pins.some(
      (pin) =>
        typeof pin !== "object" ||
        pin === null ||
        typeof (pin as { path?: unknown }).path !== "string" ||
        !["file", "folder"].includes(String((pin as { kind?: unknown }).kind)),
    )
  ) {
    throw new RepositoryError("A repository, worktree, and bounded context pin list are required.");
  }
  const pins = body.pins as ContextPin[];
  if (context.remote && pins.some((pin) => pin.kind === "folder")) {
    throw new RepositoryError(
      "Remote folder pinning requires an authenticated repository grant and is unavailable.",
      403,
    );
  }
  const selected = await context.selectWorktree(selection.root, selection.worktree);
  const assembled = await operations.assembleContextPackage(selected.worktree, pins, {
    includeProviderInstructions: !context.remote && !context.managed,
  });
  context.sendJson(response, 200, {
    package: {
      pins: assembled.pins,
      entries: assembled.entries,
      totalBytes: assembled.totalBytes,
      estimatedTokens: assembled.estimatedTokens,
      digest: assembled.digest,
    },
  });
  return true;
}
