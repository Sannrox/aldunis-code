import { createHash } from "node:crypto";

/**
 * Local autonomy records are intentionally metadata-only. They may describe
 * work and findings, but they never contain credentials, provider transcripts,
 * raw tool traffic, or source contents.
 */
export const AUTONOMY_SCHEMA_VERSION = 2 as const;
export const NIGHTLY_GARDENER_FLOW_ID = "maintenance-gardener.v1" as const;
export const HEARTBEAT_AWARENESS_FLOW_ID = "heartbeat-awareness.v1" as const;
export const MIN_HEARTBEAT_SECONDS = 60;
export const MAX_HEARTBEAT_SECONDS = 7 * 24 * 60 * 60;

export type AutonomyRunKind = "heartbeat" | "maintenance" | "workflow";
export type AutonomyRunStatus =
  "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";
export type AutonomyTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";
export type AutonomyTrigger = "manual" | "heartbeat" | "hook" | "schedule" | "resume";
export type AutonomyStepKind =
  "preflight" | "scan_repository" | "rank_findings" | "report" | "approval_gate" | "notify";
export type AutonomyHookEvent =
  "heartbeat_tick" | "turn_completed" | "turn_failed" | "automation_completed" | "task_completed";

export interface AutonomyBudget {
  maxTasks: number;
  maxRuntimeSeconds: number;
  /** Cost is a guardrail for future provider-backed steps; no provider step is enabled here. */
  maxCostUsd: number | null;
}

export interface AutonomyFlowStep {
  id: string;
  kind: AutonomyStepKind;
  title: string;
  timeoutSeconds: number;
  maxAttempts: number;
  backoffSeconds: number;
  /** A true value means the step may only describe an existing approval boundary. */
  approvalRequired: boolean;
}

export interface AutonomyFlow {
  schemaVersion: 2;
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  readOnly: boolean;
  steps: AutonomyFlowStep[];
  budget: AutonomyBudget;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceFinding {
  id: string;
  category: "workspace" | "quality" | "documentation" | "hygiene" | "security";
  severity: "info" | "low" | "medium" | "high";
  path: string | null;
  summary: string;
  risk: string;
  suggestedAction: string;
}

export interface AutonomyRunResult {
  summary: string;
  findings: MaintenanceFinding[];
  filesScanned: number;
  changedFiles: number;
  durationMs: number;
  /** A digest lets the UI detect a changed report without retaining source text. */
  digest: string;
}

export interface AutonomyRun {
  schemaVersion: 2;
  id: string;
  flowId: string;
  kind: AutonomyRunKind;
  name: string;
  projectId: string | null;
  worktree: string | null;
  trigger: AutonomyTrigger;
  status: AutonomyRunStatus;
  goal: string;
  revision: number;
  currentStepId: string | null;
  taskIds: string[];
  standingOrderIds: string[];
  budget: AutonomyBudget;
  result: AutonomyRunResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export type AutonomyTaskOutput =
  | { kind: "preflight"; repositoryPresent: boolean; changedFiles: number; detail: string }
  | { kind: "scan_repository"; filesScanned: number; findings: MaintenanceFinding[] }
  | { kind: "rank_findings"; findings: MaintenanceFinding[] }
  | { kind: "report"; result: AutonomyRunResult }
  | { kind: "approval_gate"; state: "not_needed" | "waiting"; detail: string }
  | { kind: "notify"; detail: string };

export interface AutonomyTask {
  schemaVersion: 2;
  id: string;
  runId: string;
  stepId: string;
  kind: AutonomyStepKind;
  title: string;
  status: AutonomyTaskStatus;
  attempt: number;
  maxAttempts: number;
  timeoutSeconds: number;
  input: Record<string, string | number | boolean | null>;
  output: AutonomyTaskOutput | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  nextRunAt: string | null;
}

export interface HeartbeatActiveHours {
  start: string;
  end: string;
}

export interface HeartbeatMonitor {
  schemaVersion: 2;
  id: string;
  name: string;
  flowId: string;
  projectId: string | null;
  worktree: string | null;
  goal: string;
  enabled: boolean;
  everySeconds: number;
  activeHours: HeartbeatActiveHours | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: AutonomyRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface StandingOrder {
  schemaVersion: 2;
  id: string;
  name: string;
  scope: "global" | "project";
  projectId: string | null;
  instruction: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyHook {
  schemaVersion: 2;
  id: string;
  name: string;
  event: AutonomyHookEvent;
  flowId: string;
  projectId: string | null;
  enabled: boolean;
  cooldownSeconds: number;
  lastTriggeredAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export class AutonomyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function text(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") throw new AutonomyError(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new AutonomyError(`${label} is required.`);
  if (trimmed.length > max) throw new AutonomyError(`${label} is too long.`);
  return trimmed;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AutonomyError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function nullableText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return text(value, label, max, false) || null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutonomyError(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function status<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AutonomyError(`${label} is invalid.`);
  }
  return value as T;
}

const runStatuses = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const;
const taskStatuses = [
  "queued",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "lost",
] as const;
const runKinds = ["heartbeat", "maintenance", "workflow"] as const;
const triggers = ["manual", "heartbeat", "hook", "schedule", "resume"] as const;
const stepKinds = [
  "preflight",
  "scan_repository",
  "rank_findings",
  "report",
  "approval_gate",
  "notify",
] as const;
const hookEvents = [
  "heartbeat_tick",
  "turn_completed",
  "turn_failed",
  "automation_completed",
  "task_completed",
] as const;

export function normalizeBudget(value: unknown): AutonomyBudget {
  const input = record(value, "Workflow budget");
  const maxCostUsd =
    input.maxCostUsd === null || input.maxCostUsd === undefined ? null : input.maxCostUsd;
  if (
    maxCostUsd !== null &&
    (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)
  ) {
    throw new AutonomyError("Workflow cost limit is invalid.");
  }
  return {
    maxTasks: integer(input.maxTasks, "Workflow task limit", 1, 100),
    maxRuntimeSeconds: integer(input.maxRuntimeSeconds, "Workflow runtime limit", 1, 86_400),
    maxCostUsd: maxCostUsd === null ? null : Math.round(maxCostUsd * 100) / 100,
  };
}

export function parseAutonomyFlow(value: unknown): AutonomyFlow {
  const input = record(value, "Workflow");
  const stepsRaw = input.steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0 || stepsRaw.length > 20) {
    throw new AutonomyError("Workflow steps are invalid.");
  }
  const steps = stepsRaw.map((raw) => {
    const step = record(raw, "Workflow step");
    return {
      id: text(step.id, "Workflow step id", 80),
      kind: status(step.kind, stepKinds, "Workflow step kind"),
      title: text(step.title, "Workflow step title", 160),
      timeoutSeconds: integer(step.timeoutSeconds, "Workflow step timeout", 1, 86_400),
      maxAttempts: integer(step.maxAttempts, "Workflow step retry limit", 1, 10),
      backoffSeconds: integer(step.backoffSeconds, "Workflow step backoff", 0, 86_400),
      approvalRequired: step.approvalRequired === true,
    } satisfies AutonomyFlowStep;
  });
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new AutonomyError("Workflow step ids must be unique.");
    ids.add(step.id);
  }
  const budget = normalizeBudget(input.budget);
  if (steps.length > budget.maxTasks)
    throw new AutonomyError("Workflow steps exceed the task budget.");
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Workflow id", 120),
    name: text(input.name, "Workflow name", 120),
    description: text(input.description, "Workflow description", 500),
    version: integer(input.version, "Workflow version", 1, 1000),
    enabled: input.enabled === true,
    readOnly: input.readOnly === true,
    steps,
    budget,
    createdAt: text(input.createdAt, "Workflow createdAt", 64),
    updatedAt: text(input.updatedAt, "Workflow updatedAt", 64),
  };
}

function parseFinding(value: unknown): MaintenanceFinding {
  const input = record(value, "Maintenance finding");
  return {
    id: text(input.id, "Finding id", 120),
    category: status(
      input.category,
      ["workspace", "quality", "documentation", "hygiene", "security"] as const,
      "Finding category",
    ),
    severity: status(
      input.severity,
      ["info", "low", "medium", "high"] as const,
      "Finding severity",
    ),
    path: nullableText(input.path, "Finding path", 400),
    summary: text(input.summary, "Finding summary", 300),
    risk: text(input.risk, "Finding risk", 300),
    suggestedAction: text(input.suggestedAction, "Finding action", 300),
  };
}

function parseResult(value: unknown): AutonomyRunResult | null {
  if (value === null || value === undefined) return null;
  const input = record(value, "Run result");
  const findingsRaw = input.findings;
  if (!Array.isArray(findingsRaw) || findingsRaw.length > 100)
    throw new AutonomyError("Run findings are invalid.");
  return {
    summary: text(input.summary, "Run summary", 500),
    findings: findingsRaw.map(parseFinding),
    filesScanned: integer(input.filesScanned, "Scanned file count", 0, 100_000),
    changedFiles: integer(input.changedFiles, "Changed file count", 0, 100_000),
    durationMs: integer(input.durationMs, "Run duration", 0, 86_400_000),
    digest: text(input.digest, "Run digest", 128),
  };
}

export function parseAutonomyRun(value: unknown): AutonomyRun {
  const input = record(value, "Autonomy run");
  const taskIds = input.taskIds;
  const standingOrderIds = input.standingOrderIds;
  if (
    !Array.isArray(taskIds) ||
    taskIds.some((item) => typeof item !== "string") ||
    taskIds.length > 100
  ) {
    throw new AutonomyError("Run task ids are invalid.");
  }
  if (
    !Array.isArray(standingOrderIds) ||
    standingOrderIds.some((item) => typeof item !== "string") ||
    standingOrderIds.length > 100
  ) {
    throw new AutonomyError("Run standing order ids are invalid.");
  }
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Run id", 120),
    flowId: text(input.flowId, "Run workflow id", 120),
    kind: status(input.kind, runKinds, "Run kind"),
    name: text(input.name, "Run name", 160),
    projectId: nullableText(input.projectId, "Run project id", 120),
    worktree: nullableText(input.worktree, "Run worktree", 1000),
    trigger: status(input.trigger, triggers, "Run trigger"),
    status: status(input.status, runStatuses, "Run status"),
    goal: text(input.goal, "Run goal", 1000),
    revision: integer(input.revision, "Run revision", 0, 1_000_000),
    currentStepId: nullableText(input.currentStepId, "Run current step", 120),
    taskIds: taskIds as string[],
    standingOrderIds: standingOrderIds as string[],
    budget: normalizeBudget(input.budget),
    result: parseResult(input.result),
    error: nullableText(input.error, "Run error", 500),
    createdAt: text(input.createdAt, "Run createdAt", 64),
    startedAt: nullableText(input.startedAt, "Run startedAt", 64),
    updatedAt: text(input.updatedAt, "Run updatedAt", 64),
    completedAt: nullableText(input.completedAt, "Run completedAt", 64),
  };
}

export function parseAutonomyTask(value: unknown): AutonomyTask {
  const input = record(value, "Autonomy task");
  const taskInput = record(input.input, "Task input");
  if (Object.keys(taskInput).length > 30) throw new AutonomyError("Task input is too large.");
  for (const item of Object.values(taskInput)) {
    if (
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number" &&
      typeof item !== "boolean"
    ) {
      throw new AutonomyError("Task input contains unsupported data.");
    }
  }
  const output = input.output;
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Task id", 120),
    runId: text(input.runId, "Task run id", 120),
    stepId: text(input.stepId, "Task step id", 120),
    kind: status(input.kind, stepKinds, "Task kind"),
    title: text(input.title, "Task title", 160),
    status: status(input.status, taskStatuses, "Task status"),
    attempt: integer(input.attempt, "Task attempt", 0, 10),
    maxAttempts: integer(input.maxAttempts, "Task retry limit", 1, 10),
    timeoutSeconds: integer(input.timeoutSeconds, "Task timeout", 1, 86_400),
    input: taskInput as AutonomyTask["input"],
    output: output === null || output === undefined ? null : (output as AutonomyTaskOutput),
    error: nullableText(input.error, "Task error", 500),
    createdAt: text(input.createdAt, "Task createdAt", 64),
    startedAt: nullableText(input.startedAt, "Task startedAt", 64),
    updatedAt: text(input.updatedAt, "Task updatedAt", 64),
    completedAt: nullableText(input.completedAt, "Task completedAt", 64),
    nextRunAt: nullableText(input.nextRunAt, "Task nextRunAt", 64),
  };
}

function parseActiveHours(value: unknown): HeartbeatActiveHours | null {
  if (value === null || value === undefined) return null;
  const input = record(value, "Heartbeat active hours");
  const start = text(input.start, "Heartbeat start", 5);
  const end = text(input.end, "Heartbeat end", 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    throw new AutonomyError("Heartbeat active hours must use HH:MM.");
  }
  return { start, end };
}

export function parseHeartbeatMonitor(value: unknown): HeartbeatMonitor {
  const input = record(value, "Heartbeat monitor");
  const flowId = text(input.flowId ?? HEARTBEAT_AWARENESS_FLOW_ID, "Heartbeat workflow id", 120);
  if (flowId !== HEARTBEAT_AWARENESS_FLOW_ID && flowId !== NIGHTLY_GARDENER_FLOW_ID) {
    throw new AutonomyError("Heartbeat workflow must be a built-in read-only workflow.");
  }
  const lastStatus =
    input.lastStatus === null || input.lastStatus === undefined
      ? null
      : status(input.lastStatus, runStatuses, "Heartbeat last status");
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Heartbeat id", 120),
    name: text(input.name, "Heartbeat name", 120),
    flowId,
    projectId: nullableText(input.projectId, "Heartbeat project id", 120),
    worktree: nullableText(input.worktree, "Heartbeat worktree", 1000),
    goal: text(input.goal, "Heartbeat goal", 500),
    enabled: input.enabled === true,
    everySeconds: integer(
      input.everySeconds,
      "Heartbeat interval",
      MIN_HEARTBEAT_SECONDS,
      MAX_HEARTBEAT_SECONDS,
    ),
    activeHours: parseActiveHours(input.activeHours),
    lastRunAt: nullableText(input.lastRunAt, "Heartbeat last run", 64),
    lastRunId: nullableText(input.lastRunId, "Heartbeat last run id", 120),
    lastStatus,
    createdAt: text(input.createdAt, "Heartbeat createdAt", 64),
    updatedAt: text(input.updatedAt, "Heartbeat updatedAt", 64),
  };
}

export function parseStandingOrder(value: unknown): StandingOrder {
  const input = record(value, "Standing order");
  const scope = status(input.scope, ["global", "project"] as const, "Standing order scope");
  const projectId = nullableText(input.projectId, "Standing order project id", 120);
  if (scope === "project" && !projectId)
    throw new AutonomyError("Project standing orders need a project.");
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Standing order id", 120),
    name: text(input.name, "Standing order name", 120),
    scope,
    projectId: scope === "global" ? null : projectId,
    instruction: text(input.instruction, "Standing order instruction", 4000),
    enabled: input.enabled === true,
    createdAt: text(input.createdAt, "Standing order createdAt", 64),
    updatedAt: text(input.updatedAt, "Standing order updatedAt", 64),
  };
}

export function parseAutonomyHook(value: unknown): AutonomyHook {
  const input = record(value, "Autonomy hook");
  return {
    schemaVersion: AUTONOMY_SCHEMA_VERSION,
    id: text(input.id, "Hook id", 120),
    name: text(input.name, "Hook name", 120),
    event: status(input.event, hookEvents, "Hook event"),
    flowId: text(input.flowId, "Hook workflow id", 120),
    projectId: nullableText(input.projectId, "Hook project id", 120),
    enabled: input.enabled === true,
    cooldownSeconds: integer(input.cooldownSeconds, "Hook cooldown", 0, 86_400),
    lastTriggeredAt: nullableText(input.lastTriggeredAt, "Hook last trigger", 64),
    lastRunId: nullableText(input.lastRunId, "Hook last run id", 120),
    createdAt: text(input.createdAt, "Hook createdAt", 64),
    updatedAt: text(input.updatedAt, "Hook updatedAt", 64),
  };
}

function step(
  id: string,
  kind: AutonomyStepKind,
  title: string,
  options: Partial<
    Pick<AutonomyFlowStep, "timeoutSeconds" | "maxAttempts" | "backoffSeconds" | "approvalRequired">
  > = {},
): AutonomyFlowStep {
  return {
    id,
    kind,
    title,
    timeoutSeconds: options.timeoutSeconds ?? 30,
    maxAttempts: options.maxAttempts ?? 2,
    backoffSeconds: options.backoffSeconds ?? 5,
    approvalRequired: options.approvalRequired ?? false,
  };
}

export function builtInAutonomyFlows(now = new Date().toISOString()): AutonomyFlow[] {
  return [
    {
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: NIGHTLY_GARDENER_FLOW_ID,
      name: "Nightly maintenance gardener",
      description:
        "Inspect a repository, rank bounded maintenance findings, and produce an operator report.",
      version: 1,
      enabled: true,
      readOnly: true,
      steps: [
        step("preflight", "preflight", "Check repository availability"),
        step("scan", "scan_repository", "Scan bounded repository signals", { timeoutSeconds: 90 }),
        step("rank", "rank_findings", "Rank findings by maintenance value"),
        step("report", "report", "Write an operator report"),
        step("approval", "approval_gate", "Mark any follow-up for existing approval flow", {
          approvalRequired: true,
        }),
      ],
      budget: { maxTasks: 8, maxRuntimeSeconds: 180, maxCostUsd: 0 },
      createdAt: now,
      updatedAt: now,
    },
    {
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: HEARTBEAT_AWARENESS_FLOW_ID,
      name: "Heartbeat awareness",
      description:
        "Record a periodic awareness check without starting a provider turn or mutation.",
      version: 1,
      enabled: true,
      readOnly: true,
      steps: [
        step("preflight", "preflight", "Check repository availability"),
        step("report", "report", "Record heartbeat status"),
      ],
      budget: { maxTasks: 4, maxRuntimeSeconds: 60, maxCostUsd: 0 },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function digestAutonomyResult(result: Omit<AutonomyRunResult, "digest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        summary: result.summary,
        findings: result.findings,
        filesScanned: result.filesScanned,
        changedFiles: result.changedFiles,
      }),
      "utf8",
    )
    .digest("hex");
}

export function isWithinActiveHours(
  activeHours: HeartbeatActiveHours | null,
  date = new Date(),
): boolean {
  if (!activeHours) return true;
  const current = date.getHours() * 60 + date.getMinutes();
  const parse = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(activeHours.start);
  const end = parse(activeHours.end);
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function isHeartbeatDue(monitor: HeartbeatMonitor, now = new Date()): boolean {
  if (!monitor.enabled || !isWithinActiveHours(monitor.activeHours, now)) return false;
  if (!monitor.lastRunAt) return true;
  const last = Date.parse(monitor.lastRunAt);
  return !Number.isFinite(last) || now.getTime() >= last + monitor.everySeconds * 1000;
}

export function summarizeFindings(findings: MaintenanceFinding[]): string {
  if (findings.length === 0) return "No bounded maintenance findings were detected.";
  const high = findings.filter((finding) => finding.severity === "high").length;
  const medium = findings.filter((finding) => finding.severity === "medium").length;
  return `${findings.length} finding${findings.length === 1 ? "" : "s"} recorded${high ? `, ${high} high` : ""}${medium ? `, ${medium} medium` : ""}.`;
}
