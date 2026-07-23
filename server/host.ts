import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, ProviderProtocolError } from "./provider.ts";
import { PermissionBroker, PermissionError } from "./permission.ts";
import {
  canonicalizeRepositoryRoot,
  discoverWorktrees,
  openRepository,
  RepositoryError,
} from "./repository.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 16 * 1024;

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
      sendJson(response, 200, await openRepository(body.path));
      return true;
    }
    if (route === "/api/provider/runs") {
      const body = await readJson(request) as {
        root?: unknown;
        worktree?: unknown;
        prompt?: unknown;
        conversationId?: unknown;
        resumeSessionId?: unknown;
      };
      if (
        typeof body.root !== "string"
        || typeof body.worktree !== "string"
        || typeof body.prompt !== "string"
        || !body.prompt.trim()
        || typeof body.conversationId !== "string"
        || !body.conversationId
        || (body.resumeSessionId !== undefined && typeof body.resumeSessionId !== "string")
      ) {
        throw new RepositoryError("A repository, worktree, and prompt are required.");
      }
      const context = await selectedWorktree(body.root, body.worktree);
      const port = request.socket.localPort;
      if (!port) throw new RepositoryError("The local permission broker is unavailable.", 503);
      const approvalUrl = `http://127.0.0.1:${port}/api/provider/permissions/request`;
      const run = await provider.start(
        context.root,
        context.worktree,
        body.conversationId,
        body.prompt.trim(),
        approvalUrl,
        body.resumeSessionId,
      );
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-provider-run-id": run.id,
      });
      for await (const event of run.events) response.write(`${JSON.stringify(event)}\n`);
      response.end();
      return true;
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
    const status = error instanceof RepositoryError || error instanceof PermissionError
      ? error.status
      : 500;
    const message = error instanceof RepositoryError
      || error instanceof ProviderProtocolError
      || error instanceof PermissionError
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

export function createLocalHost(dist = fileURLToPath(new URL("../dist", import.meta.url))) {
  const permissions = new PermissionBroker();
  const provider = new ClaudeCodeAdapter("claude", permissions);
  return createServer(async (request, response) => {
    if (await handleApi(request, response, provider, permissions)) return;
    await serveStatic(request, response, dist);
  });
}
