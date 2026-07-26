import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeAdapter,
  type InteractionMode,
  type ProviderId,
  ProviderProtocolError,
  type ReasoningEffort,
} from "./provider.ts";
import { CodexCliAdapter } from "./codex-provider.ts";
import { AcpProviderAdapter } from "./acp-provider.ts";
import {
  adapterReference,
  ProviderAdapterError,
  ProviderAdapterStore,
} from "./provider-adapters.ts";
import { listReviewedAdapters, prepareReviewedAdapter } from "./reviewed-adapters.ts";
import { listChangedFiles, readFileDiff } from "./changes.ts";
import {
  annotationView,
  captureAnnotationContext,
  formatRevisionContext,
  MAX_ANNOTATION_TEXT,
} from "./annotations.ts";
import { DeliveryBroker, inspectDelivery, type DeliveryAction } from "./delivery.ts";
import { PermissionBroker, PermissionError } from "./permission.ts";
import {
  canonicalizeRepositoryRoot,
  captureCheckpoint,
  checkpointGitDirectory,
  checkpointReference,
  checkpointDiff,
  collapseProjectsByRepository,
  deleteCheckpointReferences,
  discoverWorktrees,
  openRepository,
  RepositoryError,
  repositoryCommonDir,
  rewindCheckpoint,
} from "./repository.ts";
import {
  LocalStateError,
  LocalStateStore,
  projectThreadStatus,
  projectThreadStatuses,
  type ThreadStatus,
} from "./state.ts";
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
import { PreferencesError, PreferencesStore } from "./preferences.ts";
import { WorktreeManager } from "./worktrees.ts";
import { RemoteAuth, RemoteAuthError } from "./remote-auth.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { WakeBroker } from "./wake.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 128 * 1024;
const activeCheckpointProjects = new Set<string>();
const activeCheckpointWorktrees = new Set<string>();
const requestBodies = new WeakMap<IncomingMessage, Buffer>();

function checkpointWorktreeKey(projectId: string, worktree: string): string {
  return JSON.stringify([projectId, worktree]);
}

function projectHasActiveCheckpoint(projectId: string): boolean {
  const prefix = `[${JSON.stringify(projectId)},`;
  return [...activeCheckpointWorktrees].some((key) => key.startsWith(prefix));
}

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

async function publishThreadStatusTransition(
  wake: WakeBroker,
  state: LocalStateStore,
  threadId: string,
  previous: ThreadStatus | null,
): Promise<void> {
  const next = projectThreadStatus(await state.load(), threadId);
  if (previous !== null && previous === next.status) return;
  wake.publish({
    threadId,
    status: next.status,
    at: new Date().toISOString(),
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const cached = requestBodies.get(request);
  if (cached) {
    try {
      return JSON.parse(cached.toString("utf8"));
    } catch {
      throw new RepositoryError("Request body must be valid JSON.");
    }
  }
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

async function bufferRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RepositoryError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  requestBodies.set(request, body);
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedOrigin(request: IncomingMessage, remote: boolean): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const hostname = originUrl.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!remote) return LOOPBACK_HOSTS.has(hostname);
    const requestHost = request.headers.host;
    return typeof requestHost === "string" && originUrl.host === requestHost;
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

function createInternalPermissionCallback(permissions: PermissionBroker): {
  server: ReturnType<typeof createHttpServer>;
  url: Promise<string>;
} {
  const server = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/api/provider/permissions/request") {
      sendJson(response, 404, { error: "Internal permission route not found." });
      return;
    }
    try {
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
    } catch (error) {
      const status = error instanceof PermissionError ? error.status : 500;
      const message = error instanceof PermissionError ? error.message : "Permission request failed.";
      sendJson(response, status, { error: message });
    }
  });
  const url = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("The internal permission broker did not provide a TCP address."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/api/provider/permissions/request`);
    });
  });
  return { server, url };
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  provider: ClaudeCodeAdapter,
  codex: CodexCliAdapter,
  permissions: PermissionBroker,
  delivery: DeliveryBroker,
  state: LocalStateStore,
  profiles: ClaudeProfileStore,
  previews: PreviewManager,
  preferences: PreferencesStore,
  worktrees: WorktreeManager,
  directories: DirectoryBrowser,
  adapters: ProviderAdapterStore,
  activeAcp: Map<string, AcpProviderAdapter>,
  wake: WakeBroker,
  remoteRequest: boolean,
  remoteAuth?: RemoteAuth,
  internalApprovalUrl?: Promise<string>,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (!route.startsWith("/api/")) return false;
  const isWakeStream = request.method === "GET" && route === "/api/state/events";
  if (request.method !== "POST" && !isWakeStream) {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return true;
  }
  if (!isAllowedOrigin(request, Boolean(remoteAuth))) {
    sendJson(response, 403, { error: "Repository access is limited to the local application." });
    return true;
  }

  try {
    if (isWakeStream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      response.write(": connected\n\n");
      const unsubscribe = wake.subscribe((event) => {
        if (response.writableEnded) return;
        response.write(`event: thread_status\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        if (response.writableEnded) return;
        response.write(": heartbeat\n\n");
      }, 30_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.on("close", cleanup);
      response.on("close", cleanup);
      return true;
    }
    if (route === "/api/providers/discover") {
      const codexReadiness = await codex.readiness().catch(() => ({
        id: "codex-cli" as const,
        installed: false,
        authenticated: false,
        version: null,
        models: [],
      }));
      const declarativeProviders = await Promise.all(
        (await adapters.list()).map(async (adapter) => {
          let executableFound = false;
          try {
            await adapters.resolveExecutable(adapter);
            executableFound = true;
          } catch {
            executableFound = false;
          }
          const missingRequiredEnv = adapter.manifest.environment
            .filter((entry) => entry.required)
            .some((entry) => {
              const value = process.env[entry.name];
              return value === undefined || value === "";
            });
          return {
            id: adapterReference(adapter.manifest),
            installed: true,
            // Reuse authenticated as "run-ready" so the composer can filter adapters
            // that cannot start (missing CLI or required env), like unauthenticated Codex.
            authenticated: executableFound && !missingRequiredEnv,
            version: adapter.manifest.version,
            name: adapter.manifest.presentation.name,
            enabled: adapter.enabled,
          };
        }),
      );
      sendJson(response, 200, {
        providers: [
          { id: "claude-code", installed: true },
          codexReadiness,
          ...declarativeProviders,
        ],
      });
      return true;
    }
    if (route === "/api/provider/adapters/list") {
      const installed = await adapters.list();
      sendJson(response, 200, {
        adapters: remoteRequest
          ? installed.map((adapter) => ({ ...adapter, source: "Source available on host only" }))
          : installed,
        administrationAvailable: !remoteRequest,
      });
      return true;
    }
    if (route === "/api/provider/adapters/catalog") {
      const catalog = await listReviewedAdapters(adapters);
      sendJson(response, 200, {
        adapters: remoteRequest
          ? catalog.map((entry) => ({
            ...entry,
            source: "Reviewed package available on host only",
            package: null,
            executablePath: entry.executableFound ? "available on host" : null,
          }))
          : catalog,
        administrationAvailable: !remoteRequest,
      });
      return true;
    }
    if (route === "/api/provider/adapters/catalog/prepare") {
      if (remoteRequest) throw new ProviderAdapterError("Remote clients cannot administer host adapters.", 403);
      const body = await readJson(request) as { slug?: unknown };
      const prepared = await prepareReviewedAdapter(adapters, body.slug);
      sendJson(response, 200, prepared);
      return true;
    }
    if (route === "/api/provider/adapters/inspect") {
      const body = await readJson(request) as {
        source?: unknown;
        digest?: unknown;
        manifest?: unknown;
      };
      sendJson(response, 200, adapters.inspect(body));
      return true;
    }
    if (route === "/api/provider/adapters/install" || route === "/api/provider/adapters/update") {
      if (remoteRequest) throw new ProviderAdapterError("Remote clients cannot administer host adapters.", 403);
      const body = await readJson(request) as {
        source?: unknown;
        digest?: unknown;
        manifest?: unknown;
        approved?: unknown;
      };
      if (body.approved !== true) throw new ProviderAdapterError("Explicit adapter approval is required.", 403);
      sendJson(response, 200, route.endsWith("/install")
        ? await adapters.install(body)
        : await adapters.update(body));
      return true;
    }
    const adapterAction = route.match(
      /^\/api\/provider\/adapters\/([a-z0-9.-]+)\/(enable|disable|rollback|uninstall)$/,
    );
    if (adapterAction) {
      if (remoteRequest) throw new ProviderAdapterError("Remote clients cannot administer host adapters.", 403);
      const body = await readJson(request) as { approved?: unknown };
      if (body.approved !== true) throw new ProviderAdapterError("Explicit adapter approval is required.", 403);
      const [, id, action] = adapterAction;
      if (action === "uninstall") {
        await adapters.uninstall(id);
        sendJson(response, 200, { uninstalled: true });
      } else if (action === "rollback") {
        sendJson(response, 200, await adapters.rollback(id));
      } else {
        sendJson(response, 200, await adapters.setEnabled(id, action === "enable"));
      }
      return true;
    }
    if (route === "/api/remote/pair") {
      if (!remoteAuth) throw new RemoteAuthError("Remote access is disabled.", 404);
      const body = await readJson(request) as {
        credential?: unknown;
        label?: unknown;
        publicKey?: unknown;
      };
      sendJson(response, 200, await remoteAuth.pair(body));
      return true;
    }
    if (route === "/api/remote/descriptor") {
      // Loopback hosts answer 200 with remoteEnabled:false so the shell does not
      // log a console 404 on every local boot (local-first default).
      if (!remoteAuth) {
        sendJson(response, 200, { remoteEnabled: false });
        return true;
      }
      sendJson(response, 200, { remoteEnabled: true, ...(await remoteAuth.descriptor()) });
      return true;
    }
    if (route === "/api/repositories/open") {
      const body = await readJson(request) as { path?: unknown };
      if (typeof body.path !== "string") {
        throw new RepositoryError("A repository path is required.");
      }
      const repository = await openRepository(body.path);
      repository.worktrees = await worktrees.list(repository.root);
      const projection = await state.load();
      // One project record per git repository (common dir), not per worktree path.
      let existing = projection.projects.find((project) => project.root === repository.root);
      if (!existing) {
        let commonDir: string | null = null;
        try {
          commonDir = await repositoryCommonDir(repository.selectedWorktree || repository.root);
        } catch {
          commonDir = null;
        }
        if (commonDir) {
          for (const candidate of projection.projects) {
            try {
              if (await repositoryCommonDir(candidate.root) === commonDir) {
                existing = candidate;
                break;
              }
            } catch {
              /* skip missing roots */
            }
          }
        }
      }
      const project = await state.saveProject({
        id: existing?.id ?? randomUUID(),
        name: repository.name,
        root: repository.root,
        // Keep original registration time when reopening an existing project.
        ...(existing ? { openedAt: existing.openedAt } : {}),
      });
      sendJson(response, 200, { ...repository, projectId: project.id });
      return true;
    }
    if (route === "/api/projects/list") {
      const projection = await state.load();
      sendJson(response, 200, {
        projects: await collapseProjectsByRepository(projection.projects),
      });
      return true;
    }
    if (route === "/api/directories/browse") {
      if (remoteAuth) {
        throw new RepositoryError(
          "Remote clients cannot browse the host filesystem without a directory grant.",
          403,
        );
      }
      const body = await readJson(request) as { path?: unknown; includeHidden?: unknown };
      if (body.path !== undefined && typeof body.path !== "string") {
        throw new RepositoryError("A directory path must be a string.");
      }
      if (body.includeHidden !== undefined && typeof body.includeHidden !== "boolean") {
        throw new RepositoryError("The hidden-directory option must be a boolean.");
      }
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      sendJson(response, 200, await directories.browse({
        path: body.path,
        includeHidden: body.includeHidden,
        signal: controller.signal,
      }));
      return true;
    }
    if (route === "/api/worktrees/create/preview") {
      const body = await readJson(request) as {
        root?: unknown;
        base?: unknown;
        branch?: unknown;
        path?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.base !== "string"
        || typeof body.branch !== "string"
        || (body.path !== undefined && typeof body.path !== "string")
      ) {
        throw new RepositoryError("A repository, base revision, and new branch are required.");
      }
      const { preferences: currentPreferences } = await preferences.load();
      sendJson(response, 200, await worktrees.previewCreate({
        repository: body.root,
        base: body.base,
        branch: body.branch,
        ...(typeof body.path === "string" ? { path: body.path } : {}),
        limit: currentPreferences.managedWorktreeLimit,
      }));
      return true;
    }
    if (route === "/api/worktrees/create") {
      const body = await readJson(request) as { planId?: unknown; confirm?: unknown };
      if (typeof body.planId !== "string" || body.confirm !== true) {
        throw new RepositoryError("A complete scoped worktree approval is required.");
      }
      const { preferences: currentPreferences } = await preferences.load();
      const created = await worktrees.create(body.planId, currentPreferences.managedWorktreeLimit);
      const repository = await openRepository(created.repository);
      repository.worktrees = await worktrees.list(created.repository);
      const projection = await state.load();
      const project = projection.projects.find((candidate) => candidate.root === created.repository);
      sendJson(response, 200, {
        ...repository,
        projectId: project?.id,
        selectedWorktree: created.path,
      });
      return true;
    }
    if (route === "/api/worktrees/remove/preview") {
      const body = await readJson(request) as { root?: unknown; path?: unknown };
      if (typeof body.root !== "string" || typeof body.path !== "string") {
        throw new RepositoryError("A repository and managed worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.path);
      const projection = await state.load();
      if (projection.threads.some((thread) => thread.worktree === context.worktree)) {
        throw new RepositoryError(
          "A conversation is still bound to this worktree. Conversation deletion never removes worktrees; remove or retain that history first.",
          409,
        );
      }
      sendJson(response, 200, await worktrees.previewRemove(context.root, context.worktree));
      return true;
    }
    if (route === "/api/worktrees/remove") {
      const body = await readJson(request) as { planId?: unknown; confirm?: unknown };
      if (typeof body.planId !== "string" || body.confirm !== true) {
        throw new RepositoryError("A complete scoped worktree removal approval is required.");
      }
      const plan = worktrees.removalPlan(body.planId);
      const projection = await state.load();
      const project = projection.projects.find((candidate) => candidate.root === plan.repository);
      let projectLockAcquired = false;
      try {
        if (project && activeCheckpointProjects.has(project.id)) {
          throw new LocalStateError("Wait for the active conversation operation before removing its worktree.", 409);
        }
        if (project) {
          activeCheckpointProjects.add(project.id);
          projectLockAcquired = true;
        }
        const current = await state.load();
        if (current.threads.some((thread) => thread.worktree === plan.path)) {
          throw new RepositoryError(
            "A conversation became bound to this worktree after preview. Removal was cancelled.",
            409,
          );
        }
        await worktrees.remove(body.planId);
      } finally {
        if (project && projectLockAcquired) activeCheckpointProjects.delete(project.id);
        worktrees.discardPlan(body.planId);
      }
      sendJson(response, 200, { status: "removed" });
      return true;
    }
    if (route === "/api/state/load") {
      const projection = await state.load();
      sendJson(response, 200, {
        ...projection,
        threadStatuses: projectThreadStatuses(projection),
      });
      return true;
    }
    if (route === "/api/forks/preview") {
      const body = await readJson(request) as { sourceThreadId?: unknown };
      if (typeof body.sourceThreadId !== "string") {
        throw new LocalStateError("A source conversation is required.", 400);
      }
      const preview = await state.previewFork(body.sourceThreadId);
      if (preview.byteCount > 64 * 1024) {
        throw new LocalStateError("The source context exceeds the 64 KiB fork limit.", 413);
      }
      sendJson(response, 200, preview);
      return true;
    }
    if (route === "/api/forks/create") {
      const body = await readJson(request) as {
        sourceThreadId?: unknown;
        provider?: unknown;
        profileId?: unknown;
        model?: unknown;
        expectedDigest?: unknown;
      };
      if (
        typeof body.sourceThreadId !== "string"
        || (body.provider !== "claude-code" && body.provider !== "codex-cli")
        || typeof body.model !== "string"
        || !body.model
        || typeof body.expectedDigest !== "string"
        || (body.provider === "claude-code" && typeof body.profileId !== "string")
        || (body.provider === "codex-cli" && body.profileId !== null)
      ) {
        throw new LocalStateError(
          "A source conversation, destination provider, profile, model, and reviewed context size are required.",
          400,
        );
      }
      const projection = await state.load();
      const source = projection.threads.find((thread) => thread.id === body.sourceThreadId);
      const project = source
        ? projection.projects.find((candidate) => candidate.id === source.projectId)
        : undefined;
      if (!source || !project) throw new LocalStateError("The source conversation is unavailable.", 404);
      await selectedWorktree(project.root, source.worktree);
      if (body.provider === "claude-code") {
        if (!CLAUDE_MODEL_ALIASES.includes(body.model)) {
          throw new ProfileError("The selected Claude model is unavailable.", 409);
        }
        await profiles.runtime(body.profileId as string);
      } else {
        const readiness = await codex.readiness();
        if (!readiness.installed || !readiness.authenticated) {
          throw new ProviderProtocolError("Codex CLI is unavailable or not authenticated.");
        }
        if (body.model !== "default" && !readiness.models.some((model) => model.id === body.model)) {
          throw new ProviderProtocolError("The selected Codex model is unavailable.");
        }
      }
      const created = await state.createFork({
        sourceThreadId: source.id,
        provider: body.provider,
        profileId: body.profileId as string | null,
        model: body.model,
        worktree: source.worktree,
        expectedDigest: body.expectedDigest,
      });
      sendJson(response, 201, created);
      return true;
    }
    if (route === "/api/state/search") {
      const body = await readJson(request) as { query?: unknown; archived?: unknown };
      if (typeof body.query !== "string") throw new LocalStateError("A search query is required.", 400);
      if (body.archived !== undefined && !["exclude", "include", "only"].includes(String(body.archived))) {
        throw new LocalStateError("A valid archived conversation scope is required.", 400);
      }
      const query = body.query.trim().toLocaleLowerCase().slice(0, 120);
      const archived = body.archived ?? "exclude";
      const projection = await state.load();
      const projects = new Map(projection.projects.map((project) => [project.id, project]));
      const threads = projection.threads
        .filter((thread) => {
          if (archived === "exclude" && thread.archivedAt) return false;
          if (archived === "only" && !thread.archivedAt) return false;
          const project = projects.get(thread.projectId);
          return !query || thread.title.toLocaleLowerCase().includes(query)
            || thread.worktree.toLocaleLowerCase().includes(query)
            || project?.name.toLocaleLowerCase().includes(query);
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50)
        .map((thread) => ({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          worktree: thread.worktree,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? null,
          archivedAt: thread.archivedAt ?? null,
          projectName: projects.get(thread.projectId)?.name ?? "Unknown project",
        }));
      sendJson(response, 200, { threads, bounded: true });
      return true;
    }
    if (route === "/api/state/conversations/rename") {
      const body = await readJson(request) as { threadId?: unknown; title?: unknown };
      if (typeof body.threadId !== "string" || typeof body.title !== "string") {
        throw new LocalStateError("A conversation and title are required.", 400);
      }
      sendJson(response, 200, await state.renameConversation(body.threadId, body.title));
      return true;
    }
    if (route === "/api/state/conversations/pin") {
      const body = await readJson(request) as { threadId?: unknown; pinned?: unknown };
      if (typeof body.threadId !== "string" || typeof body.pinned !== "boolean") {
        throw new LocalStateError("A conversation and pin state are required.", 400);
      }
      sendJson(response, 200, await state.setConversationPinned(body.threadId, body.pinned));
      return true;
    }
    if (route === "/api/state/conversations/archive") {
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, await state.archiveConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/restore") {
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, await state.restoreConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/settle") {
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, await state.settleConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/unsettle") {
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, await state.unsettleConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/visit") {
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, await state.markConversationVisited(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/release-worktree") {
      const body = await readJson(request) as { threadId?: unknown; confirm?: unknown };
      if (typeof body.threadId !== "string" || body.confirm !== true) {
        throw new LocalStateError("A confirmed conversation worktree release is required.", 400);
      }
      const projection = await state.load();
      const thread = projection.threads.find((item) => item.id === body.threadId);
      if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
      const blocking = projection.turns.find((turn) => (
        turn.threadId === thread.id
        && ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status)
      ));
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
      const body = await readJson(request) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      sendJson(response, 200, {
        threadId: body.threadId,
        affectedRecords: await state.previewConversationDeletion(body.threadId),
        excluded: ["repository", "worktree", "branch", "provider credentials", "remote content"],
      });
      return true;
    }
    if (route === "/api/state/conversations/delete") {
      const body = await readJson(request) as { threadId?: unknown; confirm?: unknown };
      if (typeof body.threadId !== "string" || body.confirm !== true) {
        throw new LocalStateError("A confirmed conversation deletion is required.", 400);
      }
      sendJson(response, 200, await state.deleteConversation(body.threadId));
      return true;
    }
    if (route === "/api/preferences/load") {
      sendJson(response, 200, await preferences.load());
      return true;
    }
    if (route === "/api/preferences/save") {
      sendJson(response, 200, await preferences.save(await readJson(request)));
      return true;
    }
    if (route === "/api/state/projects/delete") {
      const body = await readJson(request) as { projectId?: unknown };
      if (typeof body.projectId !== "string") {
        throw new RepositoryError("A project is required.");
      }
      const projection = await state.load();
      if (activeCheckpointProjects.has(body.projectId) || projectHasActiveCheckpoint(body.projectId)) {
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
      if ([...expiredProjectIds].some((projectId) => (
        activeCheckpointProjects.has(projectId) || projectHasActiveCheckpoint(projectId)
      ))) {
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
      if (checkpointThread && (
        activeCheckpointProjects.has(checkpointThread.projectId)
        || activeCheckpointWorktrees.has(checkpointWorktreeKey(checkpointThread.projectId, context.worktree))
      )) {
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
      const rewindLock = checkpointThread
        ? checkpointWorktreeKey(checkpointThread.projectId, context.worktree)
        : null;
      if (checkpointThread && (
        activeCheckpointProjects.has(checkpointThread.projectId)
        || (rewindLock && activeCheckpointWorktrees.has(rewindLock))
      )) {
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
      activeCheckpointWorktrees.add(rewindLock!);
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
        activeCheckpointWorktrees.delete(rewindLock!);
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
        provider?: unknown;
        reasoningEffort?: unknown;
      };
      const providerId = (body.provider ?? "claude-code") as ProviderId;
      const isDeclarativeAdapter = typeof providerId === "string" && providerId.startsWith("adapter:");
      const reasoningEfforts = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
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
        || (providerId !== "claude-code" && providerId !== "codex-cli" && !isDeclarativeAdapter)
        || (providerId === "claude-code" && typeof body.profileId !== "string")
        || typeof body.model !== "string"
        || (providerId === "claude-code" && !CLAUDE_MODEL_ALIASES.includes(body.model))
        || (body.reasoningEffort !== undefined
          && !reasoningEfforts.has(body.reasoningEffort as ReasoningEffort))
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
          "A repository, worktree, prompt, interaction mode, provider, and model are required.",
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
      const pendingFork = typeof body.threadId === "string"
        ? projection.forks.find((fork) => (
            fork.destinationThreadId === body.threadId && fork.status === "pending"
          ))
        : undefined;
      if (
        pendingFork
        && (
          pendingFork.provider !== providerId
          || pendingFork.model !== body.model
          || pendingFork.profileId !== (providerId === "claude-code" ? body.profileId : null)
          || pendingFork.worktree !== context.worktree
        )
      ) {
        throw new LocalStateError(
          "The destination provider, profile, model, or worktree changed after the fork was reviewed.",
          409,
        );
      }
      const profile = providerId === "claude-code"
        ? await profiles.runtime(body.profileId as string)
        : null;
      const previousSession = typeof body.threadId === "string"
        ? projection.providerSessions.find(
          (session) => session.threadId === body.threadId && session.provider === providerId,
        )
        : undefined;
      const installedAdapter = isDeclarativeAdapter ? await adapters.version(providerId) : null;
      if (isDeclarativeAdapter && !installedAdapter) {
        throw new ProviderAdapterError(
          "This thread requires an adapter version that is unavailable. Reinstall that exact version or start a new conversation.",
          409,
        );
      }
      if (installedAdapter && !installedAdapter.enabled) {
        throw new ProviderAdapterError("The selected adapter is disabled.", 409);
      }
      if (
        profile
        &&
        previousSession?.continuationKey
        && previousSession.continuationKey !== profile.continuationKey
      ) {
        throw new ProfileError(
          "This thread can only continue with a Claude profile using the same Claude home.",
          409,
        );
      }
      if (
        body.resumeSessionId !== undefined
        && (!previousSession || body.resumeSessionId !== previousSession.sessionId)
      ) {
        throw new LocalStateError(
          "The provider session does not belong to the selected conversation.",
          409,
        );
      }
      const activeWorktreeKey = checkpointWorktreeKey(project.id, context.worktree);
      if (
        activeCheckpointProjects.has(project.id)
        || activeCheckpointWorktrees.has(activeWorktreeKey)
      ) {
        throw new LocalStateError("This worktree already has an active checkpoint capture.", 409);
      }
      activeCheckpointWorktrees.add(activeWorktreeKey);
      try {
      const persisted = await state.startTurn({
        projectId: project.id,
        worktree: context.worktree,
        prompt: body.prompt.trim(),
        mode,
        provider: providerId,
        threadId: body.threadId,
      });
      const forkPrompt = await state.pendingForkPrompt(persisted.thread.id);
      const effectiveProviderPrompt = forkPrompt
        ? `${forkPrompt}\n\nNew request:\n${providerPrompt}`
        : providerPrompt;
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
      const approvalUrl = internalApprovalUrl ?? (
        port
          ? Promise.resolve(`http://127.0.0.1:${port}/api/provider/permissions/request`)
          : Promise.reject(new RepositoryError("The local permission broker is unavailable.", 503))
      );
      let run;
      try {
        run = providerId === "codex-cli"
          ? await codex.start({
            repository: context.root,
            worktree: context.worktree,
            conversationId: body.conversationId,
            prompt: effectiveProviderPrompt,
            approvalUrl: await approvalUrl,
            mode,
            resumeSessionId: body.resumeSessionId,
            model: body.model === "default" ? undefined : body.model,
            reasoningEffort: body.reasoningEffort as ReasoningEffort | undefined,
          })
          : installedAdapter
          ? await (async () => {
              const executable = await adapters.resolveExecutable(installedAdapter);
              const adapter = new AcpProviderAdapter(installedAdapter, executable, permissions);
              const started = await adapter.start({
                repository: context.root,
                worktree: context.worktree,
                conversationId: body.conversationId,
                prompt: providerPrompt,
                approvalUrl: await approvalUrl,
                mode,
                resumeSessionId: body.resumeSessionId,
              });
              activeAcp.set(started.id, adapter);
              return started;
            })()
          : await provider.start(
            context.root,
            context.worktree,
            body.conversationId,
            effectiveProviderPrompt,
            await approvalUrl,
            mode,
            body.resumeSessionId,
            {
              executable: profile!.executable,
              environment: profile!.environment,
              model: body.model,
            },
          );
      } catch (error) {
        await state.recordProviderEvent(persisted.thread.id, persisted.turn.id, providerId, {
          kind: "failed",
          message: error instanceof ProviderProtocolError
            ? error.message
            : "The provider could not be started.",
        }, profile ? { profileId: profile.profile.id, continuationKey: profile.continuationKey } : undefined);
        await publishThreadStatusTransition(wake, state, persisted.thread.id, null);
        const checkpoint = (await state.load()).checkpoints.find((item) => item.id === checkpointId);
        if (checkpoint && checkpoint.state === "baseline") {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "failed",
            message: "Provider startup failed before checkpoint completion.",
          });
        }
        response.setHeader("x-thread-id", persisted.thread.id);
        response.setHeader("x-turn-id", persisted.turn.id);
        throw error;
      }
      try {
        await state.bindProviderRun(persisted.turn.id, run.id);
        await state.markForkStarted(persisted.thread.id);
      } catch (error) {
        if (providerId === "codex-cli") codex.cancel(run.id);
        else if (isDeclarativeAdapter) {
          activeAcp.get(run.id)?.cancel(run.id);
          activeAcp.delete(run.id);
        } else provider.cancel(run.id);
        throw error;
      }
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
      let previousStatus = projectThreadStatus(await state.load(), persisted.thread.id).status;
      // Starting a turn moves the thread to running before the first event.
      await publishThreadStatusTransition(wake, state, persisted.thread.id, null);
      previousStatus = projectThreadStatus(await state.load(), persisted.thread.id).status;
      for await (const event of run.events) {
        try {
          await state.recordProviderEvent(
            persisted.thread.id,
            persisted.turn.id,
            providerId,
            event,
            profile ? { profileId: profile.profile.id, continuationKey: profile.continuationKey } : undefined,
          );
          await publishThreadStatusTransition(wake, state, persisted.thread.id, previousStatus);
          previousStatus = projectThreadStatus(await state.load(), persisted.thread.id).status;
        } catch {
          if (providerId === "codex-cli") codex.cancel(run.id);
          else if (isDeclarativeAdapter) activeAcp.get(run.id)?.cancel(run.id);
          else provider.cancel(run.id);
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
      activeAcp.delete(run.id);
      return true;
      } finally {
        activeCheckpointWorktrees.delete(activeWorktreeKey);
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
      const decided = await permissions.decideAfter(
        approvalMatch[1],
        {
          runId: body.runId,
          conversationId: body.conversationId,
          repository: body.repository,
          worktree: body.worktree,
          toolCallId: body.toolCallId,
        },
        body.decision,
        async (resolution) => {
          const projection = await state.load();
          const turn = projection.turns.find((item) => item.providerRunId === body.runId);
          const thread = turn
            ? projection.threads.find((item) => item.id === turn.threadId)
            : undefined;
          if (!turn || !thread) {
            throw new LocalStateError("The provider turn is missing from local history.", 404);
          }
          await state.recordProviderEvent(
            thread.id,
            turn.id,
            thread.provider ?? "claude-code",
            { kind: "approval_resolved", id: resolution.id, state: resolution.state },
          );
        },
      );
      sendJson(response, 200, decided);
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
    if (route === "/api/reviews/set") {
      const body = await readJson(request) as {
        threadId?: unknown;
        path?: unknown;
        previousPath?: unknown;
        diffIdentity?: unknown;
        reviewed?: unknown;
      };
      if (
        typeof body.threadId !== "string"
        || typeof body.path !== "string"
        || typeof body.diffIdentity !== "string"
        || typeof body.reviewed !== "boolean"
        || (body.previousPath !== undefined && body.previousPath !== null && typeof body.previousPath !== "string")
      ) {
        throw new LocalStateError(
          "A conversation, file path, content identity, and reviewed flag are required.",
          400,
        );
      }
      sendJson(response, 200, await state.setFileReview({
        threadId: body.threadId,
        path: body.path,
        previousPath: typeof body.previousPath === "string" ? body.previousPath : null,
        diffIdentity: body.diffIdentity,
        reviewed: body.reviewed,
      }));
      return true;
    }
    if (route === "/api/annotations/list") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        threadId?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.threadId !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and conversation are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) => item.id === body.threadId
          && item.projectId === project?.id
          && item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      const annotations = projection.annotations.filter((item) => item.threadId === thread.id);
      const diffs = new Map<string, Awaited<ReturnType<typeof readFileDiff>> | null>();
      for (const path of new Set(annotations.map((item) => item.path))) {
        try {
          diffs.set(path, await readFileDiff(context.worktree, path));
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
      const body = await readJson(request) as {
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
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.threadId !== "string"
        || typeof body.path !== "string"
        || typeof body.diffIdentity !== "string"
        || (body.scope !== "file" && body.scope !== "line")
        || (body.scope === "line" && (!Number.isInteger(body.lineIndex) || (body.lineIndex as number) < 0))
        || typeof body.text !== "string"
        || !body.text.trim()
        || body.text.trim().length > MAX_ANNOTATION_TEXT
      ) {
        throw new RepositoryError("A valid annotation target and comment are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) => item.id === body.threadId
          && item.projectId === project?.id
          && item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      const diff = await readFileDiff(context.worktree, body.path);
      if (diff.identity !== body.diffIdentity) {
        throw new RepositoryError("The diff changed before the annotation was saved. Refresh and select it again.", 409);
      }
      const lineIndex = body.scope === "line" ? body.lineIndex as number : null;
      const line = lineIndex === null ? null : diff.lines.find((item) => item.index === lineIndex);
      if (body.scope === "line" && (!line || line.side === "metadata")) {
        throw new RepositoryError("Select an added, deleted, or context line.", 409);
      }
      const checkpoint = projection.checkpoints
        .filter((item) => item.threadId === thread.id && item.state === "completed")
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const now = new Date().toISOString();
      sendJson(response, 201, await state.saveAnnotation({
        id: randomUUID(),
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
      }));
      return true;
    }
    const annotationResolutionMatch = route.match(/^\/api\/annotations\/([0-9a-f-]+)\/resolution$/);
    if (annotationResolutionMatch) {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        threadId?: unknown;
        resolved?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.threadId !== "string"
        || typeof body.resolved !== "boolean"
      ) {
        throw new RepositoryError("A repository, worktree, conversation, and resolution state are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) => item.id === body.threadId
          && item.projectId === project?.id
          && item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      sendJson(response, 200, await state.setAnnotationResolution(
        annotationResolutionMatch[1],
        thread.id,
        body.resolved ? "resolved" : "unresolved",
      ));
      return true;
    }
    if (route === "/api/annotations/preview") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        threadId?: unknown;
        annotationIds?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.threadId !== "string"
        || !Array.isArray(body.annotationIds)
        || body.annotationIds.some((id) => typeof id !== "string")
      ) {
        throw new RepositoryError("A conversation and selected annotations are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) => item.id === body.threadId
          && item.projectId === project?.id
          && item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      const requested = new Set(body.annotationIds as string[]);
      const selected = projection.annotations.filter(
        (item) => item.threadId === thread.id && requested.has(item.id),
      );
      if (selected.length !== requested.size) {
        throw new LocalStateError("One or more selected annotations are unavailable.", 404);
      }
      const views = [];
      for (const item of selected) {
        let current = null;
        try {
          current = await readFileDiff(context.worktree, item.path);
        } catch {
          // Missing and no-longer-changed targets are represented as stale.
        }
        views.push(annotationView(item, current));
      }
      sendJson(response, 200, { prompt: formatRevisionContext(views), annotations: views });
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
      const acp = activeAcp.get(cancelMatch[1]);
      if (!provider.cancel(cancelMatch[1]) && !codex.cancel(cancelMatch[1]) && !acp?.cancel(cancelMatch[1])) {
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
      || error instanceof PreferencesError
      || error instanceof PreviewError
      || error instanceof ProviderAdapterError
      || error instanceof RemoteAuthError
      ? error.status
      : 500;
    const message = error instanceof RepositoryError
      || error instanceof ProviderProtocolError
      || error instanceof PermissionError
      || error instanceof LocalStateError
      || error instanceof ProfileError
      || error instanceof PreferencesError
      || error instanceof PreviewError
      || error instanceof ProviderAdapterError
      || error instanceof RemoteAuthError
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
  remoteAuth?: RemoteAuth,
  tls?: { key: Buffer; cert: Buffer },
) {
  const permissions = new PermissionBroker();
  const internalPermissionCallback = remoteAuth
    ? createInternalPermissionCallback(permissions)
    : undefined;
  const delivery = new DeliveryBroker();
  const provider = new ClaudeCodeAdapter("claude", permissions);
  const codex = new CodexCliAdapter("codex", permissions);
  const previews = new PreviewManager();
  const preferences = new PreferencesStore(state.directory);
  const worktrees = new WorktreeManager(state.directory);
  const directories = new DirectoryBrowser();
  const adapters = new ProviderAdapterStore(state.directory);
  const activeAcp = new Map<string, AcpProviderAdapter>();
  const wake = new WakeBroker();
  // Seed Claude Code default profile so first-run does not require Settings.
  const profileBootstrap = profiles.ensureDefaults().catch(() => undefined);
  const recovery = state.recoverInterruptedTurns();
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    await recovery;
    await profileBootstrap;
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    if (
      remoteAuth
      && route.startsWith("/api/")
      && route !== "/api/remote/pair"
      && route !== "/api/remote/descriptor"
    ) {
      try {
        await remoteAuth.verify(request, await bufferRequest(request));
      } catch (error) {
        const status = error instanceof RemoteAuthError ? error.status : 500;
        const message = error instanceof RemoteAuthError ? error.message : "Remote authentication failed.";
        sendJson(response, status, { error: message });
        return;
      }
    }
    if (
      await handleApi(
        request,
        response,
        provider,
        codex,
        permissions,
        delivery,
        state,
        profiles,
        previews,
        preferences,
        worktrees,
        directories,
        adapters,
        activeAcp,
        wake,
        Boolean(remoteAuth),
        remoteAuth,
        internalPermissionCallback?.url,
      )
    ) return;
    await serveStatic(request, response, dist);
  };
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  server.once("close", () => internalPermissionCallback?.server.close());
  return server;
}
