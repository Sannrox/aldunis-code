import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeCodeAdapter,
  type InteractionMode,
  type ProviderId,
  ProviderProtocolError,
} from "./provider.ts";
import { CodexCliAdapter } from "./codex-provider.ts";
import { AcpProviderAdapter } from "./acp-provider.ts";
import { buildUsageReport, isUsageRangeDays } from "../src/lib/usage.ts";
import { ShikigamiAdapter } from "./shikigami-provider.ts";
import { ProviderDiscovery } from "./provider-discovery.ts";
import {
  isAdapterProviderId,
  ProviderModelError,
  validateProviderModel,
} from "./provider-models.ts";
import {
  adapterReference,
  ProviderAdapterError,
  ProviderAdapterStore,
} from "./provider-adapters.ts";
import { listReviewedAdapters, prepareReviewedAdapter } from "./reviewed-adapters.ts";
import { listChangedFiles, readCheckpointFileDiff, readFileDiff } from "./changes.ts";
import {
  annotationView,
  captureAnnotationContext,
  formatRevisionContext,
  MAX_ANNOTATION_TEXT,
} from "./annotations.ts";
import {
  DeliveryBroker,
  draftPullRequest,
  inspectDelivery,
  type DeliveryAction,
} from "./delivery.ts";
import { BRANCH_PR_BATCH_LIMIT, inspectBranchPr, inspectBranchPrBatch } from "./branch-pr.ts";
import {
  ReleaseDeliveryBroker,
  ReleaseDeliveryStore,
  type ReleaseWorkflowAction,
} from "./release-delivery-workflow.ts";
import { PermissionBroker, PermissionError, type ApprovalSnapshot } from "./permission.ts";
import { assertParentRoutedApproval, projectDelegatedApprovals } from "./delegated-approvals.ts";
import { assertParentRoutedInput, projectDelegatedInputs } from "./delegated-inputs.ts";
import {
  canonicalizeRepositoryRoot,
  captureCheckpoint,
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
  projectDelegatedConversationOutcomes,
  projectThreadStatus,
  projectThreadStatuses,
  type StateProjection,
  type ThreadStatus,
} from "./state.ts";
import {
  ClaudeProfileStore,
  DEFAULT_SHIKIGAMI_PROFILE_ID,
  ProfileError,
  type AdapterProfileSeed,
  type ProfileProbeKind,
} from "./profiles.ts";
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
import { PreviewError, PreviewManager } from "./preview.ts";
import { projectConversationHistory, projectWorkbenchState } from "./state-projection.ts";
import { PreferencesError, PreferencesStore } from "./preferences.ts";
import {
  AutomationError,
  AutomationScheduler,
  AutomationStore,
  type Automation,
  type AutomationFire,
  type AutomationFireExecution,
  type AutomationSchedule,
} from "./automations.ts";
import { AutonomyScheduler, AutonomyEngine } from "./autonomy-engine.ts";
import {
  AutonomyError,
  parseAutonomyHook,
  parseHeartbeatMonitor,
  parseStandingOrder,
  type AutonomyHookEvent,
  type HeartbeatMonitor,
} from "./autonomy.ts";
import { WorktreeManager } from "./worktrees.ts";
import { RemoteAuth, RemoteAuthError } from "./remote-auth.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { WakeBroker } from "./wake.ts";
import { resolveProductAvailability } from "./products.ts";
import { ManagedHost, ManagedHostError, type ManagedIdentity } from "./managed-host.ts";
import { BrowserError, SharedBrowserBroker, type BrowserHost } from "./browser.ts";
import { ChiseiClientError, ChiseiProjectionClient } from "./chisei-client.ts";
import type { WorkspaceMode } from "../src/types.ts";
import { handleProviderRun } from "./provider-run.ts";
import { handleBrowserRoute } from "./browser-routes.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  return address.replace(/^::ffff:/i, "").replace(/^\[(.*)\]$/, "$1");
}

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  return LOOPBACK_HOSTS.has(normalized);
}

function requestHostName(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;
  try {
    return normalizeAddress(new URL(`http://${host}`).hostname);
  } catch {
    return undefined;
  }
}

function isLoopbackHostHeader(request: IncomingMessage): boolean {
  return isLoopbackAddress(requestHostName(request));
}

export function isLocalControlRequest(
  request: IncomingMessage,
  localBindHost?: string,
  publicOrigin?: string,
): boolean {
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedAddresses =
    typeof forwarded === "string"
      ? forwarded
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  if (!forwardedAddresses.every((address) => isLoopbackAddress(address))) return false;
  if (isLoopbackAddress(request.socket.remoteAddress) && isLoopbackHostHeader(request)) return true;
  const boundAddress = normalizeAddress(localBindHost);
  let publicOriginHost: string | undefined;
  if (publicOrigin) {
    try {
      publicOriginHost = normalizeAddress(new URL(publicOrigin).hostname);
    } catch {
      publicOriginHost = undefined;
    }
  }
  const requestHost = requestHostName(request);
  return Boolean(
    boundAddress &&
    normalizeAddress(request.socket.remoteAddress) === boundAddress &&
    (requestHost === boundAddress ||
      (!isLoopbackAddress(boundAddress) && requestHost === publicOriginHost)),
  );
}

function adapterProfileSeed(adapter: {
  manifest: {
    id: string;
    version: string;
    presentation: { name: string };
    executable: { names: string[] };
    environment: Array<{ name: string; required: boolean; sensitive: boolean }>;
  };
}): AdapterProfileSeed {
  return {
    provider: adapterReference(adapter.manifest),
    name: adapter.manifest.presentation.name,
    binaryPath: adapter.manifest.executable.names[0] ?? "",
    environment: adapter.manifest.environment
      .filter((entry) => entry.required || entry.sensitive)
      .map((entry) => ({
        name: entry.name,
        sensitive: entry.sensitive,
        value: "",
      })),
  };
}

const MAX_BODY_BYTES = 128 * 1024;
/** Base64 image staging: 2 MiB raw ≈ 2.7 MiB encoded, plus JSON envelope. */
const MAX_STAGE_IMAGE_BODY_BYTES = 3 * 1024 * 1024;
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

function filterManagedProjection(
  projection: StateProjection,
  managedHost: ManagedHost,
): StateProjection {
  const projects = projection.projects.filter((project) => {
    try {
      managedHost.repositoryForRoot(project.root);
      return true;
    } catch {
      return false;
    }
  });
  const projectIds = new Set(projects.map((project) => project.id));
  const threads = projection.threads.filter((thread) => projectIds.has(thread.projectId));
  const threadIds = new Set(threads.map((thread) => thread.id));
  const turns = projection.turns.filter((turn) => threadIds.has(turn.threadId));
  const turnIds = new Set(turns.map((turn) => turn.id));
  return {
    ...projection,
    projects,
    threads,
    turns,
    messages: projection.messages.filter((message) => turnIds.has(message.turnId)),
    activities: projection.activities.filter((activity) => turnIds.has(activity.turnId)),
    plans: projection.plans.filter(
      (plan) => threadIds.has(plan.threadId) && turnIds.has(plan.turnId),
    ),
    contextReceipts: projection.contextReceipts.filter(
      (receipt) => threadIds.has(receipt.threadId) && turnIds.has(receipt.turnId),
    ),
    usageReceipts: projection.usageReceipts.filter(
      (receipt) => threadIds.has(receipt.threadId) && turnIds.has(receipt.turnId),
    ),
    governanceCorrelations: projection.governanceCorrelations.filter((receipt) =>
      threadIds.has(receipt.threadId),
    ),
    providerSessions: projection.providerSessions.filter((session) =>
      threadIds.has(session.threadId),
    ),
    checkpoints: projection.checkpoints.filter(
      (checkpoint) => threadIds.has(checkpoint.threadId) && turnIds.has(checkpoint.turnId),
    ),
    annotations: projection.annotations.filter((annotation) => threadIds.has(annotation.threadId)),
    fileReviews: projection.fileReviews.filter((review) => threadIds.has(review.threadId)),
    conversationDeletions: projection.conversationDeletions.filter((deletion) =>
      threadIds.has(deletion.threadId),
    ),
    forks: projection.forks.filter(
      (fork) => threadIds.has(fork.sourceThreadId) && threadIds.has(fork.destinationThreadId),
    ),
    delegatedRelationships: projection.delegatedRelationships.filter(
      (relationship) =>
        threadIds.has(relationship.parentThreadId) && threadIds.has(relationship.childThreadId),
    ),
    inputRequests: projection.inputRequests.filter((request) => threadIds.has(request.threadId)),
    inputReceipts: projection.inputReceipts.filter(
      (receipt) =>
        threadIds.has(receipt.childThreadId) &&
        (receipt.parentThreadId === null || threadIds.has(receipt.parentThreadId)),
    ),
    autonomyRuns: projection.autonomyRuns.filter(
      (run) => run.projectId === null || projectIds.has(run.projectId),
    ),
    autonomyTasks: projection.autonomyTasks.filter((task) => {
      const run = projection.autonomyRuns.find((candidate) => candidate.id === task.runId);
      return run?.projectId === null || (run?.projectId ? projectIds.has(run.projectId) : false);
    }),
    autonomyFlows: projection.autonomyFlows,
    heartbeatMonitors: projection.heartbeatMonitors.filter(
      (monitor) => monitor.projectId === null || projectIds.has(monitor.projectId),
    ),
    standingOrders: projection.standingOrders.filter(
      (order) => order.projectId === null || projectIds.has(order.projectId),
    ),
    autonomyHooks: projection.autonomyHooks.filter(
      (hook) => hook.projectId === null || projectIds.has(hook.projectId),
    ),
  };
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
  force = false,
): Promise<void> {
  const next = projectThreadStatus(await state.load(), threadId);
  if (!force && previous !== null && previous === next.status) return;
  wake.publish({
    threadId,
    status: next.status,
    at: new Date().toISOString(),
  });
}

type DelegatedControlLock = <T>(action: () => Promise<T>) => Promise<T>;

async function readJson(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  const cached = requestBodies.get(request);
  if (cached) {
    if (cached.byteLength > maxBytes) throw new RepositoryError("Request body is too large.", 413);
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
    if (size > maxBytes) throw new RepositoryError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RepositoryError("Request body must be valid JSON.");
  }
}

async function readOptionalJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    return Number.parseInt(contentLength, 10) > 0 ? readJson(request) : {};
  }
  return request.headers["transfer-encoding"] ? readJson(request) : {};
}

function maxBodyBytesForRoute(route: string): number {
  return route === "/api/context/stage-image" ? MAX_STAGE_IMAGE_BODY_BYTES : MAX_BODY_BYTES;
}

async function bufferRequest(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new RepositoryError("Request body is too large.", 413);
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

async function selectWorktreeForRepository(
  rootInput: string,
  worktreeInput: string,
): Promise<{ root: string; worktree: string }> {
  const root = await canonicalizeRepositoryRoot(rootInput);
  const selected = await realpath(worktreeInput);
  const worktrees = await discoverWorktrees(root);
  const allowed = await Promise.all(
    worktrees.map(async (worktree) => {
      try {
        return await realpath(worktree.path);
      } catch {
        return null;
      }
    }),
  );
  if (!allowed.includes(selected)) {
    throw new RepositoryError("Select a discovered worktree from the opened repository.", 403);
  }
  return { root, worktree: selected };
}

async function managedWorktreePath(root: string, branch: string): Promise<string> {
  const parent = dirname(root);
  const [rootDetails, parentDetails] = await Promise.all([stat(root), stat(parent)]);
  if (rootDetails.dev !== parentDetails.dev) {
    throw new RepositoryError(
      "Managed worktree creation requires the repository parent to share its filesystem.",
      403,
    );
  }
  const safeBranch =
    branch
      .trim()
      .replaceAll("/", "-")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 120) || "worktree";
  return join(parent, ".aldunis-worktrees", basename(root), safeBranch);
}

async function selectedReleaseProject(
  state: LocalStateStore,
  projectId: string,
  context: { root: string; worktree: string },
) {
  const projection = await state.load();
  const project = projection.projects.find((item) => item.id === projectId);
  if (
    !project ||
    (await repositoryCommonDir(project.root)) !== (await repositoryCommonDir(context.root))
  ) {
    throw new RepositoryError("The selected release project is unavailable.", 404);
  }
  const exactWorktreeProjects: string[] = [];
  for (const candidate of projection.projects) {
    try {
      if (
        (await repositoryCommonDir(candidate.root)) === (await repositoryCommonDir(context.root)) &&
        (await realpath(candidate.root)) === context.worktree
      ) {
        exactWorktreeProjects.push(candidate.id);
      }
    } catch {
      // Missing project records cannot authorize a local release.
    }
  }
  if (exactWorktreeProjects.length > 0 && !exactWorktreeProjects.includes(project.id)) {
    throw new RepositoryError("The selected release project does not own this worktree.", 404);
  }
  if (exactWorktreeProjects.length === 0 && (await realpath(project.root)) !== context.root) {
    throw new RepositoryError("The selected release project does not own this worktree.", 404);
  }
  return project;
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
      const body = (await readJson(request)) as {
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
      const message =
        error instanceof PermissionError ? error.message : "Permission request failed.";
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

interface LocalApiDispatchContext {
  provider: ClaudeCodeAdapter;
  codex: CodexCliAdapter;
  shikigami: ShikigamiAdapter;
  permissions: PermissionBroker;
  delivery: DeliveryBroker;
  releaseDelivery: ReleaseDeliveryBroker;
  state: LocalStateStore;
  profiles: ClaudeProfileStore;
  previews: PreviewManager;
  preferences: PreferencesStore;
  automations: AutomationStore;
  automationScheduler: AutomationScheduler;
  autonomy: AutonomyEngine;
  worktrees: WorktreeManager;
  directories: DirectoryBrowser;
  adapters: ProviderAdapterStore;
  providerDiscovery: ProviderDiscovery;
  activeAcp: Map<string, AcpProviderAdapter>;
  wake: WakeBroker;
  withDelegatedControlLock: DelegatedControlLock;
  runChildFollowUp: (body: Record<string, unknown>) => Promise<void>;
  chisei: ChiseiProjectionClient;
  remoteAuth?: RemoteAuth;
  internalApprovalUrl?: Promise<string>;
  managedHost?: ManagedHost;
  browser?: SharedBrowserBroker | null;
  browserMcpPath?: string;
  publicOrigin?: string | (() => string | undefined);
  remoteRequest: boolean;
  internalRequest: boolean;
  localControlRequest: boolean;
  managedIdentity?: ManagedIdentity;
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  context: LocalApiDispatchContext,
): Promise<boolean> {
  const {
    provider,
    codex,
    shikigami,
    permissions,
    delivery,
    releaseDelivery,
    state,
    profiles,
    previews,
    preferences,
    automations,
    automationScheduler,
    autonomy,
    worktrees,
    directories,
    adapters,
    providerDiscovery,
    activeAcp,
    wake,
    withDelegatedControlLock,
    runChildFollowUp,
    chisei,
    remoteAuth,
    internalApprovalUrl,
    managedHost,
    browser,
    browserMcpPath,
    publicOrigin,
    remoteRequest,
    internalRequest,
    localControlRequest,
    managedIdentity,
  } = context;
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (!route.startsWith("/api/")) return false;
  const isWakeStream = request.method === "GET" && route === "/api/state/events";
  if (request.method !== "POST" && !isWakeStream) {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return true;
  }
  const selectedWorktree = managedHost
    ? (root: string, worktree: string) => managedHost.selectWorktree(root, worktree)
    : selectWorktreeForRepository;
  const assertManagedProject = (projection: StateProjection, projectId: string) => {
    const project = projection.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new LocalStateError("The selected project is not available.", 404);
    if (managedHost) managedHost.repositoryForRoot(project.root);
    return project;
  };
  const assertManagedThread = (projection: StateProjection, threadId: string) => {
    const thread = projection.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
    const project = assertManagedProject(projection, thread.projectId);
    return { thread, project };
  };
  if (!isAllowedOrigin(request, Boolean(remoteAuth || managedHost))) {
    sendJson(response, 403, { error: "Repository access is limited to the local application." });
    return true;
  }

  try {
    if (route === "/api/usage/summary") {
      const body = await readOptionalJson(request);
      const requestedRange = isRecord(body) ? body.rangeDays : undefined;
      const rangeDays = requestedRange === undefined ? 30 : requestedRange;
      if (!isUsageRangeDays(rangeDays)) {
        throw new LocalStateError("Usage range must be 7, 30, or 90 days.", 400);
      }
      const projection = await state.load();
      const visibleProjection = managedHost
        ? filterManagedProjection(projection, managedHost)
        : projection;
      sendJson(response, 200, buildUsageReport(visibleProjection.usageReceipts, rangeDays));
      return true;
    }
    if (
      await handleBrowserRoute(route, request, response, {
        browser,
        remoteRequest,
        managed: Boolean(managedHost),
        loadState: () => state.load(),
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    )
      return true;
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
        if (!managedHost) {
          response.write(`event: thread_status\ndata: ${JSON.stringify(event)}\n\n`);
          return;
        }
        void state
          .load()
          .then((projection) => {
            if (response.writableEnded) return;
            const visible = filterManagedProjection(projection, managedHost);
            if (!visible.threads.some((thread) => thread.id === event.threadId)) return;
            response.write(`event: thread_status\ndata: ${JSON.stringify(event)}\n\n`);
          })
          .catch(() => undefined);
      });
      const heartbeat = setInterval(() => {
        if (response.writableEnded) return;
        response.write(": heartbeat\n\n");
      }, 30_000);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.on("close", cleanup);
      response.on("close", cleanup);
      return true;
    }
    if (route === "/api/host/capabilities") {
      sendJson(
        response,
        200,
        managedHost
          ? managedHost.capabilities(managedIdentity)
          : {
              mode: remoteAuth ? "remote" : "local",
              managed: false,
              tenantScoped: false,
              capabilities: {
                providerSelection: true,
                profileAdministration: !remoteRequest,
                adapterAdministration: !remoteRequest,
                modelSelection: true,
                modeSelection: true,
                arbitraryRepositorySelection: !remoteRequest,
                directoryBrowsing: !remoteAuth,
              },
            },
      );
      return true;
    }
    if (route === "/api/providers/discover") {
      const body = await readOptionalJson(request);
      if (!isRecord(body))
        throw new RepositoryError("Provider discovery context must be an object.");
      const hasRoot = body.root !== undefined;
      const hasWorktree = body.worktree !== undefined;
      if (
        hasRoot !== hasWorktree ||
        (hasRoot && (typeof body.root !== "string" || typeof body.worktree !== "string"))
      ) {
        throw new RepositoryError(
          "Provider discovery requires both a repository root and worktree.",
        );
      }
      const discoveryCwd = hasRoot
        ? (await selectedWorktree(body.root as string, body.worktree as string)).worktree
        : process.cwd();
      sendJson(response, 200, await providerDiscovery.discover({ cwd: discoveryCwd }));
      return true;
    }
    if (route === "/api/provider/adapters/list") {
      if (managedHost) {
        sendJson(response, 200, { adapters: [], administrationAvailable: false });
        return true;
      }
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
      if (managedHost) {
        sendJson(response, 200, { adapters: [], administrationAvailable: false });
        return true;
      }
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
      if (remoteRequest || managedHost)
        throw new ProviderAdapterError(
          "This host cannot administer provider adapters in the active mode.",
          403,
        );
      const body = (await readJson(request)) as { slug?: unknown };
      const prepared = await prepareReviewedAdapter(adapters, body.slug);
      sendJson(response, 200, prepared);
      return true;
    }
    if (route === "/api/provider/adapters/inspect") {
      if (managedHost)
        throw new ProviderAdapterError(
          "Provider adapter administration is unavailable in managed hosted mode.",
          403,
        );
      const body = (await readJson(request)) as {
        source?: unknown;
        digest?: unknown;
        manifest?: unknown;
      };
      sendJson(response, 200, adapters.inspect(body));
      return true;
    }
    if (route === "/api/provider/adapters/install" || route === "/api/provider/adapters/update") {
      if (remoteRequest || managedHost)
        throw new ProviderAdapterError(
          "This host cannot administer provider adapters in the active mode.",
          403,
        );
      const body = (await readJson(request)) as {
        source?: unknown;
        digest?: unknown;
        manifest?: unknown;
        approved?: unknown;
      };
      if (body.approved !== true)
        throw new ProviderAdapterError("Explicit adapter approval is required.", 403);
      const installed = route.endsWith("/install")
        ? await adapters.install(body)
        : await adapters.update(body);
      // Every installed adapter gets a stable default profile (may be empty).
      await profiles.ensureProviderDefault(adapterProfileSeed(installed));
      sendJson(response, 200, installed);
      return true;
    }
    const adapterAction = route.match(
      /^\/api\/provider\/adapters\/([a-z0-9.-]+)\/(enable|disable|rollback|uninstall)$/,
    );
    if (adapterAction) {
      if (remoteRequest || managedHost)
        throw new ProviderAdapterError(
          "This host cannot administer provider adapters in the active mode.",
          403,
        );
      const body = (await readJson(request)) as { approved?: unknown };
      if (body.approved !== true)
        throw new ProviderAdapterError("Explicit adapter approval is required.", 403);
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
    const remoteAdminAction = route.match(/^\/api\/remote\/admin\/(status|pair|revoke)$/);
    if (remoteAdminAction) {
      if (!localControlRequest || managedHost) {
        throw new RemoteAuthError(
          "Remote access administration is available only from the local host.",
          403,
        );
      }
      const action = remoteAdminAction[1];
      if (action === "status") {
        sendJson(response, 200, {
          remoteEnabled: Boolean(remoteAuth),
          descriptor: remoteAuth ? await remoteAuth.descriptor() : null,
          sessions: remoteAuth ? await remoteAuth.listSessions() : [],
        });
        return true;
      }
      if (!remoteAuth) throw new RemoteAuthError("Remote access is disabled.", 404);
      if (action === "pair") {
        const configuredOrigin = typeof publicOrigin === "function" ? publicOrigin() : publicOrigin;
        if (publicOrigin !== undefined && !configuredOrigin) {
          throw new RemoteAuthError("The public remote origin is not ready.", 503);
        }
        const origin = configuredOrigin
          ? new URL(configuredOrigin).origin
          : (() => {
              const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
              const protocol = encrypted ? "https" : "http";
              const host = request.headers.host ?? "localhost";
              return `${protocol}://${host}`;
            })();
        const pairing = await remoteAuth.issuePairing();
        sendJson(response, 200, {
          ...pairing,
          pairingUrl: `${origin}/#pair=${pairing.credential}`,
        });
        return true;
      }
      const body = (await readJson(request)) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
        throw new RemoteAuthError("A remote session is required.", 400);
      }
      sendJson(response, 200, { revoked: await remoteAuth.revoke(body.sessionId) });
      return true;
    }
    if (route === "/api/remote/pair") {
      if (managedHost)
        throw new RemoteAuthError("Remote pairing is unavailable in managed hosted mode.", 404);
      if (!remoteAuth) throw new RemoteAuthError("Remote access is disabled.", 404);
      const body = (await readJson(request)) as {
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
      if (managedHost) {
        sendJson(response, 200, { remoteEnabled: false, hostedMode: true });
        return true;
      }
      if (!remoteAuth) {
        sendJson(response, 200, { remoteEnabled: false });
        return true;
      }
      sendJson(response, 200, { remoteEnabled: true, ...(await remoteAuth.descriptor()) });
      return true;
    }
    if (route === "/api/repositories/open") {
      const body = (await readJson(request)) as { path?: unknown; repositoryId?: unknown };
      let managedRepositoryId: string | undefined;
      const repository = managedHost
        ? await (async () => {
            if (typeof body.repositoryId !== "string" || body.path !== undefined) {
              throw new RepositoryError("Select a repository from the managed catalogue.", 403);
            }
            const managedRepository = managedHost.repository(body.repositoryId);
            await managedHost.verifyRepository(managedRepository);
            managedRepositoryId = managedRepository.id;
            return openRepository(managedRepository.root);
          })()
        : await (async () => {
            if (typeof body.path !== "string") {
              throw new RepositoryError("A repository path is required.");
            }
            return openRepository(body.path);
          })();
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
              if ((await repositoryCommonDir(candidate.root)) === commonDir) {
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
      sendJson(response, 200, {
        ...repository,
        projectId: project.id,
        ...(managedRepositoryId ? { managedRepositoryId } : {}),
      });
      return true;
    }
    if (route === "/api/projects/list") {
      const projection = await state.load();
      const projects = await collapseProjectsByRepository(projection.projects);
      const visibleProjects = managedHost
        ? projects.filter((project) => {
            try {
              managedHost.repositoryForRoot(project.root);
              return true;
            } catch {
              return false;
            }
          })
        : projects;
      sendJson(response, 200, {
        projects: visibleProjects.map((project) => ({
          ...project,
          ...(managedHost
            ? { managedRepositoryId: managedHost.repositoryForRoot(project.root).id }
            : {}),
        })),
        chiseiBindingAdministrationAvailable: !remoteRequest && !managedHost,
      });
      return true;
    }
    if (route === "/api/integrations/chisei/bind") {
      if (remoteRequest || managedHost) {
        throw new LocalStateError(
          "This host cannot administer Chisei project bindings in the active mode.",
          403,
        );
      }
      const body = (await readJson(request)) as { projectId?: unknown; namespace?: unknown };
      if (
        typeof body.projectId !== "string" ||
        (body.namespace !== null && typeof body.namespace !== "string")
      ) {
        throw new LocalStateError("A project and Chisei namespace are required.", 400);
      }
      const project = await state.bindProjectChiseiNamespace(
        body.projectId,
        body.namespace as string | null,
      );
      sendJson(response, 200, {
        projectId: project.id,
        chiseiNamespace: project.chiseiNamespace ?? null,
      });
      return true;
    }
    if (route === "/api/integrations/chisei/actions/list") {
      const body = (await readJson(request)) as {
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
      const project = (await state.load()).projects.find((item) => item.id === body.projectId);
      if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
      if (!project.chiseiNamespace) {
        throw new ChiseiClientError(
          "This project is not bound to a Chisei namespace.",
          409,
          "unconfigured",
        );
      }
      sendJson(
        response,
        200,
        await chisei.listActions(project.id, project.chiseiNamespace, {
          typeId: body.typeId?.trim().slice(0, 200),
          status: body.status?.trim().slice(0, 50),
          limit: body.limit as number | undefined,
        }),
      );
      return true;
    }
    if (route === "/api/integrations/chisei/actions/detail") {
      const body = (await readJson(request)) as { projectId?: unknown; instanceId?: unknown };
      if (
        typeof body.projectId !== "string" ||
        typeof body.instanceId !== "string" ||
        !body.instanceId ||
        body.instanceId.length > 200
      ) {
        throw new LocalStateError("A valid local project and Action id are required.", 400);
      }
      const project = (await state.load()).projects.find((item) => item.id === body.projectId);
      if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
      if (!project.chiseiNamespace) {
        throw new ChiseiClientError(
          "This project is not bound to a Chisei namespace.",
          409,
          "unconfigured",
        );
      }
      sendJson(response, 200, await chisei.actionDetail(project.chiseiNamespace, body.instanceId));
      return true;
    }
    if (route === "/api/integrations/chisei/observations/detail") {
      const body = (await readJson(request)) as { projectId?: unknown; requestId?: unknown };
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
      const project = (await state.load()).projects.find((item) => item.id === body.projectId);
      if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
      if (!project.chiseiNamespace) {
        throw new ChiseiClientError(
          "This project is not bound to a Chisei namespace.",
          409,
          "unconfigured",
        );
      }
      const observation = await chisei.sampleObservation(project.chiseiNamespace, body.requestId);
      if (!observation) {
        throw new LocalStateError(
          "The Chisei observation is unavailable on the read surface.",
          404,
        );
      }
      sendJson(response, 200, observation);
      return true;
    }
    if (route === "/api/integrations/chisei/operations/detail") {
      const body = (await readJson(request)) as {
        projectId?: unknown;
        correlationId?: unknown;
      };
      if (typeof body.projectId !== "string" || typeof body.correlationId !== "string") {
        throw new LocalStateError("A project and governance correlation are required.", 400);
      }
      const projection = await state.load();
      const correlation = projection.governanceCorrelations.find(
        (item) => item.id === body.correlationId,
      );
      const thread = correlation
        ? projection.threads.find((item) => item.id === correlation.threadId)
        : null;
      if (!correlation || !thread || thread.projectId !== body.projectId) {
        throw new LocalStateError("The governance correlation is unavailable.", 404);
      }
      sendJson(response, 200, await chisei.operationReceipt(correlation.operationId));
      return true;
    }
    if (route === "/api/directories/browse") {
      if (remoteAuth || managedHost) {
        throw new RepositoryError(
          "Remote clients cannot browse the host filesystem without a directory grant.",
          403,
        );
      }
      const body = (await readJson(request)) as { path?: unknown; includeHidden?: unknown };
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
      sendJson(
        response,
        200,
        await directories.browse({
          path: body.path,
          includeHidden: body.includeHidden,
          signal: controller.signal,
        }),
      );
      return true;
    }
    if (route === "/api/worktrees/create/preview") {
      const body = (await readJson(request)) as {
        root?: unknown;
        base?: unknown;
        branch?: unknown;
        path?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.base !== "string" ||
        typeof body.branch !== "string" ||
        (body.path !== undefined && typeof body.path !== "string")
      ) {
        throw new RepositoryError("A repository, base revision, and new branch are required.");
      }
      const managedRoot = managedHost
        ? (await managedHost.selectWorktree(body.root, body.root)).root
        : body.root;
      if (managedHost && body.path !== undefined) {
        throw new RepositoryError(
          "Managed hosted mode does not accept arbitrary worktree paths.",
          403,
        );
      }
      const managedPath = managedHost
        ? await managedWorktreePath(managedRoot, body.branch)
        : undefined;
      const { preferences: currentPreferences } = await preferences.load();
      sendJson(
        response,
        200,
        await worktrees.previewCreate({
          repository: managedRoot,
          base: body.base,
          branch: body.branch,
          ...(managedPath ? { path: managedPath } : {}),
          ...(typeof body.path === "string" ? { path: body.path } : {}),
          limit: currentPreferences.managedWorktreeLimit,
        }),
      );
      return true;
    }
    if (route === "/api/worktrees/create") {
      const body = (await readJson(request)) as { planId?: unknown; confirm?: unknown };
      if (typeof body.planId !== "string" || body.confirm !== true) {
        throw new RepositoryError("A complete scoped worktree approval is required.");
      }
      if (managedHost)
        await managedHost.verifyRepositoryRoot(worktrees.creationPlan(body.planId).repository);
      const { preferences: currentPreferences } = await preferences.load();
      const created = await worktrees.create(body.planId, currentPreferences.managedWorktreeLimit);
      const repository = await openRepository(created.repository);
      repository.worktrees = await worktrees.list(created.repository);
      const projection = await state.load();
      const project = projection.projects.find(
        (candidate) => candidate.root === created.repository,
      );
      const managedRepositoryId = managedHost
        ? managedHost.repositoryForRoot(created.repository).id
        : undefined;
      sendJson(response, 200, {
        ...repository,
        projectId: project?.id,
        selectedWorktree: created.path,
        ...(managedRepositoryId ? { managedRepositoryId } : {}),
      });
      return true;
    }
    if (route === "/api/worktrees/remove/preview") {
      const body = (await readJson(request)) as { root?: unknown; path?: unknown };
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
      const body = (await readJson(request)) as { planId?: unknown; confirm?: unknown };
      if (typeof body.planId !== "string" || body.confirm !== true) {
        throw new RepositoryError("A complete scoped worktree removal approval is required.");
      }
      const plan = worktrees.removalPlan(body.planId);
      if (managedHost) await managedHost.verifyRepositoryRoot(plan.repository);
      const projection = await state.load();
      const project = projection.projects.find((candidate) => candidate.root === plan.repository);
      let projectLockAcquired = false;
      try {
        if (project && activeCheckpointProjects.has(project.id)) {
          throw new LocalStateError(
            "Wait for the active conversation operation before removing its worktree.",
            409,
          );
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
      // Inspect avoids cloning multi-MB transcript arrays that this route never
      // returns; workbench/list consumers only need lifecycle metadata.
      const projection = await state.inspect();
      const visibleProjection = managedHost
        ? filterManagedProjection(projection as StateProjection, managedHost)
        : (projection as StateProjection);
      const workbench = projectWorkbenchState(visibleProjection);
      const { preferences: currentPreferences } = await preferences.load();
      sendJson(response, 200, {
        ...workbench,
        delegatedRelationships: currentPreferences.orchestrationThreadsBeta
          ? workbench.delegatedRelationships
          : [],
        delegatedOutcomes: currentPreferences.orchestrationThreadsBeta
          ? projectDelegatedConversationOutcomes(visibleProjection)
          : [],
        delegatedApprovals: currentPreferences.orchestrationThreadsBeta
          ? projectDelegatedApprovals(
              visibleProjection,
              permissions.approvals().filter((approval) => {
                if (!managedHost) return true;
                try {
                  managedHost.repositoryForRoot(approval.repository);
                  return visibleProjection.threads.some(
                    (thread) => thread.id === approval.conversationId,
                  );
                } catch {
                  return false;
                }
              }),
            )
          : [],
        delegatedInputs: currentPreferences.orchestrationThreadsBeta
          ? projectDelegatedInputs(visibleProjection)
          : [],
        threadStatuses: projectThreadStatuses(visibleProjection),
        managedWorktreeCount: await worktrees.countActiveManaged(),
        managedWorktreeLimit: currentPreferences.managedWorktreeLimit,
        managedWorktreePaths: await worktrees.listActiveManagedPaths(),
      });
      return true;
    }
    if (route === "/api/state/conversations/history") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string" || !body.threadId) {
        throw new LocalStateError("A conversation is required.", 400);
      }
      const projection = await state.inspect();
      if (managedHost) assertManagedThread(projection as StateProjection, body.threadId);
      const history = projectConversationHistory(projection as StateProjection, body.threadId);
      if (!history) throw new LocalStateError("The conversation is unavailable.", 404);
      sendJson(response, 200, history);
      return true;
    }
    if (route === "/api/forks/preview") {
      if (managedHost) {
        throw new LocalStateError(
          "Conversation forks are unavailable in managed hosted mode.",
          403,
        );
      }
      const body = (await readJson(request)) as { sourceThreadId?: unknown };
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
      const body = (await readJson(request)) as {
        sourceThreadId?: unknown;
        provider?: unknown;
        profileId?: unknown;
        model?: unknown;
        expectedDigest?: unknown;
        worktree?: unknown;
        workspaceMode?: unknown;
      };
      const providerValue = typeof body.provider === "string" ? body.provider : null;
      const supportedProvider =
        providerValue === "claude-code" ||
        providerValue === "codex-cli" ||
        providerValue === "shikigami" ||
        (providerValue !== null && isAdapterProviderId(providerValue));
      if (
        typeof body.sourceThreadId !== "string" ||
        !supportedProvider ||
        typeof body.model !== "string" ||
        !body.model ||
        typeof body.expectedDigest !== "string" ||
        (body.worktree !== undefined && typeof body.worktree !== "string") ||
        (body.workspaceMode !== undefined &&
          !["shared", "aldunis-managed", "provider-native"].includes(
            body.workspaceMode as string,
          )) ||
        (providerValue === "claude-code" && typeof body.profileId !== "string") ||
        (providerValue === "codex-cli" && body.profileId !== null) ||
        (providerValue !== "claude-code" &&
          providerValue !== "shikigami" &&
          providerValue !== "codex-cli" &&
          body.profileId !== null) ||
        (providerValue === "shikigami" &&
          body.profileId !== undefined &&
          body.profileId !== null &&
          typeof body.profileId !== "string")
      ) {
        throw new LocalStateError(
          "A source conversation, destination provider, profile, model, and reviewed context size are required.",
          400,
        );
      }
      if (managedHost) {
        throw new LocalStateError(
          "Conversation forks are unavailable in managed hosted mode.",
          403,
        );
      }
      const projection = await state.load();
      const source = projection.threads.find((thread) => thread.id === body.sourceThreadId);
      const project = source
        ? projection.projects.find((candidate) => candidate.id === source.projectId)
        : undefined;
      if (!source || !project)
        throw new LocalStateError("The source conversation is unavailable.", 404);
      await selectedWorktree(project.root, source.worktree);
      const sourceWorkspaceMode = source.workspaceMode ?? "shared";
      const requestedWorkspaceMode = body.workspaceMode as WorkspaceMode | undefined;
      const destinationWorkspaceMode =
        requestedWorkspaceMode ??
        (sourceWorkspaceMode === "aldunis-managed" ? "aldunis-managed" : "shared");
      let destinationWorktree = source.worktree;
      if (sourceWorkspaceMode === "aldunis-managed") {
        if (destinationWorkspaceMode !== "aldunis-managed" || typeof body.worktree !== "string") {
          throw new LocalStateError(
            "A fork from an Aldunis-managed conversation requires a separately approved Aldunis worktree.",
            409,
          );
        }
        destinationWorktree = (await selectedWorktree(project.root, body.worktree)).worktree;
        if (destinationWorktree === source.worktree) {
          throw new LocalStateError(
            "A fork from an Aldunis-managed conversation cannot reuse its source worktree.",
            409,
          );
        }
        const selected = (await worktrees.list(project.root)).find(
          (candidate) => candidate.path === destinationWorktree,
        );
        if (!selected || selected.ownership !== "aldunis" || selected.recovery !== "available") {
          throw new LocalStateError(
            "The fork destination must be an available Aldunis-owned worktree.",
            409,
          );
        }
        if (projection.threads.some((thread) => thread.worktree === destinationWorktree)) {
          throw new LocalStateError(
            "The fork destination worktree is already bound to another conversation.",
            409,
          );
        }
      } else if (destinationWorkspaceMode !== "shared") {
        throw new LocalStateError(
          "Only the shared workspace mode is available for forks from this conversation.",
          409,
        );
      }
      const provider = providerValue as ProviderId;
      const shikigamiProfile =
        provider === "shikigami" && typeof body.profileId === "string"
          ? await profiles.runtime(body.profileId)
          : null;
      if (shikigamiProfile && shikigamiProfile.profile.provider !== "shikigami") {
        throw new ProfileError("The selected profile does not belong to Shikigami.", 400);
      }
      const effectiveModel = await validateProviderModel(
        provider,
        body.model,
        {
          codex,
          shikigami,
          shikigamiProfile: shikigamiProfile
            ? {
                executable: shikigamiProfile.executable,
                environment: shikigamiProfile.environment,
                configPath: shikigamiProfile.configPath,
              }
            : undefined,
          adapters,
        },
        destinationWorktree,
      );
      if (provider === "claude-code") {
        await profiles.runtime(body.profileId as string);
      } else if (provider === "shikigami") {
        const readiness = await shikigami.readiness(shikigamiProfile?.environment ?? process.env, {
          executable: shikigamiProfile?.executable,
          configPath: shikigamiProfile?.configPath,
          cwd: destinationWorktree,
        });
        if (!readiness.installed || !readiness.authenticated) {
          throw new ProviderProtocolError("Shikigami is unavailable or not authenticated.");
        }
      } else if (provider === "codex-cli") {
        const readiness = await codex.readiness();
        if (!readiness.installed || !readiness.authenticated) {
          throw new ProviderProtocolError("Codex CLI is unavailable or not authenticated.");
        }
      }
      const created = await state.createFork({
        sourceThreadId: source.id,
        provider,
        profileId: typeof body.profileId === "string" ? body.profileId : null,
        model: effectiveModel,
        worktree: source.worktree,
        destinationWorktree,
        workspaceMode: destinationWorkspaceMode,
        expectedDigest: body.expectedDigest,
      });
      sendJson(response, 201, created);
      return true;
    }
    if (route === "/api/state/search") {
      const body = (await readJson(request)) as { query?: unknown; archived?: unknown };
      if (typeof body.query !== "string")
        throw new LocalStateError("A search query is required.", 400);
      if (
        body.archived !== undefined &&
        !["exclude", "include", "only"].includes(String(body.archived))
      ) {
        throw new LocalStateError("A valid archived conversation scope is required.", 400);
      }
      const query = body.query.trim().toLocaleLowerCase().slice(0, 120);
      const archived = body.archived ?? "exclude";
      const projection = await state.load();
      const visibleProjection = managedHost
        ? filterManagedProjection(projection, managedHost)
        : projection;
      const projects = new Map(visibleProjection.projects.map((project) => [project.id, project]));
      const threads = visibleProjection.threads
        .filter((thread) => {
          if (archived === "exclude" && thread.archivedAt) return false;
          if (archived === "only" && !thread.archivedAt) return false;
          const project = projects.get(thread.projectId);
          return (
            !query ||
            thread.title.toLocaleLowerCase().includes(query) ||
            thread.worktree.toLocaleLowerCase().includes(query) ||
            project?.name.toLocaleLowerCase().includes(query)
          );
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50)
        .map((thread) => ({
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          worktree: thread.worktree,
          workspaceMode: thread.workspaceMode ?? "shared",
          provider: thread.provider,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? null,
          archivedAt: thread.archivedAt ?? null,
          projectName: projects.get(thread.projectId)?.name ?? "Unknown project",
        }));
      sendJson(response, 200, { threads, bounded: true });
      return true;
    }
    if (route === "/api/state/conversations/rename") {
      const body = (await readJson(request)) as { threadId?: unknown; title?: unknown };
      if (typeof body.threadId !== "string" || typeof body.title !== "string") {
        throw new LocalStateError("A conversation and title are required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.renameConversation(body.threadId, body.title));
      return true;
    }
    if (route === "/api/state/conversations/pin") {
      const body = (await readJson(request)) as { threadId?: unknown; pinned?: unknown };
      if (typeof body.threadId !== "string" || typeof body.pinned !== "boolean") {
        throw new LocalStateError("A conversation and pin state are required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.setConversationPinned(body.threadId, body.pinned));
      return true;
    }
    if (route === "/api/state/conversations/archive") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.archiveConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/restore") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.restoreConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/settle") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.settleConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/unsettle") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.unsettleConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/snooze") {
      const body = (await readJson(request)) as { threadId?: unknown; snoozedUntil?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (typeof body.snoozedUntil !== "string") {
        throw new LocalStateError("A snooze wake time is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.snoozeConversation(body.threadId, body.snoozedUntil));
      return true;
    }
    if (route === "/api/state/conversations/unsnooze") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.unsnoozeConversation(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/visit") {
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, await state.markConversationVisited(body.threadId));
      return true;
    }
    if (route === "/api/state/conversations/release-worktree") {
      const body = (await readJson(request)) as { threadId?: unknown; confirm?: unknown };
      if (typeof body.threadId !== "string" || body.confirm !== true) {
        throw new LocalStateError("A confirmed conversation worktree release is required.", 400);
      }
      const projection = await state.load();
      const thread = projection.threads.find((item) => item.id === body.threadId);
      if (!thread) throw new LocalStateError("The selected conversation is not available.", 404);
      const project = projection.projects.find((item) => item.id === thread.projectId);
      if (managedHost) {
        assertManagedThread(projection, thread.id);
        if (!project) throw new LocalStateError("The selected conversation is not available.", 404);
        await managedHost.selectWorktree(project.root, thread.worktree);
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
      const body = (await readJson(request)) as { threadId?: unknown };
      if (typeof body.threadId !== "string") {
        throw new LocalStateError("A conversation is required.", 400);
      }
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
      sendJson(response, 200, {
        threadId: body.threadId,
        affectedRecords: await state.previewConversationDeletion(body.threadId),
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
          if (managedHost) assertManagedThread(await state.load(), body.threadId as string);
          return state.deleteConversation(body.threadId as string);
        }),
      );
      return true;
    }
    if (route === "/api/state/delegated-conversations/link") {
      const body = (await readJson(request)) as {
        parentThreadId?: unknown;
        childThreadId?: unknown;
      };
      if (typeof body.parentThreadId !== "string" || typeof body.childThreadId !== "string") {
        throw new LocalStateError("A parent and child conversation are required.", 400);
      }
      sendJson(
        response,
        200,
        await withDelegatedControlLock(async () => {
          const { preferences: currentPreferences } = await preferences.load();
          if (!currentPreferences.orchestrationThreadsBeta) {
            throw new LocalStateError("Orchestration threads beta is disabled.", 403);
          }
          if (managedHost) {
            const projection = await state.load();
            assertManagedThread(projection, body.parentThreadId!);
            assertManagedThread(projection, body.childThreadId!);
          }
          return state.linkDelegatedConversation(body.parentThreadId!, body.childThreadId!);
        }),
      );
      return true;
    }
    if (route === "/api/state/delegated-conversations/unlink") {
      const body = (await readJson(request)) as {
        parentThreadId?: unknown;
        childThreadId?: unknown;
      };
      if (typeof body.parentThreadId !== "string" || typeof body.childThreadId !== "string") {
        throw new LocalStateError("A parent and child conversation are required.", 400);
      }
      await withDelegatedControlLock(async () => {
        const { preferences: currentPreferences } = await preferences.load();
        if (!currentPreferences.orchestrationThreadsBeta) {
          throw new LocalStateError("Orchestration threads beta is disabled.", 403);
        }
        if (managedHost) {
          const projection = await state.load();
          assertManagedThread(projection, body.parentThreadId!);
          assertManagedThread(projection, body.childThreadId!);
        }
        await state.unlinkDelegatedConversation(body.parentThreadId!, body.childThreadId!);
      });
      sendJson(response, 200, { status: "unlinked" });
      return true;
    }
    if (route === "/api/preferences/load") {
      sendJson(response, 200, await preferences.load());
      return true;
    }
    if (route === "/api/preferences/save") {
      const nextPreferences = await readJson(request);
      sendJson(
        response,
        200,
        await withDelegatedControlLock(() => preferences.save(nextPreferences)),
      );
      return true;
    }
    if (route === "/api/products/availability") {
      sendJson(response, 200, resolveProductAvailability());
      return true;
    }
    if (route === "/api/automations/list") {
      if (managedHost) {
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
      // Mutating automations can start provider runs; keep them loopback-local like adapter admin.
      if (remoteRequest || managedHost) {
        throw new AutomationError("Remote clients cannot create automations.", 403);
      }
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
      const projection = await state.load();
      if (!projection.threads.some((thread) => thread.id === body.threadId)) {
        throw new AutomationError("Target conversation was not found.", 404);
      }
      sendJson(
        response,
        200,
        await automations.create({
          name: body.name,
          threadId: body.threadId,
          prompt: body.prompt,
          mode: body.mode as InteractionMode | undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          schedule: body.schedule as AutomationSchedule,
        }),
      );
      return true;
    }
    if (route === "/api/automations/update") {
      if (remoteRequest || managedHost) {
        throw new AutomationError("Remote clients cannot update automations.", 403);
      }
      const body = (await readJson(request)) as {
        id?: unknown;
        name?: unknown;
        prompt?: unknown;
        mode?: unknown;
        enabled?: unknown;
        schedule?: unknown;
      };
      if (typeof body.id !== "string") throw new AutomationError("Automation id is required.");
      sendJson(
        response,
        200,
        await automations.update(body.id, {
          name: typeof body.name === "string" ? body.name : undefined,
          prompt: typeof body.prompt === "string" ? body.prompt : undefined,
          mode: body.mode as InteractionMode | undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          schedule: body.schedule as AutomationSchedule | undefined,
        }),
      );
      return true;
    }
    if (route === "/api/automations/delete") {
      if (remoteRequest || managedHost) {
        throw new AutomationError("Remote clients cannot delete automations.", 403);
      }
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new AutomationError("Automation id is required.");
      await automations.remove(body.id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route === "/api/automations/run-now") {
      if (remoteRequest || managedHost) {
        throw new AutomationError("Remote clients cannot run automations.", 403);
      }
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
          throw new AutomationError(
            "Only an unknown fire for this automation can be retried.",
            409,
          );
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
    if (route === "/api/autonomy/load") {
      const snapshot = await autonomy.snapshot(200);
      if (!managedHost) {
        sendJson(response, 200, snapshot);
        return true;
      }
      const visible = filterManagedProjection(await state.load(), managedHost);
      const projectIds = new Set(visible.projects.map((project) => project.id));
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
      if (remoteRequest || managedHost) {
        throw new AutonomyError("Autonomous runs can only be started from the local host.", 403);
      }
      const body = (await readJson(request)) as {
        projectId?: unknown;
        worktree?: unknown;
        goal?: unknown;
        standingOrderIds?: unknown;
      };
      if (typeof body.projectId !== "string") throw new AutonomyError("A project is required.");
      if (
        body.worktree !== undefined &&
        body.worktree !== null &&
        typeof body.worktree !== "string"
      ) {
        throw new AutonomyError("The worktree is invalid.");
      }
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
      const run = await autonomy.startGardener({
        projectId: body.projectId,
        worktree: typeof body.worktree === "string" ? body.worktree : null,
        goal: typeof body.goal === "string" ? body.goal : undefined,
        standingOrderIds,
      });
      sendJson(response, 202, run);
      return true;
    }
    if (route === "/api/autonomy/runs/cancel") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot cancel autonomy runs.", 403);
      const body = (await readJson(request)) as { runId?: unknown };
      if (typeof body.runId !== "string") throw new AutonomyError("An autonomy run is required.");
      sendJson(response, 200, await state.cancelAutonomyRun(body.runId));
      return true;
    }
    if (route === "/api/autonomy/runs/resume") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot resume autonomy runs.", 403);
      const body = (await readJson(request)) as { runId?: unknown };
      if (typeof body.runId !== "string") throw new AutonomyError("An autonomy run is required.");
      const run = await state.resumeAutonomyRun(body.runId);
      await autonomy.resumeRun(run.id);
      sendJson(response, 202, run);
      return true;
    }
    if (route === "/api/autonomy/heartbeats/create") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot create heartbeats.", 403);
      const body = (await readJson(request)) as {
        name?: unknown;
        projectId?: unknown;
        worktree?: unknown;
        goal?: unknown;
        everySeconds?: unknown;
        flowId?: unknown;
        activeHours?: unknown;
      };
      if (
        typeof body.name !== "string" ||
        typeof body.goal !== "string" ||
        typeof body.everySeconds !== "number"
      ) {
        throw new AutonomyError("Heartbeat name, goal, and interval are required.");
      }
      if (
        body.projectId !== undefined &&
        body.projectId !== null &&
        typeof body.projectId !== "string"
      )
        throw new AutonomyError("Heartbeat project is invalid.");
      if (
        body.worktree !== undefined &&
        body.worktree !== null &&
        typeof body.worktree !== "string"
      )
        throw new AutonomyError("Heartbeat worktree is invalid.");
      sendJson(
        response,
        200,
        await autonomy.addHeartbeat({
          name: body.name,
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          worktree: typeof body.worktree === "string" ? body.worktree : null,
          goal: body.goal,
          everySeconds: body.everySeconds,
          flowId: typeof body.flowId === "string" ? body.flowId : undefined,
          activeHours: body.activeHours as HeartbeatMonitor["activeHours"] | undefined,
        }),
      );
      return true;
    }
    if (route === "/api/autonomy/heartbeats/update") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot update heartbeats.", 403);
      const body = (await readJson(request)) as {
        id?: unknown;
        name?: unknown;
        projectId?: unknown;
        worktree?: unknown;
        goal?: unknown;
        everySeconds?: unknown;
        flowId?: unknown;
        activeHours?: unknown;
        enabled?: unknown;
      };
      if (typeof body.id !== "string") throw new AutonomyError("A heartbeat is required.");
      const current = (await state.load()).heartbeatMonitors.find(
        (monitor) => monitor.id === body.id,
      );
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
        updatedAt: new Date().toISOString(),
      });
      await state.saveAutonomyRecords({ heartbeatMonitors: [updated] });
      sendJson(response, 200, updated);
      return true;
    }
    if (route === "/api/autonomy/heartbeats/delete") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot delete heartbeats.", 403);
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new AutonomyError("A heartbeat is required.");
      await state.removeAutonomyRecord("heartbeat", body.id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route === "/api/autonomy/heartbeats/run-now") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot run heartbeats.", 403);
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new AutonomyError("A heartbeat is required.");
      const monitor = (await state.load()).heartbeatMonitors.find(
        (candidate) => candidate.id === body.id,
      );
      if (!monitor) throw new AutonomyError("Heartbeat not found.", 404);
      const run = await autonomy.startHeartbeat(monitor, "manual");
      await state.saveAutonomyRecords({
        heartbeatMonitors: [
          {
            ...monitor,
            lastRunAt: new Date().toISOString(),
            lastRunId: run.id,
            lastStatus: "queued",
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      sendJson(response, 202, run);
      return true;
    }
    if (route === "/api/autonomy/standing-orders/create") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot create standing orders.", 403);
      const body = (await readJson(request)) as {
        name?: unknown;
        scope?: unknown;
        projectId?: unknown;
        instruction?: unknown;
      };
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
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot update standing orders.", 403);
      const body = (await readJson(request)) as {
        id?: unknown;
        name?: unknown;
        scope?: unknown;
        projectId?: unknown;
        instruction?: unknown;
        enabled?: unknown;
      };
      if (typeof body.id !== "string") throw new AutonomyError("A standing order is required.");
      const current = (await state.load()).standingOrders.find((order) => order.id === body.id);
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
        updatedAt: new Date().toISOString(),
      });
      await state.saveAutonomyRecords({ standingOrders: [updated] });
      sendJson(response, 200, updated);
      return true;
    }
    if (route === "/api/autonomy/standing-orders/delete") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot delete standing orders.", 403);
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new AutonomyError("A standing order is required.");
      await state.removeAutonomyRecord("standingOrder", body.id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route === "/api/autonomy/hooks/create") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot create autonomy hooks.", 403);
      const body = (await readJson(request)) as {
        name?: unknown;
        event?: unknown;
        flowId?: unknown;
        projectId?: unknown;
        cooldownSeconds?: unknown;
      };
      if (
        typeof body.name !== "string" ||
        typeof body.event !== "string" ||
        typeof body.flowId !== "string"
      )
        throw new AutonomyError("Hook name, event, and workflow are required.");
      sendJson(
        response,
        200,
        await autonomy.addHook({
          name: body.name,
          event: body.event as AutonomyHookEvent,
          flowId: body.flowId,
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          cooldownSeconds:
            typeof body.cooldownSeconds === "number" ? body.cooldownSeconds : undefined,
        }),
      );
      return true;
    }
    if (route === "/api/autonomy/hooks/update") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot update autonomy hooks.", 403);
      const body = (await readJson(request)) as {
        id?: unknown;
        name?: unknown;
        event?: unknown;
        flowId?: unknown;
        projectId?: unknown;
        enabled?: unknown;
        cooldownSeconds?: unknown;
      };
      if (typeof body.id !== "string") throw new AutonomyError("A hook is required.");
      const current = (await state.load()).autonomyHooks.find((hook) => hook.id === body.id);
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
        updatedAt: new Date().toISOString(),
      });
      const flow = (await state.load()).autonomyFlows.find(
        (candidate) => candidate.id === updated.flowId,
      );
      if (!flow?.readOnly)
        throw new AutonomyError("Only built-in read-only workflows can be hooked.", 400);
      await state.saveAutonomyRecords({ hooks: [updated] });
      sendJson(response, 200, updated);
      return true;
    }
    if (route === "/api/autonomy/hooks/delete") {
      if (remoteRequest || managedHost)
        throw new AutonomyError("Remote clients cannot delete autonomy hooks.", 403);
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new AutonomyError("A hook is required.");
      await state.removeAutonomyRecord("hook", body.id);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (route === "/api/state/projects/delete") {
      const body = (await readJson(request)) as { projectId?: unknown };
      if (typeof body.projectId !== "string") {
        throw new RepositoryError("A project is required.");
      }
      await withDelegatedControlLock(async () => {
        const projection = await state.load();
        if (managedHost) {
          assertManagedProject(projection, body.projectId as string);
        }
        if (
          activeCheckpointProjects.has(body.projectId as string) ||
          projectHasActiveCheckpoint(body.projectId as string)
        ) {
          throw new LocalStateError(
            "Wait for the active turn to finish before deleting this project.",
            409,
          );
        }
        activeCheckpointProjects.add(body.projectId as string);
        try {
          const threadIds = new Set(
            projection.threads
              .filter((thread) => thread.projectId === body.projectId)
              .map((thread) => thread.id),
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
          await state.deleteProject(body.projectId as string);
        } finally {
          activeCheckpointProjects.delete(body.projectId as string);
        }
      });
      sendJson(response, 200, { status: "deleted" });
      return true;
    }
    if (route === "/api/state/retention") {
      if (managedHost) {
        throw new LocalStateError(
          "Retention administration is unavailable in managed hosted mode.",
          403,
        );
      }
      const body = (await readJson(request)) as { olderThan?: unknown };
      if (typeof body.olderThan !== "string" || Number.isNaN(Date.parse(body.olderThan))) {
        throw new RepositoryError("A valid retention cutoff is required.");
      }
      await withDelegatedControlLock(async () => {
        const cutoff = new Date(body.olderThan as string);
        const projection = await state.load();
        const expiredThreads = new Set(
          projection.threads
            .filter((thread) => new Date(thread.updatedAt) < cutoff)
            .map((thread) => thread.id),
        );
        const expiredProjectIds = new Set(
          projection.threads
            .filter((thread) => expiredThreads.has(thread.id))
            .map((thread) => thread.projectId),
        );
        if (
          [...expiredProjectIds].some(
            (projectId) =>
              activeCheckpointProjects.has(projectId) || projectHasActiveCheckpoint(projectId),
          )
        ) {
          throw new LocalStateError(
            "Retention cannot run while an affected project has an active turn.",
            409,
          );
        }
        for (const projectId of expiredProjectIds) activeCheckpointProjects.add(projectId);
        try {
          const checkpoints = projection.checkpoints.filter((item) =>
            expiredThreads.has(item.threadId),
          );
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
      });
      sendJson(response, 200, { status: "compacted" });
      return true;
    }
    const previewMatch = route.match(/^\/api\/checkpoints\/([0-9a-f-]+)\/preview$/);
    if (previewMatch) {
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
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
      if (
        checkpointThread &&
        (activeCheckpointProjects.has(checkpointThread.projectId) ||
          activeCheckpointWorktrees.has(
            checkpointWorktreeKey(checkpointThread.projectId, context.worktree),
          ))
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
    const checkpointDiffMatch = route.match(/^\/api\/checkpoints\/([0-9a-f-]+)\/diff$/);
    if (checkpointDiffMatch) {
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
        throw new RepositoryError("A repository, worktree, and changed path are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const checkpoint = projection.checkpoints.find(
        (item) => item.id === checkpointDiffMatch[1] && item.worktree === context.worktree,
      );
      const checkpointThread = checkpoint
        ? projection.threads.find((thread) => thread.id === checkpoint.threadId)
        : undefined;
      if (!checkpointThread) {
        throw new LocalStateError("The checkpoint conversation is unavailable.", 404);
      }
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
        : await checkpointDiff(
            context.worktree,
            checkpoint.baselineIdentity,
            checkpoint.completedIdentity,
          );
      sendJson(
        response,
        200,
        await readCheckpointFileDiff(
          context.worktree,
          checkpoint.baselineIdentity,
          checkpoint.completedIdentity,
          body.path,
          files,
        ),
      );
      return true;
    }
    const rewindMatch = route.match(/^\/api\/checkpoints\/([0-9a-f-]+)\/rewind$/);
    if (rewindMatch) {
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        currentIdentity?: unknown;
        currentIndexIdentity?: unknown;
        confirm?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.currentIdentity !== "string" ||
        typeof body.currentIndexIdentity !== "string" ||
        body.confirm !== true
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
      if (
        checkpointThread &&
        (activeCheckpointProjects.has(checkpointThread.projectId) ||
          (rewindLock && activeCheckpointWorktrees.has(rewindLock)))
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
      if (managedHost) {
        sendJson(response, 200, {
          provider: "shikigami",
          commands: [],
          attachments: provider.capabilities().attachments,
          workspace: {
            shared: true,
            aldunisManaged: true,
            providerNative: false,
            providerNativeDetail:
              "Managed hosted mode supplies the workspace; provider-native worktree creation is unavailable.",
          },
        });
        return true;
      }
      sendJson(response, 200, provider.capabilities());
      return true;
    }
    if (route === "/api/provider/skills") {
      if (managedHost) {
        throw new LocalStateError("Codex skills are unavailable in managed hosted mode.", 403);
      }
      const body = (await readJson(request)) as {
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
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, { skills: await codex.skills(context.worktree) });
      return true;
    }
    if (route === "/api/provider/approvals/list") {
      const body = (await readJson(request)) as { runId?: unknown };
      if (typeof body.runId !== "string") {
        throw new PermissionError("A provider run is required.");
      }
      sendJson(response, 200, { approvals: permissions.approvalsFor(body.runId) });
      return true;
    }
    if (route === "/api/context/files") {
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        query?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.query !== "string"
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
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        query?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.query !== "string"
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
        throw new RepositoryError(
          "A repository, worktree, and repository-relative path are required.",
        );
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, {
        preview: await previewRepositoryFile(context.worktree, body.path),
      });
      return true;
    }
    if (route === "/api/context/stage-image") {
      const body = (await readJson(request, MAX_STAGE_IMAGE_BODY_BYTES)) as {
        root?: unknown;
        worktree?: unknown;
        mediaType?: unknown;
        data?: unknown;
        name?: unknown;
        conversationId?: unknown;
        absolutePath?: unknown;
      };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      if (typeof body.absolutePath === "string" && body.absolutePath) {
        if (remoteRequest || managedHost) {
          throw new RepositoryError(
            "Remote and managed hosts cannot pin absolute desktop paths; drop or paste the image bytes instead.",
            403,
          );
        }
        const resolved = await resolveWorktreeImagePath(context.worktree, body.absolutePath);
        if (resolved) {
          sendJson(response, 200, { attachment: resolved, staged: false });
          return true;
        }
        const stagedCopy = await stageWorktreeImageCopy(context.worktree, body.absolutePath, {
          ...(typeof body.conversationId === "string"
            ? { conversationId: body.conversationId }
            : {}),
        });
        if (!stagedCopy) {
          throw new RepositoryError(
            "The dropped file is outside the selected worktree or is not a supported image.",
            400,
          );
        }
        sendJson(response, 200, { attachment: stagedCopy, staged: true });
        return true;
      }
      if (typeof body.mediaType !== "string" || typeof body.data !== "string") {
        throw new RepositoryError("Image media type and base64 data are required.");
      }
      const staged = await stageComposerImage(context.worktree, {
        mediaType: body.mediaType,
        data: body.data,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      });
      sendJson(response, 200, { attachment: staged, staged: true });
      return true;
    }
    if (route === "/api/context/package/preview") {
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        pins?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
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
        throw new RepositoryError(
          "A repository, worktree, and bounded context pin list are required.",
        );
      }
      const pins = body.pins as ContextPin[];
      if (remoteRequest && pins.some((pin) => pin.kind === "folder")) {
        throw new RepositoryError(
          "Remote folder pinning requires an authenticated repository grant and is unavailable.",
          403,
        );
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const assembled = await assembleContextPackage(context.worktree, pins, {
        includeProviderInstructions: !remoteRequest && !managedHost,
      });
      sendJson(response, 200, {
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
    if (route === "/api/provider/profiles/list") {
      if (managedHost) {
        sendJson(response, 200, { profiles: [], administrationAvailable: false });
        return true;
      }
      const installedAdapters = await adapters.list();
      sendJson(response, 200, {
        profiles: await profiles.list({
          adapters: installedAdapters.map((adapter) => adapterProfileSeed(adapter)),
        }),
      });
      return true;
    }
    if (route === "/api/provider/profiles/save") {
      if (remoteRequest || managedHost)
        throw new ProfileError(
          "Provider profile administration is unavailable in the active host mode.",
          403,
        );
      const body = (await readJson(request)) as {
        id?: unknown;
        provider?: unknown;
        name?: unknown;
        binaryPath?: unknown;
        homePath?: unknown;
        configPath?: unknown;
        environment?: unknown;
      };
      const environment = Array.isArray(body.environment)
        ? body.environment.map((value) => {
            if (
              !isRecord(value) ||
              typeof value.name !== "string" ||
              typeof value.sensitive !== "boolean" ||
              (value.value !== undefined && typeof value.value !== "string") ||
              (value.valueSet !== undefined && typeof value.valueSet !== "boolean")
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
        (body.id !== undefined && typeof body.id !== "string") ||
        typeof body.name !== "string" ||
        (body.provider !== undefined && typeof body.provider !== "string") ||
        (body.binaryPath !== undefined && typeof body.binaryPath !== "string") ||
        (body.homePath !== undefined && typeof body.homePath !== "string") ||
        (body.configPath !== undefined && typeof body.configPath !== "string") ||
        (body.environment !== undefined && !Array.isArray(body.environment))
      ) {
        throw new ProfileError("A valid provider profile is required.");
      }
      sendJson(
        response,
        200,
        await profiles.save({
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
          name: body.name,
          ...(typeof body.binaryPath === "string" ? { binaryPath: body.binaryPath } : {}),
          ...(typeof body.homePath === "string" ? { homePath: body.homePath } : {}),
          ...(typeof body.configPath === "string" ? { configPath: body.configPath } : {}),
          ...(environment ? { environment } : {}),
        }),
      );
      return true;
    }
    if (route === "/api/provider/profiles/delete") {
      if (remoteRequest || managedHost)
        throw new ProfileError(
          "Provider profile administration is unavailable in the active host mode.",
          403,
        );
      const body = (await readJson(request)) as { id?: unknown };
      if (typeof body.id !== "string") throw new ProfileError("A provider profile is required.");
      await profiles.delete(body.id);
      sendJson(response, 200, { status: "deleted" });
      return true;
    }
    if (route === "/api/provider/profiles/refresh") {
      if (remoteRequest || managedHost)
        throw new ProfileError(
          "Provider profile administration is unavailable in the active host mode.",
          403,
        );
      const body = (await readJson(request)) as { id?: unknown; kind?: unknown };
      const kinds: ProfileProbeKind[] = ["availability", "version", "authentication", "models"];
      if (
        typeof body.id !== "string" ||
        typeof body.kind !== "string" ||
        !kinds.includes(body.kind as ProfileProbeKind)
      ) {
        throw new ProfileError("A profile and refresh kind are required.");
      }
      sendJson(response, 200, await profiles.refresh(body.id, body.kind as ProfileProbeKind));
      return true;
    }
    if (route === "/api/provider/runs") {
      return await handleProviderRun(
        { body: await readJson(request), localPort: request.socket.localPort },
        response,
        {
          provider,
          codex,
          shikigami,
          permissions,
          state,
          profiles,
          preferences,
          autonomy,
          worktrees,
          adapters,
          activeAcp,
          wake,
          withDelegatedControlLock,
          internalApprovalUrl,
          managedHost,
          browser,
          browserMcpPath,
          remoteRequest,
          internalRequest,
          selectedWorktree,
          publishThreadStatusTransition,
          activeCheckpointProjects,
          activeCheckpointWorktrees,
          checkpointWorktreeKey,
        },
      );
    }
    if (route === "/api/provider/permissions/request") {
      const body = (await readJson(request)) as {
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
      const body = (await readJson(request)) as {
        runId?: unknown;
        conversationId?: unknown;
        repository?: unknown;
        worktree?: unknown;
        toolCallId?: unknown;
        decision?: unknown;
        parentThreadId?: unknown;
      };
      if (
        typeof body.runId !== "string" ||
        typeof body.conversationId !== "string" ||
        typeof body.repository !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.toolCallId !== "string" ||
        (body.parentThreadId !== undefined && typeof body.parentThreadId !== "string") ||
        (body.decision !== "allow_once" && body.decision !== "deny")
      ) {
        throw new PermissionError("A complete scoped approval decision is required.");
      }
      const runId = body.runId;
      const conversationId = body.conversationId;
      const repository = body.repository;
      const worktree = body.worktree;
      const toolCallId = body.toolCallId;
      const decision = body.decision;
      const parentThreadId = body.parentThreadId;
      const resolveApproval = async () => {
        if (typeof parentThreadId === "string") {
          const { preferences: currentPreferences } = await preferences.load();
          if (!currentPreferences.orchestrationThreadsBeta) {
            throw new PermissionError("Parent-routed approvals require beta orchestration.", 403);
          }
          const projection = await state.load();
          assertParentRoutedApproval(projection, permissions.approvals(), {
            parentThreadId,
            childThreadId: conversationId,
            approvalId: approvalMatch[1],
          });
        }
        const previousStatus = projectThreadStatus(await state.load(), conversationId).status;
        const decided = await permissions.decideAfter(
          approvalMatch[1],
          { runId, conversationId, repository, worktree, toolCallId },
          decision,
          async (resolution) => {
            const projection = await state.load();
            const turn = projection.turns.find((item) => item.providerRunId === runId);
            const thread = turn
              ? projection.threads.find((item) => item.id === turn.threadId)
              : undefined;
            if (!turn || !thread) {
              throw new LocalStateError("The provider turn is missing from local history.", 404);
            }
            await state.recordProviderEvent(thread.id, turn.id, thread.provider ?? "claude-code", {
              kind: "approval_resolved",
              id: resolution.id,
              state: resolution.state,
            });
            const sibling = permissions
              .approvalsFor(runId)
              .find((approval) => approval.state === "pending");
            if (sibling) {
              await state.recordProviderEvent(
                thread.id,
                turn.id,
                thread.provider ?? "claude-code",
                { kind: "approval_pending", ...sibling },
              );
            }
          },
        );
        await publishThreadStatusTransition(wake, state, conversationId, previousStatus, true);
        return decided;
      };
      const decided =
        typeof parentThreadId === "string"
          ? await withDelegatedControlLock(resolveApproval)
          : await resolveApproval();
      sendJson(response, 200, decided);
      return true;
    }
    const inputResponseMatch = route.match(
      /^\/api\/provider\/input-requests\/([0-9a-f-]+)\/respond$/,
    );
    if (inputResponseMatch) {
      const body = (await readJson(request)) as {
        childThreadId?: unknown;
        parentThreadId?: unknown;
        answer?: unknown;
      };
      if (
        typeof body.childThreadId !== "string" ||
        typeof body.answer !== "string" ||
        (body.parentThreadId !== undefined && typeof body.parentThreadId !== "string")
      ) {
        throw new LocalStateError("A complete child-bound input response is required.", 400);
      }
      const respond = async () => {
        let selectedRequest;
        if (typeof body.parentThreadId === "string") {
          const { preferences: currentPreferences } = await preferences.load();
          if (!currentPreferences.orchestrationThreadsBeta) {
            throw new LocalStateError("Parent-routed input requires beta orchestration.", 403);
          }
          const inputProjection = await state.load();
          if (managedHost) {
            assertManagedThread(inputProjection, body.parentThreadId);
            assertManagedThread(inputProjection, body.childThreadId as string);
          }
          selectedRequest = assertParentRoutedInput(
            inputProjection,
            body.parentThreadId,
            body.childThreadId as string,
            inputResponseMatch[1],
          );
          if (selectedRequest.state !== "pending") {
            throw new LocalStateError("The input request has already been resolved.", 409);
          }
        } else {
          const inputProjection = await state.load();
          if (managedHost) assertManagedThread(inputProjection, body.childThreadId as string);
          const requestProjection = inputProjection.inputRequests.find(
            (item) =>
              item.id === inputResponseMatch[1] &&
              item.threadId === body.childThreadId &&
              item.state === "pending",
          );
          if (!requestProjection) {
            throw new LocalStateError("The input request is not pending for this child.", 403);
          }
          selectedRequest = requestProjection;
        }
        await state.validateInputResponse(selectedRequest.id, body.answer as string);
        if (selectedRequest.responseMode === "child_follow_up") {
          const projection = await state.load();
          const child = projection.threads.find((item) => item.id === body.childThreadId);
          const childSession = projection.providerSessions.find(
            (item) => item.threadId === body.childThreadId && item.provider === child?.provider,
          );
          const sourceTurn = projection.turns.find((item) => item.id === selectedRequest.turnId);
          const project = child
            ? projection.projects.find((item) => item.id === child.projectId)
            : undefined;
          if (!child || !project || !sourceTurn) {
            throw new LocalStateError("The child follow-up route is unavailable.", 503);
          }
          const followUpPrompt = [
            `Operator response to child input request ${selectedRequest.id}:`,
            selectedRequest.question,
            "",
            (body.answer as string).trim(),
          ].join("\n");
          const result = await state.resolveInputRequest(
            inputResponseMatch[1],
            body.answer as string,
            typeof body.parentThreadId === "string" ? body.parentThreadId : null,
          );
          for (let attempt = 0; ; attempt += 1) {
            try {
              await runChildFollowUp({
                root: project.root,
                worktree: child.worktree,
                prompt: followUpPrompt,
                mode: sourceTurn.mode ?? "ask",
                conversationId: child.id,
                projectId: child.projectId,
                threadId: child.id,
                contextPins: child.contextPins ?? [],
                profileId: child.profileId ?? null,
                model: child.model ?? childSession?.model ?? "default",
                provider: child.provider,
                reasoningEffort: child.reasoningEffort,
                inputRequestId: selectedRequest.id,
              });
              break;
            } catch (error) {
              if (!(error instanceof LocalStateError) || error.status !== 409 || attempt >= 24) {
                await state.failInputResolution(selectedRequest.id);
                throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          await publishThreadStatusTransition(
            wake,
            state,
            body.childThreadId as string,
            null,
            true,
          );
          return result;
        }
        if (selectedRequest.responseMode === "native_resume") {
          const projection = await state.load();
          const child = projection.threads.find((item) => item.id === body.childThreadId);
          const childSession = projection.providerSessions.find(
            (item) => item.threadId === body.childThreadId && item.provider === child?.provider,
          );
          const sourceTurn = projection.turns.find((item) => item.id === selectedRequest.turnId);
          const project = child
            ? projection.projects.find((item) => item.id === child.projectId)
            : undefined;
          if (
            !child ||
            child.provider !== "shikigami" ||
            !project ||
            !sourceTurn ||
            !selectedRequest.providerRequestId
          ) {
            throw new LocalStateError("The native Shikigami resume route is unavailable.", 409);
          }
          const result = await state.resolveInputRequest(
            inputResponseMatch[1],
            body.answer as string,
            typeof body.parentThreadId === "string" ? body.parentThreadId : null,
          );
          try {
            for (let attempt = 0; ; attempt += 1) {
              try {
                await runChildFollowUp({
                  root: project.root,
                  worktree: child.worktree,
                  prompt: "",
                  mode: sourceTurn.mode ?? "ask",
                  conversationId: child.id,
                  projectId: child.projectId,
                  threadId: child.id,
                  resumeSessionId: selectedRequest.providerRequestId,
                  resumeAnswer: (body.answer as string).trim(),
                  profileId: childSession?.profileId ?? child.profileId ?? null,
                  model: child.model ?? childSession?.model ?? "default",
                  provider: "shikigami",
                  reasoningEffort: child.reasoningEffort,
                  inputRequestId: selectedRequest.id,
                  workspaceMode: child.workspaceMode,
                });
                break;
              } catch (error) {
                if (!(error instanceof LocalStateError) || error.status !== 409 || attempt >= 24) {
                  throw error;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          } catch (error) {
            await state.markNativeShikigamiResumeUnavailable(selectedRequest.id);
            throw error;
          }
          await publishThreadStatusTransition(
            wake,
            state,
            body.childThreadId as string,
            null,
            true,
          );
          return result;
        }
        const result = await state.resolveInputRequest(
          inputResponseMatch[1],
          body.answer as string,
          typeof body.parentThreadId === "string" ? body.parentThreadId : null,
        );
        if (
          !codex.answerInput(
            selectedRequest.providerRunId,
            selectedRequest.id,
            (body.answer as string).trim(),
          )
        ) {
          await state.failInputResolution(selectedRequest.id);
          throw new LocalStateError("The native input request is no longer resumable.", 409);
        }
        await publishThreadStatusTransition(wake, state, body.childThreadId as string, null, true);
        return result;
      };
      const result = await withDelegatedControlLock(respond);
      sendJson(response, 200, result);
      return true;
    }
    if (route === "/api/changes") {
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, { files: await listChangedFiles(context.worktree) });
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
      if (managedHost) assertManagedThread(await state.load(), body.threadId);
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
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.threadId !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and conversation are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) =>
          item.id === body.threadId &&
          item.projectId === project?.id &&
          item.worktree === context.worktree,
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
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) =>
          item.id === body.threadId &&
          item.projectId === project?.id &&
          item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      const diff = await readFileDiff(context.worktree, body.path);
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
      const now = new Date().toISOString();
      sendJson(
        response,
        201,
        await state.saveAnnotation({
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
        }),
      );
      return true;
    }
    const annotationResolutionMatch = route.match(/^\/api\/annotations\/([0-9a-f-]+)\/resolution$/);
    if (annotationResolutionMatch) {
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
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) =>
          item.id === body.threadId &&
          item.projectId === project?.id &&
          item.worktree === context.worktree,
      );
      if (!thread) throw new LocalStateError("The annotation conversation is unavailable.", 404);
      sendJson(
        response,
        200,
        await state.setAnnotationResolution(
          annotationResolutionMatch[1],
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
      const context = await selectedWorktree(body.root, body.worktree);
      const projection = await state.load();
      const project = projection.projects.find((item) => item.root === context.root);
      const thread = projection.threads.find(
        (item) =>
          item.id === body.threadId &&
          item.projectId === project?.id &&
          item.worktree === context.worktree,
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
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await readFileDiff(context.worktree, body.path));
      return true;
    }
    if (route === "/api/delivery/inspect") {
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await inspectDelivery(context.root, context.worktree));
      return true;
    }
    if (route === "/api/delivery/pr-status") {
      // Best-effort GitHub PR projection for sidebar rows. Soft-fails when gh
      // is missing or no PR is linked to the current branch.
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await inspectBranchPr(context.worktree));
      return true;
    }
    if (route === "/api/delivery/pr-status/batch") {
      const body = (await readJson(request)) as {
        items?: unknown;
      };
      if (!Array.isArray(body.items)) {
        throw new RepositoryError("A list of repository worktrees is required.");
      }
      // Soft-fail unavailable worktrees independently so one released checkout
      // cannot blank PR chrome for every other row.
      const worktrees: string[] = [];
      for (const item of body.items) {
        if (worktrees.length >= BRANCH_PR_BATCH_LIMIT) break;
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const entry = item as { root?: unknown; worktree?: unknown };
        if (typeof entry.root !== "string" || typeof entry.worktree !== "string") continue;
        try {
          const context = await selectedWorktree(entry.root, entry.worktree);
          worktrees.push(context.worktree);
        } catch {
          // Released, missing, or out-of-scope paths stay without PR projection.
        }
      }
      sendJson(response, 200, { results: await inspectBranchPrBatch(worktrees) });
      return true;
    }
    if (route === "/api/delivery/pr-draft") {
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        base?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.base !== "string"
      ) {
        throw new RepositoryError("A repository, worktree, and base branch are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(response, 200, await draftPullRequest(context.root, context.worktree, body.base));
      return true;
    }
    if (route === "/api/release-delivery/inspect") {
      if (remoteRequest || managedHost) {
        throw new RepositoryError(
          "Release delivery is available only on the loopback workbench.",
          403,
        );
      }
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        projectId?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.projectId !== "string"
      ) {
        throw new RepositoryError("A project, repository, and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const project = await selectedReleaseProject(state, body.projectId, context);
      sendJson(
        response,
        200,
        await releaseDelivery.inspect(project.id, context.root, context.worktree),
      );
      return true;
    }
    if (route === "/api/release-delivery/plans") {
      if (remoteRequest || managedHost) {
        throw new RepositoryError(
          "Release delivery is available only on the loopback workbench.",
          403,
        );
      }
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        projectId?: unknown;
        action?: unknown;
        input?: unknown;
      };
      const actions = new Set<ReleaseWorkflowAction>([
        "prepare",
        "evaluate",
        "publish",
        "promote",
        "plan",
        "apply",
        "reconcile",
        "rollback",
      ]);
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.projectId !== "string" ||
        typeof body.action !== "string" ||
        !actions.has(body.action as ReleaseWorkflowAction) ||
        !isRecord(body.input)
      ) {
        throw new RepositoryError("A complete release-delivery action is required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const project = await selectedReleaseProject(state, body.projectId, context);
      sendJson(
        response,
        200,
        await releaseDelivery.plan(
          project.id,
          context.root,
          context.worktree,
          project.chiseiNamespace ?? "",
          body.action as ReleaseWorkflowAction,
          body.input,
        ),
      );
      return true;
    }
    const releaseDeliveryMatch = route.match(
      /^\/api\/release-delivery\/plans\/([0-9a-f-]+)\/execute$/,
    );
    if (releaseDeliveryMatch) {
      if (remoteRequest || managedHost) {
        throw new RepositoryError(
          "Release delivery is available only on the loopback workbench.",
          403,
        );
      }
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        projectId?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.projectId !== "string"
      ) {
        throw new RepositoryError("A project, repository, and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const project = await selectedReleaseProject(state, body.projectId, context);
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      sendJson(
        response,
        200,
        await releaseDelivery.execute(
          releaseDeliveryMatch[1],
          project.id,
          context.root,
          context.worktree,
          project.chiseiNamespace ?? "",
          controller.signal,
        ),
      );
      return true;
    }
    if (route === "/api/release-delivery/receipt") {
      if (remoteRequest || managedHost) {
        throw new RepositoryError(
          "Release delivery is available only on the loopback workbench.",
          403,
        );
      }
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        projectId?: unknown;
        sessionId?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.projectId !== "string" ||
        typeof body.sessionId !== "string"
      ) {
        throw new RepositoryError("A complete release receipt request is required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const project = await selectedReleaseProject(state, body.projectId, context);
      sendJson(
        response,
        200,
        await releaseDelivery.receipt(body.sessionId, project.id, context.root, context.worktree),
      );
      return true;
    }
    if (route === "/api/delivery/plans") {
      if (managedHost) {
        throw new RepositoryError("Delivery authority is unavailable in managed hosted mode.", 403);
      }
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        action?: unknown;
        input?: unknown;
      };
      const actions = new Set<DeliveryAction>(["stage", "commit", "push", "pull_request"]);
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.action !== "string" ||
        !actions.has(body.action as DeliveryAction) ||
        typeof body.input !== "object" ||
        body.input === null ||
        Array.isArray(body.input)
      ) {
        throw new RepositoryError("A complete delivery action is required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        await delivery.plan(
          context.root,
          context.worktree,
          body.action as DeliveryAction,
          body.input as Record<string, unknown>,
        ),
      );
      return true;
    }
    const deliveryMatch = route.match(/^\/api\/delivery\/plans\/([0-9a-f-]+)\/execute$/);
    if (deliveryMatch) {
      if (managedHost) {
        throw new RepositoryError("Delivery authority is unavailable in managed hosted mode.", 403);
      }
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new RepositoryError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        await delivery.execute(deliveryMatch[1], context.root, context.worktree),
      );
      return true;
    }
    if (route === "/api/previews/request") {
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        origin?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        typeof body.origin !== "string"
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
      const body = (await readJson(request)) as {
        root?: unknown;
        worktree?: unknown;
        decision?: unknown;
      };
      if (
        typeof body.root !== "string" ||
        typeof body.worktree !== "string" ||
        (body.decision !== "allow_once" && body.decision !== "deny")
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
      const body = (await readJson(request)) as { root?: unknown; worktree?: unknown };
      if (typeof body.root !== "string" || typeof body.worktree !== "string") {
        throw new PreviewError("A repository and worktree are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      sendJson(
        response,
        200,
        await previews.stop(previewStop[1], {
          repository: context.root,
          worktree: context.worktree,
        }),
      );
      return true;
    }
    const cancelMatch = route.match(/^\/api\/provider\/runs\/([0-9a-f-]+)\/cancel$/);
    if (cancelMatch) {
      const acp = activeAcp.get(cancelMatch[1]);
      if (
        !provider.cancel(cancelMatch[1]) &&
        !codex.cancel(cancelMatch[1]) &&
        !shikigami.cancel(cancelMatch[1]) &&
        !acp?.cancel(cancelMatch[1])
      ) {
        throw new RepositoryError("The provider run is no longer active.", 404);
      }
      sendJson(response, 202, { status: "cancelling" });
      return true;
    }
    sendJson(response, 404, { error: "API route not found." });
  } catch (error) {
    const status =
      error instanceof RepositoryError ||
      error instanceof PermissionError ||
      error instanceof LocalStateError ||
      error instanceof ProfileError ||
      error instanceof PreferencesError ||
      error instanceof AutomationError ||
      error instanceof AutonomyError ||
      error instanceof PreviewError ||
      error instanceof ProviderAdapterError ||
      error instanceof ProviderModelError ||
      error instanceof ChiseiClientError ||
      error instanceof RemoteAuthError ||
      error instanceof ManagedHostError ||
      error instanceof BrowserError
        ? error.status
        : 500;
    const message =
      error instanceof RepositoryError ||
      error instanceof ProviderProtocolError ||
      error instanceof PermissionError ||
      error instanceof LocalStateError ||
      error instanceof ProfileError ||
      error instanceof PreferencesError ||
      error instanceof AutomationError ||
      error instanceof AutonomyError ||
      error instanceof PreviewError ||
      error instanceof ProviderAdapterError ||
      error instanceof ProviderModelError ||
      error instanceof ChiseiClientError ||
      error instanceof RemoteAuthError ||
      error instanceof ManagedHostError ||
      error instanceof BrowserError
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

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  dist: string,
): Promise<void> {
  const rawPath = new URL(request.url ?? "/", "http://localhost").pathname;
  const requested = rawPath === "/" ? "index.html" : rawPath.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(dist, safePath);
  try {
    if (!(await stat(filePath)).isFile()) filePath = join(dist, "index.html");
  } catch {
    filePath = join(dist, "index.html");
  }
  try {
    if (!(await stat(filePath)).isFile()) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end("Not found");
      return;
    }
  } catch {
    response.writeHead(404, {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    response.end("Not found");
    return;
  }
  const stream = createReadStream(filePath);
  let opened = false;
  stream.on("open", () => {
    opened = true;
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    stream.pipe(response);
  });
  stream.on("error", () => {
    if (!opened && !response.headersSent) {
      response.writeHead(500, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end("Failed to read static asset");
      return;
    }
    response.destroy();
  });
}

export interface LocalHostOptions {
  dist?: string;
  state?: LocalStateStore;
  profiles?: ClaudeProfileStore;
  remoteAuth?: RemoteAuth;
  tls?: { key: Buffer; cert: Buffer };
  permissions?: PermissionBroker;
  childFollowUp?: (body: Record<string, unknown>) => Promise<void>;
  chisei?: ChiseiProjectionClient;
  managedHost?: ManagedHost;
  browserHost?: BrowserHost;
  browserMcpPath?: string;
  publicOrigin?: string | (() => string | undefined);
  localBindHost?: string;
  allowLocalControl?: boolean;
}

export function createLocalHost(options: LocalHostOptions = {}) {
  const dist = options.dist ?? fileURLToPath(new URL("../dist", import.meta.url));
  const state = options.state ?? new LocalStateStore();
  const profiles = options.profiles ?? new ClaudeProfileStore(state.directory);
  const permissions = options.permissions ?? new PermissionBroker();
  const chisei = options.chisei ?? new ChiseiProjectionClient();
  const allowLocalControl = options.allowLocalControl ?? true;
  const {
    remoteAuth,
    tls,
    childFollowUp: childFollowUpOverride,
    managedHost,
    browserHost,
    browserMcpPath,
    publicOrigin,
    localBindHost,
  } = options;
  const internalPermissionCallback =
    remoteAuth || managedHost ? createInternalPermissionCallback(permissions) : undefined;
  const delivery = new DeliveryBroker();
  const releaseDelivery = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state.directory));
  const provider = new ClaudeCodeAdapter("claude", permissions);
  const codex = new CodexCliAdapter("codex", permissions);
  const shikigami = new ShikigamiAdapter(
    managedHost?.shikigami.executable ?? "shikigami",
    permissions,
  );
  const previews = new PreviewManager();
  const preferences = new PreferencesStore(state.directory);
  const automations = new AutomationStore(state.directory);
  const worktrees = new WorktreeManager(state.directory);
  const directories = new DirectoryBrowser();
  const adapters = new ProviderAdapterStore(state.directory);
  const providerDiscovery = new ProviderDiscovery({
    codex,
    shikigami,
    profiles,
    adapters,
    managedModel: managedHost?.shikigami.model,
  });
  const activeAcp = new Map<string, AcpProviderAdapter>();
  const browser = browserHost ? new SharedBrowserBroker(browserHost) : null;
  const wake = new WakeBroker();
  const autonomy = new AutonomyEngine(state);
  const autonomyScheduler = new AutonomyScheduler(autonomy);
  const internalRequestToken = randomUUID();
  let delegatedControlTail = Promise.resolve();
  const withDelegatedControlLock: DelegatedControlLock = async (action) => {
    const previous = delegatedControlTail;
    let release!: () => void;
    delegatedControlTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };
  const reconcileApprovalState = async (
    approval: ApprovalSnapshot,
    recordResolution: boolean,
  ): Promise<void> => {
    const projection = await state.load();
    const turn = projection.turns.find((item) => item.providerRunId === approval.runId);
    const thread = turn ? projection.threads.find((item) => item.id === turn.threadId) : undefined;
    if (!turn || !thread) return;
    if (recordResolution) {
      await state.recordProviderEvent(thread.id, turn.id, thread.provider ?? "claude-code", {
        kind: "approval_resolved",
        id: approval.id,
        state: approval.state,
      });
    }
    const sibling = permissions
      .approvalsFor(approval.runId)
      .find((candidate) => candidate.state === "pending");
    if (sibling) {
      await state.recordProviderEvent(thread.id, turn.id, thread.provider ?? "claude-code", {
        kind: "approval_pending",
        ...sibling,
      });
    }
    await publishThreadStatusTransition(wake, state, approval.conversationId, null, true);
  };
  const unsubscribePermissionChanges = permissions.subscribe((approval) => {
    void reconcileApprovalState(approval, approval.state === "expired").catch(() => undefined);
  });
  // Seed Claude Code default profile so first-run does not require Settings.
  const profileBootstrap = profiles.ensureDefaults().catch(() => undefined);
  const recovery = state
    .recoverInterruptedTurns()
    .then(() => state.reconcileAutomationFires())
    .then(() => state.recoverAutonomyRuns())
    .then(() => state.compactAssistantStreamHistory())
    .then(() => autonomy.ensureBuiltInFlows());

  let serverRef: ReturnType<typeof createHttpServer> | null = null;

  async function isThreadBusy(threadId: string): Promise<boolean> {
    const projection = await state.load();
    return projection.turns.some(
      (turn) =>
        turn.threadId === threadId &&
        ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status),
    );
  }

  async function runChildFollowUp(body: Record<string, unknown>): Promise<void> {
    if (childFollowUpOverride) return childFollowUpOverride(body);
    const address = serverRef?.address();
    if (!address || typeof address === "string") {
      throw new LocalStateError("The child follow-up route is unavailable.", 503);
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const internalHost =
      address.address === "::"
        ? "::1"
        : address.address === "0.0.0.0"
          ? "127.0.0.1"
          : address.address;
    await new Promise<void>((resolve, reject) => {
      const send = tls ? httpsRequest : httpRequest;
      const outgoing = send(
        {
          host: internalHost,
          port: address.port,
          path: "/api/provider/runs",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(payload.length),
            "x-aldunis-internal-request": internalRequestToken,
          },
          ...(tls ? { rejectUnauthorized: false } : {}),
        },
        (incoming) => {
          if ((incoming.statusCode ?? 500) >= 200 && (incoming.statusCode ?? 500) < 300) {
            // The run endpoint sends headers immediately after provider startup.
            // Resolve on those headers and drain the event stream independently so
            // the delegated-control lock never spans the child turn's lifetime.
            incoming.resume();
            resolve();
            return;
          }
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          incoming.on("end", () => {
            let message = `Child follow-up failed (${incoming.statusCode ?? 500}).`;
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                error?: string;
              };
              if (parsed.error) message = parsed.error;
            } catch {
              // Keep the bounded repository-owned fallback.
            }
            reject(new LocalStateError(message, incoming.statusCode ?? 500));
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(payload);
    });
  }

  async function fireAutomation(
    automation: Automation,
    fire?: AutomationFire,
  ): Promise<AutomationFireExecution> {
    if (!fire) throw new AutomationError("Automation fire identity is unavailable.", 500);
    const address = serverRef?.address();
    if (!address || typeof address === "string") {
      return {
        status: "unknown",
        error: "The provider outcome could not be proven because the local host was not listening.",
      };
    }
    const projection = await state.load();
    const thread = projection.threads.find((item) => item.id === automation.threadId);
    if (!thread) throw new AutomationError("Target conversation was not found.", 404);
    const project = projection.projects.find((item) => item.id === thread.projectId);
    if (!project) throw new AutomationError("Target project was not found.", 404);
    const session = projection.providerSessions.find((item) => item.threadId === thread.id);
    const providerId = thread.provider ?? session?.provider ?? "claude-code";
    const model =
      thread.model ??
      session?.model ??
      (providerId === "claude-code"
        ? "default"
        : providerId === "shikigami"
          ? "scripted"
          : "default");
    const profileId =
      thread.profileId ??
      session?.profileId ??
      (providerId === "shikigami" ? DEFAULT_SHIKIGAMI_PROFILE_ID : undefined);
    const internalHost =
      address.address === "::"
        ? "::1"
        : address.address === "0.0.0.0"
          ? "127.0.0.1"
          : address.address;
    const payload = Buffer.from(
      JSON.stringify({
        root: project.root,
        worktree: thread.worktree,
        prompt: automation.prompt,
        mode: automation.mode,
        conversationId: thread.id,
        projectId: project.id,
        threadId: thread.id,
        resumeSessionId: providerId === "shikigami" ? undefined : session?.sessionId,
        provider: providerId,
        model,
        profileId:
          providerId === "claude-code" || providerId === "shikigami" ? profileId : undefined,
        automationFireId: fire.id,
      }),
      "utf8",
    );
    let incoming: IncomingMessage;
    try {
      const send = tls ? httpsRequest : httpRequest;
      incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = send(
          {
            host: internalHost,
            port: address.port,
            path: "/api/provider/runs",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(payload.length),
              "x-aldunis-internal-request": internalRequestToken,
            },
            ...(tls ? { rejectUnauthorized: false } : {}),
          },
          resolve,
        );
        outgoing.once("error", reject);
        outgoing.end(payload);
      });
    } catch {
      return {
        status: "unknown",
        error: "The provider outcome could not be proven after the local request disconnected.",
      };
    }
    const statusCode = incoming.statusCode ?? 500;
    try {
      await new Promise<void>((resolve, reject) => {
        incoming.once("end", resolve);
        incoming.once("error", reject);
        incoming.resume();
      });
    } catch {
      const outcome = await state.automationFireOutcome(fire.id);
      return outcome.status === "unknown"
        ? {
            status: "unknown",
            error: "The provider outcome could not be proven after the event stream disconnected.",
          }
        : outcome;
    }
    if (statusCode < 200 || statusCode >= 300) {
      const outcome = await state.automationFireOutcome(fire.id);
      if (outcome.status !== "unknown") return outcome;
      if (statusCode < 500 && !(await state.getAutomationFireById(fire.id))?.turnId) {
        return {
          status: "failed",
          error: "The automation request was rejected before provider launch.",
        };
      }
      return { status: "unknown", error: outcome.error };
    }
    return state.automationFireOutcome(fire.id);
  }

  const automationScheduler = new AutomationScheduler(automations, {
    isThreadBusy,
    fire: fireAutomation,
    fireStore: {
      get: (automationId, key) => state.getAutomationFire(automationId, key),
      getById: (fireId) => state.getAutomationFireById(fireId),
      latest: (automationId) => state.latestAutomationFire(automationId),
      recordSkippedBusy: (input) => state.recordAutomationFireSkippedBusy(input),
      claim: (input) => state.claimAutomationFire(input),
      finish: (fireId, status, error) => state.finishAutomationFire(fireId, status, error),
    },
    onFinished: async (automation) => {
      const projection = await state.load();
      const thread = projection.threads.find((candidate) => candidate.id === automation.threadId);
      await autonomy.dispatch("automation_completed", thread?.projectId ?? null);
    },
  });

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    await recovery;
    await profileBootstrap;
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    const listeningAddress = serverRef?.address();
    const internalRequest =
      request.socket.remoteAddress !== undefined &&
      (LOOPBACK_HOSTS.has(request.socket.remoteAddress) ||
        (listeningAddress &&
          typeof listeningAddress !== "string" &&
          request.socket.remoteAddress === listeningAddress.address)) &&
      request.headers["x-aldunis-internal-request"] === internalRequestToken;
    const configuredPublicOrigin =
      typeof publicOrigin === "function" ? publicOrigin() : publicOrigin;
    const localControlRequest =
      allowLocalControl && isLocalControlRequest(request, localBindHost, configuredPublicOrigin);
    let managedIdentity: ManagedIdentity | undefined;
    if (
      managedHost &&
      !internalRequest &&
      route.startsWith("/api/") &&
      route !== "/api/remote/descriptor"
    ) {
      try {
        managedIdentity = await managedHost.verify(
          request,
          await bufferRequest(request, maxBodyBytesForRoute(route)),
        );
      } catch (error) {
        const status = error instanceof ManagedHostError ? error.status : 500;
        const message =
          error instanceof ManagedHostError ? error.message : "Managed authentication failed.";
        sendJson(response, status, { error: message });
        return;
      }
    } else if (
      remoteAuth &&
      !internalRequest &&
      route.startsWith("/api/") &&
      route !== "/api/remote/pair" &&
      route !== "/api/remote/descriptor" &&
      !(localControlRequest && route.startsWith("/api/remote/admin/"))
    ) {
      try {
        await remoteAuth.verify(request, await bufferRequest(request, maxBodyBytesForRoute(route)));
      } catch (error) {
        const status = error instanceof RemoteAuthError ? error.status : 500;
        const message =
          error instanceof RemoteAuthError ? error.message : "Remote authentication failed.";
        sendJson(response, status, { error: message });
        return;
      }
    }
    if (
      await handleApi(request, response, {
        provider,
        codex,
        shikigami,
        permissions,
        delivery,
        releaseDelivery,
        state,
        profiles,
        previews,
        preferences,
        automations,
        automationScheduler,
        autonomy,
        worktrees,
        directories,
        adapters,
        providerDiscovery,
        activeAcp,
        wake,
        withDelegatedControlLock,
        runChildFollowUp,
        chisei,
        remoteAuth,
        internalApprovalUrl: internalPermissionCallback?.url,
        managedHost,
        browser,
        browserMcpPath,
        publicOrigin,
        remoteRequest: Boolean(remoteAuth) && !internalRequest,
        internalRequest,
        localControlRequest,
        managedIdentity,
      })
    )
      return;
    await serveStatic(request, response, dist);
  };
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  serverRef = server;
  if (!managedHost) {
    server.once("listening", () => {
      void recovery
        .then(() => {
          if (server.listening) {
            automationScheduler.start();
            autonomyScheduler.start();
          }
        })
        .catch(() => undefined);
    });
  }
  server.once("close", () => {
    unsubscribePermissionChanges();
    automationScheduler.stop();
    autonomyScheduler.stop();
    codex.close();
    internalPermissionCallback?.server.close();
    // Best-effort: kill npm/vite process trees so desktop quit does not orphan previews.
    void previews.stopAll().catch(() => undefined);
    // Best-effort: journal any open stream segments before the process exits.
    void state.flushPendingAssistantHistory().catch(() => undefined);
  });
  return server;
}
