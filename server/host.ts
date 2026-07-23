import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeAdapter,
  type InteractionMode,
  ProviderProtocolError,
} from "./provider.ts";
import { listChangedFiles, readFileDiff } from "./changes.ts";
import { DeliveryBroker, inspectDelivery, type DeliveryAction } from "./delivery.ts";
import { PermissionBroker, PermissionError } from "./permission.ts";
import {
  canonicalizeRepositoryRoot,
  captureCheckpoint,
  checkpointGitDirectory,
  checkpointReference,
  checkpointDiff,
  deleteCheckpointReferences,
  discoverWorktrees,
  openRepository,
  RepositoryError,
  rewindCheckpoint,
} from "./repository.ts";
import { LocalStateError, LocalStateStore } from "./state.ts";
import {
  CLAUDE_MODEL_ALIASES,
  ClaudeProfileStore,
  ProfileError,
  type ProfileProbeKind,
} from "./profiles.ts";
import {
  browseRepositoryFiles,
  composePrompt,
  previewRepositoryFile,
  resolveContextAttachments,
  searchRepositoryFiles,
} from "./context.ts";
import { PreviewError, PreviewManager } from "./preview.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 128 * 1024;
const activeCheckpointProjects = new Set<string>();

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    const addressType = isIP(host);
    const detail = addressType ? `IP address ${host}` : `host ${host}`;
    throw new Error(`Refusing non-loopback bind to ${detail}.`);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RepositoryError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RepositoryError("Request body must be valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

async function selectedWorktree(
  rootInput: string,
  worktreeInput: string,
): Promise<{ root: string; worktree: string }> {
  const root = await canonicalizeRepositoryRoot(rootInput);
  const selected = await realpath(worktreeInput);
  const worktrees = await discoverWorktrees(root);
  const allowed = await Promise.all(worktrees.map(async (worktree) => {
    try {
      return await realpath(worktree.path);
    } catch {
      return null;
    }
  }));
  if (!allowed.includes(selected)) {
    throw new RepositoryError("Select a discovered worktree from the opened repository.", 403);
  }
  return { root, worktree: selected };
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  provider: ClaudeCodeAdapter,
  permissions: PermissionBroker,
  delivery: DeliveryBroker,
  state: LocalStateStore,
  profiles: ClaudeProfileStore,
  previews: PreviewManager,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (!route.startsWith("/api/")) return false;
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return true;
  }
  if (!isLoopbackOrigin(request)) {
    sendJson(response, 403, { error: "Repository access is limited to the local application." });
    return true;
  }

  try {
    if (route === "/api/repositories/open") {
      const body = await readJson(request) as { path?: unknown };
      if (typeof body.path !== "string") {
        throw new RepositoryError("A repository path is required.");
      }
      const repository = await openRepository(body.path);
      const projection = await state.load();
      const existing = projection.projects.find((project) => project.root === repository.root);
      const project = await state.saveProject({
        id: existing?.id ?? randomUUID(),
        name: repository.name,
        root: repository.root,
      });
      sendJson(response, 200, { ...repository, projectId: project.id });
      return true;
    }
    if (route === "/api/state/load") {
      sendJson(response, 200, await state.load());
      return true;
    }
    if (route === "/api/state/projects/delete") {
      const body = await readJson(request) as { projectId?: unknown };
      if (typeof body.projectId !== "string") {
        throw new RepositoryError("A project is required.");
      }
      const projection = await state.load();
      if (activeCheckpointProjects.has(body.projectId)) {
        throw new LocalStateError("Wait for the active turn to finish before deleting this project.", 409);
      }
      activeCheckpointProjects.add(body.projectId);
      try {
        const threadIds = new Set(
          projection.threads.filter((thread) => thread.projectId === body.projectId).map((thread) => thread.id),
        );
        const checkpoints = projection.checkpoints.filter((item) => threadIds.has(item.threadId));
        for (const checkpoint of checkpoints) {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "unavailable",
            message: "Checkpoint cleanup is pending project deletion.",
          });
        }
        for (const checkpoint of checkpoints) {
          if (checkpoint.gitDirectory) {
            await deleteCheckpointReferences(checkpoint.gitDirectory, checkpoint.id);
          }
        }
        await state.deleteProject(body.projectId);
      } finally {
        activeCheckpointProjects.delete(body.projectId);
      }
      sendJson(response, 200, { status: "deleted" });
      return true;
    }
    if (route === "/api/state/retention") {
      const body = await readJson(request) as { olderThan?: unknown };
      if (typeof body.olderThan !== "string" || Number.isNaN(Date.parse(body.olderThan))) {
        throw new RepositoryError("A valid retention cutoff is required.");
      }
      const cutoff = new Date(body.olderThan);
      const projection = await state.load();
      const expiredThreads = new Set(
        projection.threads.filter((thread) => new Date(thread.updatedAt) < cutoff).map((thread) => thread.id),
      );
      const expiredProjectIds = new Set(
        projection.threads
          .filter((thread) => expiredThreads.has(thread.id))
          .map((thread) => thread.projectId),
      );
      if ([...expiredProjectIds].some((projectId) => activeCheckpointProjects.has(projectId))) {
        throw new LocalStateError("Retention cannot run while an affected project has an active turn.", 409);
      }
      for (const projectId of expiredProjectIds) activeCheckpointProjects.add(projectId);
      try {
        const checkpoints = projection.checkpoints.filter((item) => expiredThreads.has(item.threadId));
        for (const checkpoint of checkpoints) {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "unavailable",
            message: "Checkpoint cleanup is pending retention.",
          });
        }
        for (const checkpoint of checkpoints) {
          if (checkpoint.gitDirectory) {
            await deleteCheckpointReferences(checkpoint.gitDirectory, checkpoint.id);
          }
        }
        await state.enforceRetention(cutoff);
      } finally {
        for (const projectId of expiredProjectIds) activeCheckpointProjects.delete(projectId);
      }
      sendJson(response, 200, { status: "compacted" });
      return true;
    }
    const previewMatch = route.match(/^\/api\/checkpoints\/([0-9a-f-]+)\/preview$/);
    if (previewMatch) {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const checkpoint = projection.checkpoints.find(
        (item) => item.id === previewMatch[1] && item.worktree === context.worktree,
      );
      const checkpointThread = checkpoint
        ? projection.threads.find((thread) => thread.id === checkpoint.threadId)
        : undefined;
      if (checkpointThread && activeCheckpointProjects.has(checkpointThread.projectId)) {
        throw new LocalStateError("Wait for the active turn to finish before previewing a rewind.", 409);
      }
      if (
        !checkpoint
        || checkpoint.state !== "completed"
        || !checkpoint.baselineIdentity
        || !checkpoint.baselineIndexIdentity
        || !checkpoint.baselineHead
        || !checkpoint.completedIdentity
        || !checkpoint.completedIndexIdentity
        || !checkpoint.completedHead
        || checkpoint.baselineHead !== checkpoint.completedHead
      ) {
        throw new RepositoryError("This checkpoint is unavailable for rewind.", 409);
      }
      const current = await captureCheckpoint(context.worktree, true);
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
      sendJson(response, 200, {
        checkpoint,
        currentIdentity: current.identity,
        currentIndexIdentity: current.indexIdentity,
        files: await checkpointDiff(
          context.worktree,
          checkpoint.completedIdentity,
          checkpoint.baselineIdentity,
        ),
      });
      return true;
    }
    const rewindMatch = route.match(/^\/api\/checkpoints\/([0-9a-f-]+)\/rewind$/);
    if (rewindMatch) {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        currentIdentity?: unknown;
        currentIndexIdentity?: unknown;
        confirm?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.currentIdentity !== "string"
        || typeof body.currentIndexIdentity !== "string"
        || body.confirm !== true
      ) {
        throw new RepositoryError("Preview and confirm the exact rewind before continuing.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const checkpoint = projection.checkpoints.find(
        (item) => item.id === rewindMatch[1] && item.worktree === context.worktree,
      );
      const checkpointThread = checkpoint
        ? projection.threads.find((thread) => thread.id === checkpoint.threadId)
        : undefined;
      if (checkpointThread && activeCheckpointProjects.has(checkpointThread.projectId)) {
        throw new LocalStateError("Wait for the active turn to finish before rewinding.", 409);
      }
      if (
        !checkpoint
        || checkpoint.state !== "completed"
        || !checkpoint.baselineIdentity
        || !checkpoint.baselineIndexIdentity
        || !checkpoint.baselineHead
        || !checkpoint.completedIdentity
        || !checkpoint.completedIndexIdentity
        || !checkpoint.completedHead
        || checkpoint.baselineHead !== checkpoint.completedHead
        || body.currentIdentity !== checkpoint.completedIdentity
        || body.currentIndexIdentity !== checkpoint.completedIndexIdentity
      ) {
        throw new RepositoryError("This checkpoint is unavailable for rewind.", 409);
      }
      if (!checkpointThread) {
        throw new LocalStateError("The checkpoint conversation is unavailable.", 409);
      }
      activeCheckpointProjects.add(checkpointThread.projectId);
      let files;
      try {
        files = await rewindCheckpoint(
          context.worktree,
          body.currentIdentity,
          body.currentIndexIdentity,
          checkpoint.completedHead,
          checkpoint.baselineIdentity,
          checkpoint.baselineIndexIdentity,
        );
        await state.saveCheckpoint({
          ...checkpoint,
          state: "superseded",
          message: "Workspace rewound to this turn's baseline.",
        });
      } finally {
        activeCheckpointProjects.delete(checkpointThread.projectId);
      }
      sendJson(response, 200, { status: "rewound", files });
      return true;
    }
    if (route === "/api/provider/capabilities") {
      sendJson(response, 200, provider.capabilities());
      return true;
    }
    if (route === "/api/provider/approvals/list") {
      const body = await readJson(request) as { runId?: unknown };
      if (typeof body.runId !== "string") {
        throw new PermissionError("A provider run is required.");
      }
      sendJson(response, 200, { approvals: permissions.approvalsFor(body.runId) });
      return true;
    }
    if (route === "/api/context/files") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        query?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.query !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and file query are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, {
        files: await searchRepositoryFiles(context.worktree, body.query),
      });
      return true;
    }
    if (route === "/api/context/browse") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        query?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.query !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and search query are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      sendJson(
        response,
        200,
        await browseRepositoryFiles(context.worktree, body.query, controller.signal),
      );
      return true;
    }
    if (route === "/api/context/preview") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        path?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.path !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and repository-relative path are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, {
        preview: await previewRepositoryFile(context.worktree, body.path),
      });
      return true;
    }
    if (route === "/api/provider/profiles/list") {
      sendJson(response, 200, { profiles: await profiles.list() });
      return true;
    }
    if (route === "/api/provider/profiles/save") {
      const body = await readJson(request) as {
        id?: unknown;
        name?: unknown;
        binaryPath?: unknown;
        homePath?: unknown;
        environment?: unknown;
      };
      const environment = Array.isArray(body.environment)
        ? body.environment.map((value) => {
            if (
              !isRecord(value)
              || typeof value.name !== "string"
              || typeof value.sensitive !== "boolean"
              || (value.value !== undefined && typeof value.value !== "string")
              || (value.valueSet !== undefined && typeof value.valueSet !== "boolean")
            ) {
              throw new ProfileError("Profile environment variables must be valid.");
            }
            return {
              name: value.name,
              sensitive: value.sensitive,
              ...(typeof value.value === "string" ? { value: value.value } : {}),
              ...(typeof value.valueSet === "boolean" ? { valueSet: value.valueSet } : {}),
            };
          })
        : undefined;
      if (
        (body.id !== undefined && typeof body.id !== "string")
        || typeof body.name !== "string"
        || (body.binaryPath !== undefined && typeof body.binaryPath !== "string")
        || (body.homePath !== undefined && typeof body.homePath !== "string")
        || (body.environment !== undefined && !Array.isArray(body.environment))
      ) {
        throw new ProfileError("A valid Claude profile is required.");
      }
      sendJson(response, 200, await profiles.save({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        name: body.name,
        ...(typeof body.binaryPath === "string" ? { binaryPath: body.binaryPath } : {}),
        ...(typeof body.homePath === "string" ? { homePath: body.homePath } : {}),
        ...(environment ? { environment } : {}),
      }));
      return true;
    }
    if (route === "/api/provider/profiles/delete") {
      const body = await readJson(request) as { id?: unknown };
      if (typeof body.id !== "string") throw new ProfileError("A Claude profile is required.");
      await profiles.delete(body.id);
      sendJson(response, 200, { status: "deleted" });
      return true;
    }
    if (route === "/api/provider/profiles/refresh") {
      const body = await readJson(request) as { id?: unknown; kind?: unknown };
      const kinds: ProfileProbeKind[] = ["availability", "version", "authentication", "models"];
      if (
        typeof body.id !== "string"
        || typeof body.kind !== "string"
        || !kinds.includes(body.kind as ProfileProbeKind)
      ) {
        throw new ProfileError("A profile and refresh kind are required.");
      }
      sendJson(response, 200, await profiles.refresh(body.id, body.kind as ProfileProbeKind));
      return true;
    }
    if (route === "/api/provider/runs") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        prompt?: unknown;
        conversationId?: unknown;
        resumeSessionId?: unknown;
        projectId?: unknown;
        threadId?: unknown;
        mode?: unknown;
        attachments?: unknown;
        profileId?: unknown;
        model?: unknown;
        elementReferences?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.prompt !== "string"
        || !body.prompt.trim()
        || typeof body.conversationId !== "string"
        || !body.conversationId
        || (body.resumeSessionId !== undefined && typeof body.resumeSessionId !== "string")
        || (body.projectId !== undefined && typeof body.projectId !== "string")
        || (body.threadId !== undefined && typeof body.threadId !== "string")
        || !["ask", "plan", "build"].includes(body.mode as string)
        || (body.attachments !== undefined && (
          !Array.isArray(body.attachments)
          || body.attachments.some((path) => typeof path !== "string")
        ))
        || typeof body.profileId !== "string"
        || typeof body.model !== "string"
        || !CLAUDE_MODEL_ALIASES.includes(body.model)
        || (body.elementReferences !== undefined && (
          !Array.isArray(body.elementReferences)
          || body.elementReferences.length > 3
          || body.elementReferences.some((value) => (
            typeof value !== "object"
            || value === null
            || typeof (value as { selector?: unknown }).selector !== "string"
            || typeof (value as { tag?: unknown }).tag !== "string"
          ))
        ))
      ) {
        throw new RepositoryError(
          "A repository, worktree, prompt, interaction mode, Claude profile, and model are required.",
        );
      }
      const mode = body.mode as InteractionMode;
      const context = await selectedWorktree(body.root, body.worktree);
      const attachments = await resolveContextAttachments(
        context.worktree,
        (body.attachments ?? []) as string[],
      );
      const providerPrompt = composePrompt(
        body.prompt.trim(),
        attachments,
        (body.elementReferences ?? []) as Array<{
          selector: string;
          tag: string;
          role?: string | null;
          name?: string | null;
          text?: string | null;
        }>,
      );
      const projection = await state.load();
      const project = typeof body.projectId === "string"
        ? projection.projects.find((item) => item.id === body.projectId && item.root === context.root)
        : projection.projects.find((item) => item.root === context.root);
      if (!project) throw new LocalStateError("Open the repository before starting a conversation.", 404);
      const profile = await profiles.runtime(body.profileId);
      const previousSession = typeof body.threadId === "string"
        ? projection.providerSessions.find((session) => session.threadId === body.threadId)
        : undefined;
      if (
        previousSession?.continuationKey
        && previousSession.continuationKey !== profile.continuationKey
      ) {
        throw new ProfileError(
          "This thread can only continue with a Claude profile using the same Claude home.",
          409,
        );
      }
      if (activeCheckpointProjects.has(project.id)) {
        throw new LocalStateError("This project already has an active checkpoint capture.", 409);
      }
      activeCheckpointProjects.add(project.id);
      try {
      const persisted = await state.startTurn({
        projectId: project.id,
        worktree: context.worktree,
        prompt: body.prompt.trim(),
        mode,
        threadId: body.threadId,
      });
      const checkpointId = randomUUID();
      const checkpointCreatedAt = new Date().toISOString();
      let baselineIdentity: string | null = null;
      let commonGitDirectory: string | null = null;
      try {
        commonGitDirectory = await checkpointGitDirectory(context.worktree);
      } catch {
        // Capture below records a visible unavailable state without creating refs.
      }
      const checkpointIntent = await state.saveCheckpoint({
        id: checkpointId,
        turnId: persisted.turn.id,
        threadId: persisted.thread.id,
        worktree: context.worktree,
        gitDirectory: commonGitDirectory,
        baselineHead: null,
        baselineIdentity: null,
        baselineIndexIdentity: null,
        completedIdentity: null,
        completedIndexIdentity: null,
        completedHead: null,
        state: "unavailable",
        message: "Baseline capture did not complete.",
        createdAt: checkpointCreatedAt,
      });
      try {
        const baseline = await captureCheckpoint(
          context.worktree,
          false,
          checkpointReference(checkpointId, "baseline"),
        );
        baselineIdentity = baseline.identity;
        await state.saveCheckpoint({
          ...checkpointIntent,
          gitDirectory: baseline.gitDirectory,
          baselineHead: baseline.head,
          baselineIdentity,
          baselineIndexIdentity: baseline.indexIdentity,
          state: "baseline",
          message: null,
        });
      } catch (error) {
        await state.saveCheckpoint({
          ...checkpointIntent,
          state: "unavailable",
          message: error instanceof RepositoryError ? error.message : "Baseline capture failed.",
        });
      }
      const port = request.socket.localPort;
      if (!port) throw new RepositoryError("The local permission broker is unavailable.", 503);
      const approvalUrl = `http://127.0.0.1:${port}/api/provider/permissions/request`;
      let run;
      try {
        run = await provider.start(
          context.root,
          context.worktree,
          body.conversationId,
          providerPrompt,
          approvalUrl,
          mode,
          body.resumeSessionId,
          {
            executable: profile.executable,
            environment: profile.environment,
            model: body.model,
          },
        );
      } catch (error) {
        await state.recordProviderEvent(persisted.thread.id, persisted.turn.id, {
          kind: "failed",
          message: error instanceof ProviderProtocolError
            ? error.message
            : "The provider could not be started.",
        }, { profileId: profile.profile.id, continuationKey: profile.continuationKey });
        const checkpoint = (await state.load()).checkpoints.find((item) => item.id === checkpointId);
        if (checkpoint && checkpoint.state === "baseline") {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "failed",
            message: "Provider startup failed before checkpoint completion.",
          });
        }
        throw error;
      }
      await state.bindProviderRun(persisted.turn.id, run.id);
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-provider-run-id": run.id,
        "x-thread-id": persisted.thread.id,
        "x-turn-id": persisted.turn.id,
      });
      let completed = false;
      let historyFailed = false;
      for await (const event of run.events) {
        try {
          await state.recordProviderEvent(
            persisted.thread.id,
            persisted.turn.id,
            event,
            { profileId: profile.profile.id, continuationKey: profile.continuationKey },
          );
        } catch {
          provider.cancel(run.id);
          response.write(`${JSON.stringify({
            kind: "failed",
            message: "Local history could not be updated. The provider run was stopped.",
          })}\n`);
          historyFailed = true;
          break;
        }
        if (event.kind === "turn_completed") completed = true;
        response.write(`${JSON.stringify(event)}\n`);
      }
      const checkpoint = (await state.load()).checkpoints.find((item) => item.id === checkpointId);
      if (checkpoint?.state === "baseline" && baselineIdentity) {
        if (historyFailed) {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "failed",
            message: "Local history failed and the provider turn was stopped.",
          });
        } else if (completed) {
          try {
            const captured = await captureCheckpoint(
              context.worktree,
              true,
              checkpointReference(checkpointId, "completed"),
            );
            if (captured.head !== checkpoint.baselineHead) {
              await deleteCheckpointReferences(captured.gitDirectory, checkpointId);
              await state.saveCheckpoint({
                ...checkpoint,
                state: "unavailable",
                message: "HEAD changed during the turn; rewind does not rewrite Git history.",
              });
            } else {
              const saved = await state.saveCheckpoint({
                ...checkpoint,
                completedIdentity: captured.identity,
                completedIndexIdentity: captured.indexIdentity,
                completedHead: captured.head,
                state: "completed",
                message: null,
              });
              await state.supersedeCompletedCheckpoints(
                persisted.thread.id,
                context.worktree,
                saved.id,
              );
            }
          } catch (error) {
            await state.saveCheckpoint({
              ...checkpoint,
              state: "unavailable",
              message: error instanceof RepositoryError
                ? error.message
                : "Completed checkpoint capture failed.",
            });
          }
        } else {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "failed",
            message: "The turn did not complete; its baseline remains inspectable.",
          });
        }
      }
      response.end();
      return true;
      } finally {
        activeCheckpointProjects.delete(project.id);
      }
    }
    if (route === "/api/provider/permissions/request") {
      const body = await readJson(request) as {
        runId?: unknown;
        toolName?: unknown;
        input?: unknown;
      };
      const authorization = request.headers.authorization;
      if (
        typeof body.runId !== "string"
        || typeof body.toolName !== "string"
        || typeof authorization !== "string"
        || !authorization.startsWith("Bearer ")
      ) {
        throw new PermissionError("A valid provider permission request is required.", 403);
      }
      sendJson(
        response,
        200,
        await permissions.awaitDecision(
          body.runId,
          authorization.slice("Bearer ".length),
          body.toolName,
          body.input,
        ),
      );
      return true;
    }
    const approvalMatch = route.match(/^\/api\/provider\/approvals\/([0-9a-f-]+)\/decide$/);
    if (approvalMatch) {
      const body = await readJson(request) as {
        runId?: unknown;
        conversationId?: unknown;
        repository?: unknown;
        worktree?: unknown;
        toolCallId?: unknown;
        decision?: unknown;
      };
      if (
        typeof body.runId !== "string"
        || typeof body.conversationId !== "string"
        || typeof body.repository !== "string"
        || typeof body.worktree !== "string"
        || typeof body.toolCallId !== "string"
        || (body.decision !== "allow_once" && body.decision !== "deny")
      ) {
        throw new PermissionError("A complete scoped approval decision is required.");
      }
      sendJson(response, 200, permissions.decide(
        approvalMatch[1],
        {
          runId: body.runId,
          conversationId: body.conversationId,
          repository: body.repository,
          worktree: body.worktree,
          toolCallId: body.toolCallId,
        },
        body.decision,
      ));
      return true;
    }
    if (route === "/api/changes") {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, { files: await listChangedFiles(context.worktree) });
      return true;
    }
    if (route === "/api/changes/diff") {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown; path?: unknown };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.path !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and changed file are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await readFileDiff(context.worktree, body.path));
      return true;
    }
    if (route === "/api/delivery/inspect") {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await inspectDelivery(context.root, context.worktree));
      return true;
    }
    if (route === "/api/delivery/plans") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        action?: unknown;
        input?: unknown;
      };
      const actions = new Set<DeliveryAction>(["stage", "commit", "push", "pull_request"]);
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.action !== "string"
        || !actions.has(body.action as DeliveryAction)
        || typeof body.input !== "object"
        || body.input === null
        || Array.isArray(body.input)
      ) {
        throw new RepositoryError("A complete delivery action is required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await delivery.plan(
        context.root,
        context.worktree,
        body.action as DeliveryAction,
        body.input as Record<string, unknown>,
      ));
      return true;
    }
    const deliveryMatch = route.match(/^\/api\/delivery\/plans\/([0-9a-f-]+)\/execute$/);
    if (deliveryMatch) {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await delivery.execute(deliveryMatch[1], context.root, context.worktree));
      return true;
    }
    if (route === "/api/previews/request") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        origin?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.origin !== "string"
      ) {
        throw new PreviewError("A repository, worktree, and loopback origin are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        await previews.requestStart(context.root, context.worktree, body.origin),
      );
      return true;
    }
    const previewDecision = route.match(/^\/api\/previews\/([0-9a-f-]+)\/decide$/);
    if (previewDecision) {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        decision?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || (body.decision !== "allow_once" && body.decision !== "deny")
      ) {
        throw new PreviewError("A scoped preview decision is required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        previews.decide(
          previewDecision[1],
          { repository: context.root, worktree: context.worktree },
          body.decision,
        ),
      );
      return true;
    }
    const previewStatus = route.match(/^\/api\/previews\/([0-9a-f-]+)\/status$/);
    if (previewStatus) {
      sendJson(response, 200, previews.snapshot(previewStatus[1]));
      return true;
    }
    const previewStop = route.match(/^\/api\/previews\/([0-9a-f-]+)\/stop$/);
    if (previewStop) {
      const body = await readJson(request) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new PreviewError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        await previews.stop(
          previewStop[1],
          { repository: context.root, worktree: context.worktree },
        ),
      );
      return true;
    }
    const cancelMatch = route.match(/^\/api\/provider\/runs\/([0-9a-f-]+)\/cancel$/);
    if (cancelMatch) {
      if (!provider.cancel(cancelMatch[1])) {
        throw new RepositoryError("The provider run is no longer active.", 404);
      }
      sendJson(response, 202, { status: "cancelling" });
      return true;
    }
    sendJson(response, 404, { error: "API route not found." });
  } catch (error) {
    const status = error instanceof RepositoryError
      || error instanceof PermissionError
      || error instanceof LocalStateError
      || error instanceof ProfileError
      || error instanceof PreviewError
      ? error.status
      : 500;
    const message = error instanceof RepositoryError
      || error instanceof ProviderProtocolError
      || error instanceof PermissionError
      || error instanceof LocalStateError
      || error instanceof ProfileError
      || error instanceof PreviewError
      ? error.message
      : "The local operation failed.";
    sendJson(response, status, { error: message });
  }
  return true;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(request: IncomingMessage, response: ServerResponse, dist: string): Promise<void> {
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const requested = rawPath === "/" ? "index.html" : rawPath.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(dist, safePath);
  try {
    if (!(await stat(filePath)).isFile()) filePath = join(dist, "index.html");
  } catch {
    filePath = join(dist, "index.html");
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
}

export function createLocalHost(
  dist = fileURLToPath(new URL("../dist", import.meta.url)),
  state = new LocalStateStore(),
  profiles = new ClaudeProfileStore(state.directory),
) {
  const permissions = new PermissionBroker();
  const delivery = new DeliveryBroker();
  const provider = new ClaudeCodeAdapter("claude", permissions);
  const previews = new PreviewManager();
  const recovery = state.recoverInterruptedTurns();
  return createServer(async (request, response) => {
    await recovery;
    if (
      await handleApi(
        request,
        response,
        provider,
        permissions,
        delivery,
        state,
        profiles,
        previews,
      )
    ) return;
    await serveStatic(request, response, dist);
  });
}
