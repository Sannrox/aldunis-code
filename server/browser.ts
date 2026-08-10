import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { electronMcpEnvironment } from "./electron-runtime.ts";

export const BROWSER_MCP_NAME = "aldunis_browser";
export const MAX_BROWSER_OPERATION_TEXT = 8_000;
export const MAX_BROWSER_SELECTOR = 1_000;
export const MAX_BROWSER_URL = 2_048;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const BROWSER_MUTATIONS = new Set(["navigate", "click", "type", "press", "scroll"]);

export type BrowserOperation =
  | { kind: "status" }
  | { kind: "snapshot" }
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector?: string; x?: number; y?: number }
  | { kind: "type"; text: string }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "wait"; milliseconds: number };

export type BrowserController = "none" | "human" | "agent";
export type BrowserSessionState = "awaiting_view" | "ready" | "closed" | "failed";

export interface BrowserPageElement {
  selector: string;
  tag: string;
  role: string | null;
  name: string | null;
  text: string | null;
  disabled: boolean;
}

export interface BrowserPageSnapshot {
  url: string | null;
  title: string | null;
  loading: boolean;
  visibleText: string;
  interactiveElements: BrowserPageElement[];
  screenshot: string | null;
  actionTimeline: Array<{ kind: string; at: string }>;
}

export interface BrowserHostState {
  connected: boolean;
  url: string | null;
  title: string | null;
  controller: BrowserController;
  controlEpoch: number;
  error: string | null;
}

export type BrowserHostResult =
  | { ok: true; kind: "status"; state: BrowserHostState }
  | { ok: true; kind: "snapshot"; snapshot: BrowserPageSnapshot }
  | { ok: true; kind: "action"; message: string; state: BrowserHostState }
  | { ok: false; code: string; message: string };

export interface BrowserHost {
  getState(sessionId: string): Promise<BrowserHostState> | BrowserHostState;
  execute(
    sessionId: string,
    operation: BrowserOperation,
    expectedControlEpoch: number,
  ): Promise<BrowserHostResult>;
  setAgentControl(sessionId: string, enabled: boolean): Promise<void> | void;
  close(sessionId: string): Promise<void> | void;
  setPictureInPicture(sessionId: string, open: boolean): Promise<void> | void;
}

export interface BrowserSessionSnapshot {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  origin: string;
  partition: string;
  state: BrowserSessionState;
  agentControl: boolean;
  controller: BrowserController;
  url: string | null;
  title: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserMcpConfiguration {
  name: typeof BROWSER_MCP_NAME;
  command: string;
  args: string[];
  environment: Record<string, string>;
}

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "browser_error",
  ) {
    super(message);
  }
}

function boundedString(value: unknown, maximum: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new BrowserError(`${field} must be a non-empty bounded string.`);
  }
  return value;
}

export function assertBrowserUrl(value: unknown): string {
  const raw = boundedString(value, MAX_BROWSER_URL, "Browser URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError("Browser navigation requires a valid loopback HTTP(S) URL.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_NAMES.has(url.hostname.replace(/^\[|\]$/g, "")) ||
    url.username ||
    url.password
  ) {
    throw new BrowserError(
      "Shared browser navigation is limited to loopback HTTP(S) URLs.",
      403,
      "browser_url_denied",
    );
  }
  return url.toString();
}

function partitionForConversation(conversationId: string): string {
  const digest = createHash("sha256").update(conversationId, "utf8").digest("hex").slice(0, 32);
  return `persist:aldunis-browser-${digest}`;
}

function isMutation(operation: BrowserOperation): boolean {
  return BROWSER_MUTATIONS.has(operation.kind);
}

function normalizeOperation(input: unknown): BrowserOperation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new BrowserError("A browser operation is required.");
  }
  const value = input as Record<string, unknown>;
  if (
    value.kind !== "status" &&
    value.kind !== "snapshot" &&
    value.kind !== "navigate" &&
    value.kind !== "click" &&
    value.kind !== "type" &&
    value.kind !== "press" &&
    value.kind !== "scroll" &&
    value.kind !== "wait"
  ) {
    throw new BrowserError(
      "The browser operation is unsupported.",
      400,
      "browser_operation_unsupported",
    );
  }
  if (value.kind === "status" || value.kind === "snapshot") return { kind: value.kind };
  if (value.kind === "navigate") return { kind: "navigate", url: assertBrowserUrl(value.url) };
  if (value.kind === "type") {
    return {
      kind: "type",
      text: boundedString(value.text, MAX_BROWSER_OPERATION_TEXT, "Browser text"),
    };
  }
  if (value.kind === "press") {
    return { kind: "press", key: boundedString(value.key, 80, "Browser key") };
  }
  if (value.kind === "scroll") {
    const x = typeof value.x === "number" && Number.isFinite(value.x) ? Math.trunc(value.x) : 0;
    const y = typeof value.y === "number" && Number.isFinite(value.y) ? Math.trunc(value.y) : 0;
    if (Math.abs(x) > 20_000 || Math.abs(y) > 20_000) {
      throw new BrowserError("Browser scroll distance is too large.");
    }
    return { kind: "scroll", x, y };
  }
  if (value.kind === "wait") {
    const milliseconds =
      typeof value.milliseconds === "number" && Number.isFinite(value.milliseconds)
        ? Math.trunc(value.milliseconds)
        : 0;
    if (milliseconds < 0 || milliseconds > 5_000) {
      throw new BrowserError("Browser wait must be between 0 and 5000 milliseconds.");
    }
    return { kind: "wait", milliseconds };
  }
  const selector =
    value.selector === undefined
      ? undefined
      : boundedString(value.selector, MAX_BROWSER_SELECTOR, "Browser selector");
  const x = value.x === undefined ? undefined : value.x;
  const y = value.y === undefined ? undefined : value.y;
  if (x !== undefined && (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 20_000)) {
    throw new BrowserError("Browser click x must be a bounded coordinate.");
  }
  if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 20_000)) {
    throw new BrowserError("Browser click y must be a bounded coordinate.");
  }
  if (!selector && (x === undefined || y === undefined)) {
    throw new BrowserError("Browser click requires a selector or both coordinates.");
  }
  return { kind: "click", ...(selector ? { selector } : {}), ...(x !== undefined ? { x, y } : {}) };
}

function safeTokenEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class SharedBrowserBroker {
  readonly #sessions = new Map<
    string,
    {
      snapshot: BrowserSessionSnapshot;
      token: string;
    }
  >();
  readonly #providerTokens = new Map<string, string>();

  constructor(private readonly host: BrowserHost | null) {}

  open(conversationIdInput: unknown, originInput: unknown): BrowserSessionSnapshot {
    const conversationId = boundedString(conversationIdInput, 200, "Conversation ID");
    const origin = assertBrowserUrl(originInput);
    const existing = [...this.#sessions.values()].find(
      (session) =>
        session.snapshot.conversationId === conversationId && session.snapshot.state !== "closed",
    );
    if (existing) {
      if (existing.snapshot.origin !== origin) {
        throw new BrowserError(
          "Close the existing shared browser before changing its loopback origin.",
          409,
          "browser_origin_conflict",
        );
      }
      return { ...existing.snapshot };
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const snapshot: BrowserSessionSnapshot = {
      schemaVersion: 1,
      id,
      conversationId,
      origin,
      partition: partitionForConversation(conversationId),
      state: "awaiting_view",
      agentControl: false,
      controller: "none",
      url: origin,
      title: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#sessions.set(id, {
      snapshot,
      token: this.#providerTokens.get(conversationId) ?? randomUUID(),
    });
    return { ...snapshot };
  }

  snapshot(idInput: unknown): Promise<BrowserSessionSnapshot> {
    const session = this.#get(idInput);
    return this.#refresh(session);
  }

  snapshotForConversation(conversationId: string): Promise<BrowserSessionSnapshot | null> {
    const session = [...this.#sessions.values()].find(
      (candidate) =>
        candidate.snapshot.conversationId === conversationId &&
        candidate.snapshot.state !== "closed",
    );
    return session ? this.#refresh(session) : Promise.resolve(null);
  }

  async setAgentControl(
    idInput: unknown,
    context: { conversationId: string; origin: string },
    enabled: boolean,
  ): Promise<BrowserSessionSnapshot> {
    const session = this.#get(idInput);
    this.#assertContext(session.snapshot, context);
    session.snapshot.agentControl = enabled;
    session.snapshot.updatedAt = new Date().toISOString();
    await this.host?.setAgentControl(session.snapshot.id, enabled);
    if (!enabled && session.snapshot.controller === "agent") session.snapshot.controller = "human";
    return this.#refresh(session);
  }

  async close(
    idInput: unknown,
    context: { conversationId: string; origin: string },
  ): Promise<BrowserSessionSnapshot> {
    const session = this.#get(idInput);
    this.#assertContext(session.snapshot, context);
    await this.host?.close(session.snapshot.id);
    // Keep the token stable for an already-running provider. It has no authority
    // while the session is closed because executeProvider requires an active session.
    session.snapshot.state = "closed";
    session.snapshot.agentControl = false;
    session.snapshot.controller = "none";
    session.snapshot.updatedAt = new Date().toISOString();
    return { ...session.snapshot };
  }

  async setPictureInPicture(
    idInput: unknown,
    context: { conversationId: string; origin: string },
    open: boolean,
  ): Promise<BrowserSessionSnapshot> {
    const session = this.#get(idInput);
    this.#assertContext(session.snapshot, context);
    if (!this.host)
      throw new BrowserError(
        "Picture-in-picture is available in the desktop application only.",
        503,
      );
    await this.host.setPictureInPicture(session.snapshot.id, open);
    return this.#refresh(session);
  }

  providerMcpConfiguration(input: {
    conversationId: string;
    endpoint: string;
    command: string;
    script: string;
    /** Injected for tests; production uses process.versions.electron. */
    electronVersion?: string;
  }): BrowserMcpConfiguration {
    let url: URL;
    try {
      url = new URL(input.endpoint);
    } catch {
      throw new BrowserError("The browser broker endpoint is invalid.", 500);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BrowserError("The browser broker endpoint must use HTTP(S).", 500);
    }
    const session = [...this.#sessions.values()].find(
      (candidate) =>
        candidate.snapshot.conversationId === input.conversationId &&
        candidate.snapshot.state !== "closed",
    );
    const token = session?.token ?? this.#providerTokens.get(input.conversationId) ?? randomUUID();
    this.#providerTokens.set(input.conversationId, token);
    return {
      name: BROWSER_MCP_NAME,
      command: input.command,
      args: [input.script],
      environment: electronMcpEnvironment(
        {
          ALDUNIS_BROWSER_TOOL_URL: url.toString(),
          ALDUNIS_BROWSER_CONVERSATION_ID: input.conversationId,
          ALDUNIS_BROWSER_TOKEN: token,
        },
        // Empty string forces non-Electron mode in tests; omit to use the host.
        "electronVersion" in input ? input.electronVersion : process.versions.electron,
      ),
    };
  }

  async executeProvider(
    conversationIdInput: unknown,
    tokenInput: unknown,
    operationInput: unknown,
  ): Promise<BrowserHostResult> {
    const conversationId = boundedString(conversationIdInput, 200, "Conversation ID");
    const token = boundedString(tokenInput, 200, "Browser token");
    const session = [...this.#sessions.values()].find(
      (candidate) =>
        candidate.snapshot.conversationId === conversationId &&
        candidate.snapshot.state !== "closed",
    );
    if (!session || !safeTokenEqual(session.token, token)) {
      throw new BrowserError(
        "The browser authorization is invalid.",
        403,
        "browser_authorization_denied",
      );
    }
    const operation = normalizeOperation(operationInput);
    if (
      operation.kind === "navigate" &&
      new URL(operation.url).origin !== new URL(session.snapshot.origin).origin
    ) {
      throw new BrowserError(
        "Shared browser navigation is limited to the approved preview origin.",
        403,
        "browser_origin_denied",
      );
    }
    const refreshed = await this.#refresh(session);
    if (refreshed.state === "closed") throw new BrowserError("The browser session is closed.", 409);
    if (!this.host) {
      return {
        ok: false,
        code: "browser_unavailable",
        message: "The shared browser is available in the desktop application only.",
      };
    }
    const hostState = await this.host.getState(session.snapshot.id);
    if (!hostState.connected) {
      return {
        ok: false,
        code: "browser_view_unavailable",
        message: "Open the shared browser view before using browser tools.",
      };
    }
    if (isMutation(operation) && !refreshed.agentControl) {
      return {
        ok: false,
        code: "browser_control_disabled",
        message: "The operator has not enabled agent control for this shared browser session.",
      };
    }
    if (isMutation(operation) && hostState.controller === "human") {
      return {
        ok: false,
        code: "browser_human_control",
        message:
          "The operator currently controls the shared browser. Enable agent control again before continuing.",
      };
    }
    const result = await this.host.execute(session.snapshot.id, operation, hostState.controlEpoch);
    if (result.ok) {
      session.snapshot.controller =
        operation.kind === "status" || operation.kind === "snapshot"
          ? hostState.controller
          : "agent";
      session.snapshot.updatedAt = new Date().toISOString();
    }
    return result;
  }

  #get(idInput: unknown) {
    const id = boundedString(idInput, 100, "Browser session ID");
    const session = this.#sessions.get(id);
    if (!session || session.snapshot.state === "closed") {
      throw new BrowserError("The browser session does not exist.", 404, "browser_session_missing");
    }
    return session;
  }

  async #refresh(session: {
    snapshot: BrowserSessionSnapshot;
    token: string;
  }): Promise<BrowserSessionSnapshot> {
    if (!this.host) return { ...session.snapshot };
    const state = await this.host.getState(session.snapshot.id);
    session.snapshot.state = state.error ? "failed" : state.connected ? "ready" : "awaiting_view";
    session.snapshot.url = state.url;
    session.snapshot.title = state.title;
    session.snapshot.controller = state.controller;
    session.snapshot.error = state.error;
    session.snapshot.updatedAt = new Date().toISOString();
    return { ...session.snapshot };
  }

  #assertContext(
    snapshot: BrowserSessionSnapshot,
    context: { conversationId: string; origin: string },
  ): void {
    if (
      snapshot.conversationId !== context.conversationId ||
      snapshot.origin !== assertBrowserUrl(context.origin)
    ) {
      throw new BrowserError(
        "The browser session is bound to a different conversation or origin.",
        403,
      );
    }
  }
}

export function normalizeBrowserOperation(value: unknown): BrowserOperation {
  return normalizeOperation(value);
}
