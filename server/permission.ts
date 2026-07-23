import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export type ApprovalState =
  | "pending"
  | "allowed_once"
  | "denied"
  | "cancelled"
  | "expired"
  | "provider_failed";

export interface ApprovalScope {
  summary: string;
  target: string;
  details: string[];
}

export interface ApprovalSnapshot {
  id: string;
  runId: string;
  conversationId: string;
  repository: string;
  worktree: string;
  provider: string;
  toolCallId: string;
  toolName: string;
  scope: ApprovalScope;
  state: ApprovalState;
  expiresAt: string;
}

interface PendingApproval extends ApprovalSnapshot {
  inputDigest: string;
  originalInput: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
  decision: Promise<PermissionDecision>;
  timer: NodeJS.Timeout;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

const MUTATING_TOOLS = new Set([
  "Bash",
  "Delete",
  "Edit",
  "Move",
  "MultiEdit",
  "NotebookEdit",
  "ProviderAction",
  "Write",
]);

const SECRET_KEYS = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const CONTENT_KEYS = /(?:content|new_string|old_string|patch|replacement)/i;
const MAX_DETAIL_LENGTH = 180;
export const MAX_APPROVAL_PATHS = 50;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function displayValue(key: string, value: unknown): string | null {
  if (SECRET_KEYS.test(key)) return "[redacted]";
  if (CONTENT_KEYS.test(key)) return "[content redacted]";
  if (typeof value === "string") {
    const compact = value
      .replace(/\b(?:sk-ant-|sk-)[a-zA-Z0-9_-]+\b/g, "[redacted]")
      .replace(/\b((?:password|secret|token|api[_-]?key)\s*=\s*)[^\s]+/gi, "$1[redacted]")
      .replace(/\s+/g, " ")
      .trim();
    return compact.length > MAX_DETAIL_LENGTH
      ? `${compact.slice(0, MAX_DETAIL_LENGTH)}…`
      : compact;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return "{…}";
  return null;
}

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

export function describeMutation(toolName: string, inputValue: unknown): ApprovalScope {
  const input = record(inputValue);
  const targetKeys = ["file_path", "path", "notebook_path", "command", "host", "title"];
  const targetEntry = targetKeys
    .map((key) => [key, displayValue(key, input[key])] as const)
    .find(([, value]) => value);
  const paths = Array.isArray(input.paths)
    ? [
      ...input.paths.slice(0, MAX_APPROVAL_PATHS)
        .map((path) => `path: ${displayValue("path", path) ?? "[hidden]"}`),
      ...(input.paths.length > MAX_APPROVAL_PATHS
        ? [`paths omitted: ${input.paths.length - MAX_APPROVAL_PATHS}`]
        : []),
    ]
    : [];
  const details = [
    ...paths,
    ...Object.entries(input)
      .filter(([key]) => !targetKeys.includes(key) && key !== "paths")
      .slice(0, 4)
      .map(([key, value]) => `${key}: ${displayValue(key, value) ?? "[hidden]"}`),
  ];
  const summaries: Record<string, string> = {
    Bash: "Run a command",
    Delete: "Delete a path",
    Edit: "Edit a file",
    Move: "Move a path",
    MultiEdit: "Edit files",
    NotebookEdit: "Edit a notebook",
    Write: "Write a file",
    ProviderAction: "Run a provider action",
  };
  return {
    summary: toolName === "Bash" && typeof input.host === "string"
      ? "Allow network access"
      : summaries[toolName] ?? `Run ${toolName}`,
    target: targetEntry ? `${targetEntry[0]}: ${targetEntry[1]}` : "Target provided by Claude Code",
    details,
  };
}

export class PermissionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class PermissionBroker {
  readonly #approvals = new Map<string, PendingApproval>();
  readonly #tokens = new Map<string, string>();
  readonly #resolving = new Set<string>();

  constructor(private readonly timeoutMs = 5 * 60_000) {}

  createRunToken(runId: string): string {
    const token = randomUUID();
    this.#tokens.set(runId, token);
    return token;
  }

  register(input: {
    runId: string;
    conversationId: string;
    repository: string;
    worktree: string;
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
    provider?: string;
  }): ApprovalSnapshot | null {
    if (!isMutatingTool(input.toolName)) return null;
    const id = randomUUID();
    let resolve!: (decision: PermissionDecision) => void;
    const decision = new Promise<PermissionDecision>((complete) => {
      resolve = complete;
    });
    const approval: PendingApproval = {
      id,
      runId: input.runId,
      conversationId: input.conversationId,
      repository: input.repository,
      worktree: input.worktree,
      provider: input.provider ?? "Claude Code",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      scope: describeMutation(input.toolName, input.toolInput),
      state: "pending",
      inputDigest: digest(input.toolInput),
      originalInput: record(input.toolInput),
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      decision,
      resolve,
      timer: setTimeout(() => this.#finish(approval, "expired"), this.timeoutMs),
    };
    approval.timer.unref();
    this.#approvals.set(id, approval);
    return this.#snapshot(approval);
  }

  async awaitDecision(
    runId: string,
    token: string,
    toolName: string,
    toolInput: unknown,
  ): Promise<PermissionDecision> {
    this.#assertToken(runId, token);
    const inputDigest = digest(toolInput);
    let approval: PendingApproval | undefined;
    for (let attempt = 0; attempt < 200 && !approval; attempt += 1) {
      approval = [...this.#approvals.values()].find((candidate) => (
        candidate.runId === runId
        && candidate.toolName === toolName
        && candidate.inputDigest === inputDigest
        && candidate.state === "pending"
      ));
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!approval) {
      return { behavior: "deny", message: "Aldunis Code rejected an unmatched permission request." };
    }
    return approval.decision;
  }

  async awaitRegisteredDecision(
    runId: string,
    token: string,
    approvalId: string,
  ): Promise<PermissionDecision> {
    this.#assertToken(runId, token);
    const approval = this.#approvals.get(approvalId);
    if (!approval || approval.runId !== runId) {
      return { behavior: "deny", message: "Aldunis Code rejected an unmatched permission request." };
    }
    return approval.decision;
  }

  decide(
    id: string,
    context: {
      runId: string;
      conversationId: string;
      repository: string;
      worktree: string;
      toolCallId: string;
    },
    decision: "allow_once" | "deny",
  ): ApprovalSnapshot {
    const approval = this.#approvals.get(id);
    if (!approval) throw new PermissionError("The approval request does not exist.", 404);
    if (
      approval.runId !== context.runId
      || approval.conversationId !== context.conversationId
      || approval.repository !== context.repository
      || approval.worktree !== context.worktree
      || approval.toolCallId !== context.toolCallId
    ) {
      throw new PermissionError("The approval request is bound to a different context.", 403);
    }
    if (approval.state !== "pending") {
      throw new PermissionError("The approval request has already been resolved.", 409);
    }
    this.#finish(approval, decision === "allow_once" ? "allowed_once" : "denied");
    return this.#snapshot(approval);
  }

  async decideAfter(
    id: string,
    context: {
      runId: string;
      conversationId: string;
      repository: string;
      worktree: string;
      toolCallId: string;
    },
    decision: "allow_once" | "deny",
    beforeResolve: (snapshot: ApprovalSnapshot) => Promise<void>,
  ): Promise<ApprovalSnapshot> {
    const approval = this.#approvals.get(id);
    if (!approval) throw new PermissionError("The approval request does not exist.", 404);
    if (
      approval.runId !== context.runId
      || approval.conversationId !== context.conversationId
      || approval.repository !== context.repository
      || approval.worktree !== context.worktree
      || approval.toolCallId !== context.toolCallId
    ) {
      throw new PermissionError("The approval request is bound to a different context.", 403);
    }
    if (approval.state !== "pending" || this.#resolving.has(id)) {
      throw new PermissionError("The approval request has already been resolved.", 409);
    }
    this.#resolving.add(id);
    const nextState = decision === "allow_once" ? "allowed_once" : "denied";
    approval.state = nextState;
    clearTimeout(approval.timer);
    try {
      await beforeResolve(this.#snapshot(approval));
      if (approval.state !== nextState) {
        throw new PermissionError("The approval request closed before it could be released.", 409);
      }
      if (nextState === "allowed_once") {
        approval.resolve({ behavior: "allow", updatedInput: approval.originalInput });
      } else {
        approval.resolve({ behavior: "deny", message: "The local action was denied." });
      }
      return this.#snapshot(approval);
    } catch (error) {
      if (approval.state === nextState) {
        approval.state = "provider_failed";
        approval.resolve({
          behavior: "deny",
          message: "Aldunis Code could not persist the approval decision.",
        });
      }
      throw error;
    } finally {
      this.#resolving.delete(id);
    }
  }

  closeRun(runId: string, state: Extract<ApprovalState, "cancelled" | "provider_failed">): void {
    for (const approval of this.#approvals.values()) {
      if (approval.runId !== runId) continue;
      if (this.#resolving.has(approval.id)) {
        approval.state = state;
        clearTimeout(approval.timer);
        approval.resolve({
          behavior: "deny",
          message: `Aldunis Code closed the approval request (${state.replace("_", " ")}).`,
        });
      } else if (approval.state === "pending") {
        this.#finish(approval, state);
      }
    }
    this.#tokens.delete(runId);
  }

  approvalFor(runId: string, toolCallId: string): ApprovalSnapshot | null {
    const approval = [...this.#approvals.values()].find((candidate) => (
      candidate.runId === runId && candidate.toolCallId === toolCallId
    ));
    return approval ? this.#snapshot(approval) : null;
  }

  approvalsFor(runId: string): ApprovalSnapshot[] {
    return [...this.#approvals.values()]
      .filter((approval) => approval.runId === runId)
      .map((approval) => this.#snapshot(approval));
  }

  #finish(approval: PendingApproval, state: ApprovalState): void {
    if (approval.state !== "pending") return;
    approval.state = state;
    clearTimeout(approval.timer);
    if (state === "allowed_once") {
      approval.resolve({ behavior: "allow", updatedInput: approval.originalInput });
    } else {
      approval.resolve({
        behavior: "deny",
        message: state === "denied"
          ? "The user denied this action."
          : `Aldunis Code closed the approval request (${state.replace("_", " ")}).`,
      });
    }
  }

  #assertToken(runId: string, token: string): void {
    const expected = this.#tokens.get(runId);
    const supplied = Buffer.from(token);
    if (
      !expected
      || Buffer.byteLength(expected) !== supplied.length
      || !timingSafeEqual(Buffer.from(expected), supplied)
    ) {
      throw new PermissionError("Invalid provider permission token.", 403);
    }
  }

  #snapshot(approval: PendingApproval): ApprovalSnapshot {
    const {
      inputDigest: _inputDigest,
      originalInput: _originalInput,
      resolve: _resolve,
      decision: _decision,
      timer: _timer,
      ...snapshot
    } = approval;
    return snapshot;
  }
}
