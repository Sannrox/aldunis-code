import type { IncomingMessage, ServerResponse } from "node:http";
import { readCheckpointFileDiff } from "./changes.ts";
import {
  captureCheckpoint,
  checkpointDiff,
  RepositoryError,
  rewindCheckpoint,
} from "./repository.ts";
import { LocalStateError, type StateProjection, type TurnCheckpoint } from "./state.ts";

interface CheckpointRouteState {
  inspect: () => Promise<StateProjection>;
  saveCheckpoint: (
    checkpoint: Omit<TurnCheckpoint, "schemaVersion" | "updatedAt">,
  ) => Promise<TurnCheckpoint>;
}

interface CheckpointRouteContext {
  state: CheckpointRouteState;
  activeProjects: Set<string>;
  activeWorktrees: Set<string>;
  worktreeKey: (projectId: string, worktree: string) => string;
  selectWorktree: (root: string, worktree: string) => Promise<{ root: string; worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  operations?: {
    captureCheckpoint?: typeof captureCheckpoint;
    checkpointDiff?: typeof checkpointDiff;
    readCheckpointFileDiff?: typeof readCheckpointFileDiff;
    rewindCheckpoint?: typeof rewindCheckpoint;
  };
}

const CHECKPOINT_ROUTE = /^\/api\/checkpoints\/([0-9a-f-]+)\/(preview|diff|rewind)$/;

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
 * Dispatch checkpoint review and rewind through one internal interface.
 * This module owns checkpoint-to-worktree identity, active-turn exclusion,
 * Git snapshot validation, diff projection, rewind ordering, and response shaping.
 */
export async function handleCheckpointRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: CheckpointRouteContext,
): Promise<boolean> {
  const match = route.match(CHECKPOINT_ROUTE);
  if (!match) return false;
  const [, checkpointId, action] = match;
  const operations = {
    captureCheckpoint,
    checkpointDiff,
    readCheckpointFileDiff,
    rewindCheckpoint,
    ...context.operations,
  };

  if (action === "preview") {
    const body = (await context.readJson(request)) as { root?: unknown; worktree?: unknown };
    const selection = repositorySelection(body);
    const selected = await context.selectWorktree(selection.root, selection.worktree);
    const projection = await context.state.inspect();
    const checkpoint = projection.checkpoints.find(
      (item) => item.id === checkpointId && item.worktree === selected.worktree,
    );
    const thread = checkpoint
      ? projection.threads.find((item) => item.id === checkpoint.threadId)
      : undefined;
    if (
      thread &&
      (context.activeProjects.has(thread.projectId) ||
        context.activeWorktrees.has(context.worktreeKey(thread.projectId, selected.worktree)))
    ) {
      throw new LocalStateError(
        "Wait for the active turn to finish before previewing a rewind.",
        409,
      );
    }
    if (
      !checkpoint ||
      checkpoint.state !== "completed" ||
      !checkpoint.baselineIdentity ||
      !checkpoint.baselineIndexIdentity ||
      !checkpoint.baselineHead ||
      !checkpoint.completedIdentity ||
      !checkpoint.completedIndexIdentity ||
      !checkpoint.completedHead ||
      checkpoint.baselineHead !== checkpoint.completedHead
    ) {
      throw new RepositoryError("This checkpoint is unavailable for rewind.", 409);
    }
    const current = await operations.captureCheckpoint(selected.worktree, true);
    if (current.identity !== checkpoint.completedIdentity) {
      throw new RepositoryError(
        "The workspace changed after this checkpoint. Rewind is unavailable until those changes are handled.",
        409,
      );
    }
    if (current.indexIdentity !== checkpoint.completedIndexIdentity) {
      throw new RepositoryError(
        "The Git index changed after this checkpoint. Rewind is unavailable until those changes are handled.",
        409,
      );
    }
    if (current.head !== checkpoint.completedHead) {
      throw new RepositoryError(
        "HEAD changed after this checkpoint. Rewind does not rewrite Git history.",
        409,
      );
    }
    context.sendJson(response, 200, {
      checkpoint,
      currentIdentity: current.identity,
      currentIndexIdentity: current.indexIdentity,
      files: await operations.checkpointDiff(
        selected.worktree,
        checkpoint.completedIdentity,
        checkpoint.baselineIdentity,
      ),
    });
    return true;
  }

  if (action === "diff") {
    const body = (await context.readJson(request)) as {
      root?: unknown;
      worktree?: unknown;
      path?: unknown;
    };
    const selection = repositorySelection(body);
    if (typeof body.path !== "string") {
      throw new RepositoryError("A repository, worktree, and changed path are required.");
    }
    const selected = await context.selectWorktree(selection.root, selection.worktree);
    const projection = await context.state.inspect();
    const checkpoint = projection.checkpoints.find(
      (item) => item.id === checkpointId && item.worktree === selected.worktree,
    );
    const thread = checkpoint
      ? projection.threads.find((item) => item.id === checkpoint.threadId)
      : undefined;
    if (!thread) throw new LocalStateError("The checkpoint conversation is unavailable.", 404);
    if (
      !checkpoint ||
      (checkpoint.state !== "completed" && checkpoint.state !== "superseded") ||
      !checkpoint.baselineIdentity ||
      !checkpoint.completedIdentity
    ) {
      throw new RepositoryError("This turn diff is unavailable.", 409);
    }
    const files = checkpoint.files?.length
      ? checkpoint.files
      : await operations.checkpointDiff(
          selected.worktree,
          checkpoint.baselineIdentity,
          checkpoint.completedIdentity,
        );
    context.sendJson(
      response,
      200,
      await operations.readCheckpointFileDiff(
        selected.worktree,
        checkpoint.baselineIdentity,
        checkpoint.completedIdentity,
        body.path,
        files,
      ),
    );
    return true;
  }

  const body = (await context.readJson(request)) as {
    root?: unknown;
    worktree?: unknown;
    currentIdentity?: unknown;
    currentIndexIdentity?: unknown;
    confirm?: unknown;
  };
  const selection = repositorySelection(body);
  if (
    typeof body.currentIdentity !== "string" ||
    typeof body.currentIndexIdentity !== "string" ||
    body.confirm !== true
  ) {
    throw new RepositoryError("Preview and confirm the exact rewind before continuing.");
  }
  const selected = await context.selectWorktree(selection.root, selection.worktree);
  const projection = await context.state.inspect();
  const checkpoint = projection.checkpoints.find(
    (item) => item.id === checkpointId && item.worktree === selected.worktree,
  );
  const thread = checkpoint
    ? projection.threads.find((item) => item.id === checkpoint.threadId)
    : undefined;
  const rewindLock = thread ? context.worktreeKey(thread.projectId, selected.worktree) : null;
  if (
    thread &&
    (context.activeProjects.has(thread.projectId) ||
      (rewindLock && context.activeWorktrees.has(rewindLock)))
  ) {
    throw new LocalStateError("Wait for the active turn to finish before rewinding.", 409);
  }
  if (
    !checkpoint ||
    checkpoint.state !== "completed" ||
    !checkpoint.baselineIdentity ||
    !checkpoint.baselineIndexIdentity ||
    !checkpoint.baselineHead ||
    !checkpoint.completedIdentity ||
    !checkpoint.completedIndexIdentity ||
    !checkpoint.completedHead ||
    checkpoint.baselineHead !== checkpoint.completedHead ||
    body.currentIdentity !== checkpoint.completedIdentity ||
    body.currentIndexIdentity !== checkpoint.completedIndexIdentity
  ) {
    throw new RepositoryError("This checkpoint is unavailable for rewind.", 409);
  }
  if (!thread || !rewindLock) {
    throw new LocalStateError("The checkpoint conversation is unavailable.", 409);
  }
  context.activeWorktrees.add(rewindLock);
  let files;
  try {
    files = await operations.rewindCheckpoint(
      selected.worktree,
      body.currentIdentity,
      body.currentIndexIdentity,
      checkpoint.completedHead,
      checkpoint.baselineIdentity,
      checkpoint.baselineIndexIdentity,
    );
    await context.state.saveCheckpoint({
      ...checkpoint,
      state: "superseded",
      message: "Workspace rewound to this turn's baseline.",
    });
  } finally {
    context.activeWorktrees.delete(rewindLock);
  }
  context.sendJson(response, 200, { status: "rewound", files });
  return true;
}
