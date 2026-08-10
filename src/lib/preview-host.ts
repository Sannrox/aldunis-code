import type { BrowserSessionSnapshot, PreviewSnapshot } from "../types";

type RequestAdapter = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PreviewHostScope {
  root: string;
  worktree: string;
}

export type PreviewHostAction =
  | { kind: "preview.prepare"; origin: string }
  | { kind: "preview.decide"; decision: "allow_once" | "deny" }
  | { kind: "preview.status" }
  | { kind: "preview.stop" }
  | { kind: "browser.open"; conversationId: string }
  | { kind: "browser.control"; enabled: boolean }
  | { kind: "browser.status" }
  | { kind: "browser.close" }
  | { kind: "browser.release" };

export interface PreviewHostState {
  preview: PreviewSnapshot | null;
  browser: BrowserSessionSnapshot | null;
}

export interface PreviewHost {
  perform(action: PreviewHostAction): Promise<PreviewHostState>;
  dispose(options?: { stopPreview?: boolean }): Promise<void>;
}

const previewStates = new Set([
  "approval_pending",
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
]);
const browserStates = new Set(["awaiting_view", "ready", "closed", "failed"]);
const browserControllers = new Set(["none", "human", "agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => typeof value[name] === "string");
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isPreviewSnapshot(value: unknown): value is PreviewSnapshot {
  return Boolean(
    isRecord(value) &&
    hasStrings(value, ["id", "repository", "worktree", "command", "origin"]) &&
    previewStates.has(value.state as string) &&
    isNullableString(value.approvalExpiresAt) &&
    isNullableString(value.message),
  );
}

function isBrowserSessionSnapshot(value: unknown): value is BrowserSessionSnapshot {
  return Boolean(
    isRecord(value) &&
    value.schemaVersion === 1 &&
    hasStrings(value, ["id", "conversationId", "origin", "partition", "createdAt", "updatedAt"]) &&
    browserStates.has(value.state as string) &&
    typeof value.agentControl === "boolean" &&
    browserControllers.has(value.controller as string) &&
    isNullableString(value.url) &&
    isNullableString(value.title) &&
    isNullableString(value.error),
  );
}

function serverError(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim()) {
    return body.error.slice(0, 500);
  }
  return fallback;
}

export function previewHostErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof TypeError && cause.message === "Failed to fetch") {
    return "Preview service is unavailable. The action was not confirmed; retry when the local host is ready.";
  }
  return cause instanceof Error ? cause.message : fallback;
}

export function createPreviewHost(
  scope: PreviewHostScope,
  request: RequestAdapter = (input, init) => globalThis.fetch(input, init),
): PreviewHost {
  let preview: PreviewSnapshot | null = null;
  let browser: BrowserSessionSnapshot | null = null;
  let disposed = false;
  let operations = Promise.resolve();

  const state = (): PreviewHostState => ({ preview, browser });
  const post = async (route: string, payload: unknown, fallback: string): Promise<unknown> => {
    const response = await request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw new Error(serverError(result, fallback));
    return result;
  };
  const previewResult = async (route: string, payload: unknown, fallback: string) => {
    const result = await post(route, payload, fallback);
    if (!isPreviewSnapshot(result)) throw new Error(fallback);
    if (result.repository !== scope.root || result.worktree !== scope.worktree) {
      throw new Error(fallback);
    }
    if (preview && result.id !== preview.id) throw new Error(fallback);
    preview = result;
  };
  const browserResult = async (
    route: string,
    payload: unknown,
    fallback: string,
    expectedConversation = browser?.conversationId,
  ) => {
    const result = await post(route, payload, fallback);
    if (!isBrowserSessionSnapshot(result)) throw new Error(fallback);
    if (
      result.conversationId !== expectedConversation ||
      result.origin !== preview?.origin ||
      (browser && result.id !== browser.id)
    ) {
      throw new Error(fallback);
    }
    browser = result;
  };
  const browserPayload = (session: BrowserSessionSnapshot) => ({
    root: scope.root,
    worktree: scope.worktree,
    conversationId: session.conversationId,
    origin: session.origin,
    sessionId: session.id,
  });

  const execute = async (action: PreviewHostAction): Promise<PreviewHostState> => {
    if (disposed) throw new Error("The preview host has been disposed.");
    switch (action.kind) {
      case "preview.prepare":
        await previewResult(
          "/api/previews/request",
          {
            root: scope.root,
            worktree: scope.worktree,
            origin: action.origin,
          },
          "Preview could not be prepared.",
        );
        break;
      case "preview.decide":
        if (!preview || preview.state !== "approval_pending")
          throw new Error("Preview approval is no longer pending.");
        await previewResult(
          `/api/previews/${preview.id}/decide`,
          {
            root: scope.root,
            worktree: scope.worktree,
            decision: action.decision,
          },
          "Preview decision failed.",
        );
        break;
      case "preview.status":
        if (!preview) throw new Error("Preview status is unavailable.");
        await previewResult(
          `/api/previews/${preview.id}/status`,
          undefined,
          "Preview status is unavailable.",
        );
        break;
      case "preview.stop":
        if (!preview) throw new Error("Preview could not be stopped.");
        await previewResult(
          `/api/previews/${preview.id}/stop`,
          {
            root: scope.root,
            worktree: scope.worktree,
          },
          "Preview could not be stopped.",
        );
        break;
      case "browser.open":
        if (!preview || preview.state !== "running")
          throw new Error("Start the local preview before opening its shared browser.");
        await browserResult(
          "/api/browser/sessions/open",
          {
            root: scope.root,
            worktree: scope.worktree,
            conversationId: action.conversationId,
            origin: preview.origin,
          },
          "Shared browser could not be opened.",
          action.conversationId,
        );
        break;
      case "browser.control":
        if (!browser) throw new Error("Shared browser control is unavailable.");
        await browserResult(
          "/api/browser/sessions/control",
          {
            ...browserPayload(browser),
            enabled: action.enabled,
          },
          "Browser control could not be updated.",
        );
        break;
      case "browser.status":
        if (!browser) throw new Error("Shared browser status is unavailable.");
        await browserResult(
          "/api/browser/sessions/status",
          browserPayload(browser),
          "Shared browser status is unavailable.",
        );
        break;
      case "browser.close": {
        if (!browser) return state();
        const closing = browser;
        await browserResult(
          "/api/browser/sessions/close",
          browserPayload(closing),
          "Shared browser could not be closed.",
        );
        if (browser?.state !== "closed") throw new Error("Shared browser could not be closed.");
        browser = null;
        break;
      }
      case "browser.release": {
        if (!browser) return state();
        const releasing = browser;
        browser = null;
        await post(
          "/api/browser/sessions/close",
          browserPayload(releasing),
          "Shared browser could not be closed.",
        ).catch(() => undefined);
        break;
      }
    }
    return state();
  };

  return {
    perform(action) {
      const result = operations.then(() => execute(action));
      operations = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async dispose(options = {}) {
      if (disposed) return;
      disposed = true;
      await operations;
      const closing = browser;
      const stopping = preview;
      browser = null;
      preview = null;
      const cleanup: Promise<unknown>[] = [];
      if (closing) {
        cleanup.push(
          post(
            "/api/browser/sessions/close",
            browserPayload(closing),
            "Shared browser could not be closed.",
          ),
        );
      }
      if (options.stopPreview && stopping && !["stopped", "failed"].includes(stopping.state)) {
        cleanup.push(
          post(
            `/api/previews/${stopping.id}/stop`,
            { root: scope.root, worktree: scope.worktree },
            "Preview could not be stopped.",
          ),
        );
      }
      await Promise.allSettled(cleanup);
    },
  };
}
