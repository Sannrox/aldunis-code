import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, ProviderProtocolError } from "./provider.ts";
import { CodexCliAdapter } from "./codex-provider.ts";
import { AcpProviderAdapter } from "./acp-provider.ts";
import { buildUsageReport, isUsageRangeDays } from "../src/lib/usage.ts";
import { ShikigamiAdapter } from "./shikigami-provider.ts";
import { ProviderDiscovery } from "./provider-discovery.ts";
import { ProviderModelError } from "./provider-models.ts";
import { ProviderAdapterError, ProviderAdapterStore } from "./provider-adapters.ts";
import { listReviewedAdapters, prepareReviewedAdapter } from "./reviewed-adapters.ts";
import { listChangedFiles, readFileDiff } from "./changes.ts";
import { DeliveryBroker } from "./delivery.ts";
import { ReleaseDeliveryBroker, ReleaseDeliveryStore } from "./release-delivery-workflow.ts";
import { PermissionBroker, PermissionError, type ApprovalSnapshot } from "./permission.ts";
import { canonicalizeRepositoryRoot, discoverWorktrees, RepositoryError } from "./repository.ts";
import {
  LocalStateError,
  LocalStateStore,
  projectThreadStatus,
  type StateProjection,
  type ThreadStatus,
} from "./state.ts";
import { ClaudeProfileStore, DEFAULT_SHIKIGAMI_PROFILE_ID, ProfileError } from "./profiles.ts";
import { PreviewError, PreviewManager } from "./preview.ts";
import { PreferencesError, PreferencesStore } from "./preferences.ts";
import {
  AutomationError,
  AutomationScheduler,
  AutomationStore,
  type Automation,
  type AutomationFire,
  type AutomationFireExecution,
} from "./automations.ts";
import { AutonomyScheduler, AutonomyEngine } from "./autonomy-engine.ts";
import { AutonomyError } from "./autonomy.ts";
import { WorktreeManager } from "./worktrees.ts";
import { RemoteAuth, RemoteAuthError } from "./remote-auth.ts";
import { DirectoryBrowser } from "./directory-browser.ts";
import { WakeBroker } from "./wake.ts";
import { resolveProductAvailability } from "./products.ts";
import { ManagedHost, ManagedHostError, type ManagedIdentity } from "./managed-host.ts";
import { BrowserError, SharedBrowserBroker, type BrowserHost } from "./browser.ts";
import { ChiseiClientError, ChiseiProjectionClient } from "./chisei-client.ts";
import {
  admitProviderRun,
  createProviderRunSink,
  type ProviderRunModuleContext,
} from "./provider-run.ts";
import { handleBrowserRoute } from "./browser-routes.ts";
import { handleAutonomyRoute } from "./autonomy-routes.ts";
import { handleReviewRoute } from "./review-routes.ts";
import { handleConversationLifecycleRoute } from "./conversation-lifecycle-routes.ts";
import { handleProviderAdapterRoute } from "./provider-adapter-routes.ts";
import { handleProviderProfileRoute } from "./provider-profile-routes.ts";
import { handleContextRoute, MAX_STAGE_IMAGE_BODY_BYTES } from "./context-routes.ts";
import { handleCheckpointRoute } from "./checkpoint-routes.ts";
import { handleWorkspaceRoute } from "./workspace-routes.ts";
import { handleChiseiRoute } from "./chisei-routes.ts";
import { handleDelegatedControlRoute } from "./delegated-control-routes.ts";
import { handleAutomationRoute } from "./automation-routes.ts";
import { handleDeliveryRoute } from "./delivery-routes.ts";
import { handleConversationForkRoute } from "./conversation-fork-routes.ts";
import {
  filterManagedProjection,
  handleWorkbenchProjectionRoute,
} from "./workbench-projection-routes.ts";
import { handleStateMaintenanceRoute } from "./state-maintenance-routes.ts";
import { handlePreviewRoute } from "./preview-routes.ts";
import { handleRemoteAccessRoute } from "./remote-access-routes.ts";
import {
  handleProviderControlRoute,
  handleProviderPermissionRequest,
  PROVIDER_PERMISSION_ROUTE,
} from "./provider-control-routes.ts";

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

const MAX_BODY_BYTES = 128 * 1024;
/** Base64 image staging: 2 MiB raw ≈ 2.7 MiB encoded, plus JSON envelope. */
const activeCheckpointProjects = new Set<string>();
const activeCheckpointWorktrees = new Set<string>();
const requestBodies = new WeakMap<IncomingMessage, Buffer>();

function checkpointWorktreeKey(projectId: string, worktree: string): string {
  return JSON.stringify([projectId, worktree]);
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
  // inspect(): status projection is read-only; avoid structuredClone on every
  // provider event and wake publish during long turns.
  const next = projectThreadStatus(await state.inspect(), threadId);
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

function createInternalPermissionCallback(permissions: PermissionBroker): {
  server: ReturnType<typeof createHttpServer>;
  url: Promise<string>;
} {
  const server = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== PROVIDER_PERMISSION_ROUTE) {
      sendJson(response, 404, { error: "Internal permission route not found." });
      return;
    }
    try {
      await handleProviderPermissionRequest(request, response, {
        permissions,
        readJson,
        sendJson,
      });
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
      const projection = await state.inspect();
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
        // Pure membership lookup; inspect avoids cloning multi-MB history.
        loadState: async () => (await state.inspect()) as StateProjection,
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
        // Membership filter only; inspect avoids cloning full history per wake.
        void state
          .inspect()
          .then((projection) => {
            if (response.writableEnded) return;
            const visible = filterManagedProjection(projection as StateProjection, managedHost);
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
    if (
      await handleProviderProfileRoute(route, request, response, {
        profiles,
        adapters,
        providerDiscovery,
        remote: remoteRequest,
        managed: Boolean(managedHost),
        defaultDiscoveryCwd: process.cwd(),
        selectWorktree: selectedWorktree,
        readJson,
        readOptionalJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleProviderAdapterRoute(route, request, response, {
        adapters,
        profiles,
        listReviewedAdapters: () => listReviewedAdapters(adapters),
        prepareReviewedAdapter: (slug) => prepareReviewedAdapter(adapters, slug),
        remote: remoteRequest,
        managed: Boolean(managedHost),
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleRemoteAccessRoute(route, request, response, {
        remoteAuth,
        managed: Boolean(managedHost),
        localControlRequest,
        publicOrigin,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleWorkspaceRoute(route, request, response, {
        state,
        preferences,
        worktrees,
        directories,
        activeProjects: activeCheckpointProjects,
        remoteRequest,
        remoteHost: Boolean(remoteAuth),
        managedHost,
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleChiseiRoute(route, request, response, {
        state,
        chisei,
        remoteRequest,
        managed: Boolean(managedHost),
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleWorkbenchProjectionRoute(route, request, response, {
        state,
        preferences,
        permissions,
        worktrees,
        managedHost,
        assertManagedThread,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleConversationForkRoute(route, request, response, {
        state,
        worktrees,
        profiles,
        codex,
        shikigami,
        adapters,
        managed: Boolean(managedHost),
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    ) {
      return true;
    }
    if (
      await handleConversationLifecycleRoute(route, request, response, {
        state,
        preferences,
        worktrees,
        managed: Boolean(managedHost),
        assertManagedThread,
        selectManagedWorktree: managedHost
          ? (root, worktree) => managedHost.selectWorktree(root, worktree)
          : async () => undefined,
        withDelegatedControlLock,
        readJson,
        sendJson,
      })
    )
      return true;
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
    if (
      await handleAutomationRoute(route, request, response, {
        automations,
        automationScheduler,
        state,
        remoteRequest,
        managed: Boolean(managedHost),
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleAutonomyRoute(route, request, response, {
        autonomy,
        state,
        remoteRequest,
        managed: Boolean(managedHost),
        visibleProjectIds: async () => {
          if (!managedHost) return new Set<string>();
          const visible = filterManagedProjection(await state.inspect(), managedHost);
          return new Set(visible.projects.map((project) => project.id));
        },
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleStateMaintenanceRoute(route, request, response, {
        state,
        managed: Boolean(managedHost),
        activeProjects: activeCheckpointProjects,
        activeWorktrees: activeCheckpointWorktrees,
        assertManagedProject,
        withLock: withDelegatedControlLock,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleCheckpointRoute(route, request, response, {
        state,
        activeProjects: activeCheckpointProjects,
        activeWorktrees: activeCheckpointWorktrees,
        worktreeKey: checkpointWorktreeKey,
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleProviderControlRoute(route, request, response, {
        provider,
        codex,
        shikigami,
        permissions,
        activeAcp,
        managed: Boolean(managedHost),
        selectWorktree: selectedWorktree,
        startRun: (body, localPort, output) =>
          admitProviderRun({ body, localPort }, output, {
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
          }),
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleContextRoute(route, request, response, {
        remote: remoteRequest,
        managed: Boolean(managedHost),
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleDelegatedControlRoute(route, request, response, {
        state,
        preferences,
        permissions,
        codex,
        managed: Boolean(managedHost),
        assertManagedThread,
        withLock: withDelegatedControlLock,
        runChildFollowUp,
        publishThreadStatusTransition: (threadId, previous, force) =>
          publishThreadStatusTransition(wake, state, threadId, previous, force),
        readJson,
        sendJson,
      })
    )
      return true;
    if (
      await handleReviewRoute(route, request, response, {
        state,
        changes: { listChangedFiles, readFileDiff },
        managed: Boolean(managedHost),
        assertManagedThread,
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    ) {
      return true;
    }
    if (
      await handleDeliveryRoute(route, request, response, {
        delivery,
        releaseDelivery,
        state,
        remote: remoteRequest,
        managed: Boolean(managedHost),
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    ) {
      return true;
    }
    if (
      await handlePreviewRoute(route, request, response, {
        previews,
        selectWorktree: selectedWorktree,
        readJson,
        sendJson,
      })
    )
      return true;
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
    const projection = await state.inspect();
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

  const localProviderPort = (): number => {
    const address = serverRef?.address();
    if (!address || typeof address === "string") {
      throw new LocalStateError("The provider run interface is unavailable.", 503);
    }
    return address.port;
  };

  const providerRunContext = (
    remoteRequest: boolean,
    internalRequest: boolean,
  ): ProviderRunModuleContext => ({
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
    internalApprovalUrl: internalPermissionCallback?.url,
    managedHost,
    browser,
    browserMcpPath,
    remoteRequest,
    internalRequest,
    selectedWorktree: managedHost
      ? (root, worktree) => managedHost.selectWorktree(root, worktree)
      : selectWorktreeForRepository,
    publishThreadStatusTransition,
    activeCheckpointProjects,
    activeCheckpointWorktrees,
    checkpointWorktreeKey,
  });

  async function isThreadBusy(threadId: string): Promise<boolean> {
    const projection = await state.inspect();
    return projection.turns.some(
      (turn) =>
        turn.threadId === threadId &&
        ["active", "running", "waiting_for_user", "waiting_for_approval"].includes(turn.status),
    );
  }

  async function runChildFollowUp(body: Record<string, unknown>): Promise<void> {
    if (childFollowUpOverride) return childFollowUpOverride(body);
    const execution = admitProviderRun(
      { body, localPort: localProviderPort() },
      createProviderRunSink(),
      providerRunContext(false, true),
    );
    void execution.completed.catch(() => undefined);
    await execution.accepted;
  }

  async function fireAutomation(
    automation: Automation,
    fire?: AutomationFire,
  ): Promise<AutomationFireExecution> {
    if (!fire) throw new AutomationError("Automation fire identity is unavailable.", 500);
    const projection = await state.inspect();
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
    let localPort: number;
    try {
      localPort = localProviderPort();
    } catch {
      return {
        status: "unknown",
        error: "The provider outcome could not be proven because the local host was not listening.",
      };
    }
    const execution = admitProviderRun(
      {
        body: {
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
        },
        localPort,
      },
      createProviderRunSink(),
      providerRunContext(false, true),
    );
    try {
      void execution.accepted.catch(() => undefined);
      await execution.completed;
    } catch (error) {
      const outcome = await state.automationFireOutcome(fire.id);
      if (outcome.status !== "unknown") return outcome;
      const status =
        error instanceof RepositoryError ||
        error instanceof PermissionError ||
        error instanceof LocalStateError ||
        error instanceof ProfileError ||
        error instanceof PreferencesError ||
        error instanceof ProviderAdapterError ||
        error instanceof ProviderModelError
          ? error.status
          : 500;
      if (status < 500 && !(await state.getAutomationFireById(fire.id))?.turnId) {
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
      const projection = await state.inspect();
      const thread = projection.threads.find((candidate) => candidate.id === automation.threadId);
      await autonomy.dispatch("automation_completed", thread?.projectId ?? null);
    },
  });

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    await recovery;
    await profileBootstrap;
    const route = new URL(request.url ?? "/", "http://localhost").pathname;
    const internalRequest = false;
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
