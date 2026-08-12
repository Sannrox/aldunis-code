import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listChangedFiles, type ChangedFile } from "./changes.ts";
import {
  canonicalizeRepositoryRoot,
  discoverWorktrees,
  type WorktreeMetadata,
} from "./repository.ts";
import {
  AutonomyError,
  AUTONOMY_SCHEMA_VERSION,
  builtInAutonomyFlows,
  digestAutonomyResult,
  HEARTBEAT_AWARENESS_FLOW_ID,
  isHeartbeatDue,
  NIGHTLY_GARDENER_FLOW_ID,
  parseAutonomyHook,
  parseHeartbeatMonitor,
  parseStandingOrder,
  summarizeFindings,
  type AutonomyFlow,
  type AutonomyFlowStep,
  type AutonomyHook,
  type AutonomyHookEvent,
  type AutonomyRun,
  type AutonomyRunKind,
  type AutonomyRunResult,
  type AutonomyStepKind,
  type AutonomyTask,
  type AutonomyTaskOutput,
  type AutonomyTrigger,
  type HeartbeatMonitor,
  type MaintenanceFinding,
  type StandingOrder,
} from "./autonomy.ts";
import { LocalStateError, type LocalStateStore, type Project } from "./state.ts";

const execFileAsync = promisify(execFile);
const MAX_SCAN_FILES = 200;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_HOOK_COOLDOWN = 86_400;
const AUTONOMY_CANCELLATION_DRAIN_MS = 1_000;

class NonDrainingAutonomyTimeoutError extends AutonomyError {}

export interface AutonomyStateSnapshot {
  runs: AutonomyRun[];
  tasks: AutonomyTask[];
  flows: AutonomyFlow[];
  heartbeatMonitors: HeartbeatMonitor[];
  standingOrders: StandingOrder[];
  hooks: AutonomyHook[];
}

interface RunStartInput {
  kind: AutonomyRunKind;
  flowId: string;
  name: string;
  projectId: string | null;
  worktree: string | null;
  goal: string;
  trigger: AutonomyTrigger;
  standingOrderIds?: string[];
}

interface ScanContext {
  changedFiles: ChangedFile[];
  trackedFiles: string[];
  filesScanned: number;
  findings: MaintenanceFinding[];
}

function bounded(value: string, max: number, fallback: string): string {
  const trimmed = value.trim();
  return (trimmed || fallback).slice(0, max);
}

function isTerminal(status: AutonomyRun["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isSafeRelativePath(worktree: string, candidate: string): boolean {
  if (!candidate || candidate.includes("\0") || isAbsolute(candidate)) return false;
  const resolved = join(worktree, candidate);
  const fromRoot = relative(worktree, resolved);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function shouldScanPath(path: string): boolean {
  const lower = path.toLocaleLowerCase();
  if (lower.startsWith("node_modules/") || lower.startsWith(".git/")) return false;
  if (/(^|\/)(\.env(?:\.|$)|.*\.(pem|key|p12|pfx|kdbx))$/i.test(path)) return false;
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".yml",
    ".yaml",
    ".toml",
    ".css",
    ".html",
    ".sh",
    ".py",
    ".go",
    ".rs",
  ].includes(extname(lower));
}

function finding(
  category: MaintenanceFinding["category"],
  severity: MaintenanceFinding["severity"],
  path: string | null,
  summary: string,
  risk: string,
  suggestedAction: string,
): MaintenanceFinding {
  const identity = [category, severity, path ?? "", summary].join("\n");
  return {
    id: `finding-${Buffer.from(identity, "utf8").toString("base64url").slice(0, 80)}`,
    category,
    severity,
    path: path ? path.slice(0, 400) : null,
    summary: bounded(summary, 300, "Maintenance finding"),
    risk: bounded(risk, 300, "The maintenance signal may become harder to understand over time."),
    suggestedAction: bounded(
      suggestedAction,
      300,
      "Review this finding in an approved provider turn.",
    ),
  };
}

async function gitTrackedFiles(worktree: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  try {
    const result = await execFileAsync("git", ["-C", worktree, "ls-files", "-z"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    signal?.throwIfAborted();
    return result.stdout.split("\0").filter(Boolean).slice(0, MAX_SCAN_FILES);
  } catch {
    signal?.throwIfAborted();
    throw new AutonomyError("The repository file inventory could not be read.", 409);
  }
}

async function readBoundedText(
  worktree: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!isSafeRelativePath(worktree, path) || !shouldScanPath(path)) return null;
  try {
    const details = await stat(join(worktree, path));
    signal?.throwIfAborted();
    if (!details.isFile() || details.size > MAX_FILE_BYTES) return null;
    const content = await readFile(join(worktree, path), { signal });
    signal?.throwIfAborted();
    const boundedBuffer = content.subarray(0, MAX_FILE_BYTES);
    if (boundedBuffer.includes(0)) return null;
    return boundedBuffer.toString("utf8");
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

function sortFindings(findings: MaintenanceFinding[]): MaintenanceFinding[] {
  const priority: Record<MaintenanceFinding["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
    info: 3,
  };
  return [...findings]
    .sort(
      (left, right) =>
        priority[left.severity] - priority[right.severity] || left.id.localeCompare(right.id),
    )
    .slice(0, 100);
}

export class AutonomyEngine {
  #runTails = new Map<string, Promise<void>>();
  #dispatchKeys = new Set<string>();

  constructor(private readonly state: LocalStateStore) {}

  async ensureBuiltInFlows(): Promise<void> {
    const projection = await this.state.inspect();
    const existing = new Set(projection.autonomyFlows.map((flow) => flow.id));
    const flows = builtInAutonomyFlows().filter((flow) => !existing.has(flow.id));
    if (flows.length) await this.state.saveAutonomyRecords({ flows });
  }

  async hasScheduledWork(): Promise<boolean> {
    const projection = await this.state.inspect();
    return (
      projection.heartbeatMonitors.some((monitor) => monitor.enabled) ||
      projection.autonomyHooks.some((hook) => hook.enabled && hook.event === "heartbeat_tick")
    );
  }

  async snapshot(limit = 50): Promise<AutonomyStateSnapshot> {
    // Public API surface: clone so callers cannot mutate live journaled records.
    const projection = await this.state.load();
    return {
      runs: projection.autonomyRuns
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 200))),
      tasks: projection.autonomyTasks
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 500),
      flows: projection.autonomyFlows
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
      heartbeatMonitors: projection.heartbeatMonitors
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
      standingOrders: projection.standingOrders
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
      hooks: projection.autonomyHooks
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async startGardener(input: {
    projectId: string;
    worktree?: string | null;
    goal?: string;
    trigger?: AutonomyTrigger;
    standingOrderIds?: string[];
  }): Promise<AutonomyRun> {
    return this.startFlow({
      kind: "maintenance",
      flowId: NIGHTLY_GARDENER_FLOW_ID,
      name: "Nightly maintenance gardener",
      projectId: input.projectId,
      worktree: input.worktree ?? null,
      goal: input.goal ?? "Find bounded maintenance work worth an operator review.",
      trigger: input.trigger ?? "manual",
      standingOrderIds: input.standingOrderIds,
    });
  }

  async startHeartbeat(
    monitor: HeartbeatMonitor,
    trigger: AutonomyTrigger = "heartbeat",
  ): Promise<AutonomyRun> {
    return this.startFlow({
      kind: monitor.flowId === NIGHTLY_GARDENER_FLOW_ID ? "maintenance" : "heartbeat",
      flowId: monitor.flowId,
      name: monitor.name,
      projectId: monitor.projectId,
      worktree: monitor.worktree,
      goal: monitor.goal,
      trigger,
    });
  }

  async startFlow(input: RunStartInput): Promise<AutonomyRun> {
    await this.ensureBuiltInFlows();
    // load() isolates nested flow budget/step objects on the returned run.
    const projection = await this.state.load();
    const flow = projection.autonomyFlows.find((candidate) => candidate.id === input.flowId);
    if (!flow || !flow.enabled)
      throw new AutonomyError("The requested autonomy workflow is unavailable.", 404);
    if (!flow.readOnly)
      throw new AutonomyError("Only read-only autonomy workflows are enabled in this host.", 403);
    const resolvedWorktree = await this.resolveWorktree(
      projection.projects,
      input.projectId,
      input.worktree,
    );
    const now = new Date().toISOString();
    const runId = randomUUID();
    const tasks = flow.steps.map((flowStep) =>
      this.newTask(runId, flowStep, now, input.projectId, resolvedWorktree),
    );
    const run: AutonomyRun = {
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: runId,
      flowId: flow.id,
      kind: input.kind,
      name: bounded(input.name, 160, flow.name),
      projectId: input.projectId,
      worktree: resolvedWorktree,
      trigger: input.trigger,
      status: "queued",
      goal: bounded(input.goal, 1000, "Review bounded maintenance signals."),
      revision: 0,
      currentStepId: flow.steps[0]?.id ?? null,
      taskIds: tasks.map((task) => task.id),
      standingOrderIds: (input.standingOrderIds ?? []).slice(0, 100),
      budget: flow.budget,
      result: null,
      error: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
    };
    await this.state.saveAutonomyRecords({ runs: [run], tasks });
    this.#queueRun(run.id);
    return run;
  }

  async resumeRun(runId: string): Promise<AutonomyRun> {
    // Return a clone so the caller cannot mutate the live queued record.
    const run = (await this.state.load()).autonomyRuns.find((candidate) => candidate.id === runId);
    if (!run) throw new AutonomyError("The autonomy run is unavailable.", 404);
    if (run.status !== "queued")
      throw new AutonomyError("The autonomy run is not queued for resumption.", 409);
    this.#queueRun(run.id);
    return run;
  }

  async tickHeartbeats(now = new Date()): Promise<void> {
    await this.ensureBuiltInFlows();
    const projection = await this.state.inspect();
    for (const monitor of projection.heartbeatMonitors) {
      if (!isHeartbeatDue(monitor, now)) continue;
      const existing = monitor.lastRunId
        ? projection.autonomyRuns.find((run) => run.id === monitor.lastRunId)
        : null;
      if (existing && !isTerminal(existing.status)) continue;
      const run = await this.startHeartbeat(monitor);
      await this.state.saveAutonomyRecords({
        heartbeatMonitors: [
          {
            ...monitor,
            lastRunAt: now.toISOString(),
            lastRunId: run.id,
            lastStatus: "queued",
            updatedAt: now.toISOString(),
          },
        ],
      });
    }
  }

  async dispatch(
    event: AutonomyHookEvent,
    projectId: string | null = null,
  ): Promise<AutonomyRun[]> {
    const projection = await this.state.inspect();
    const now = Date.now();
    const started: AutonomyRun[] = [];
    for (const hook of projection.autonomyHooks) {
      if (!hook.enabled || hook.event !== event || (hook.projectId && hook.projectId !== projectId))
        continue;
      if (hook.flowId !== NIGHTLY_GARDENER_FLOW_ID && hook.flowId !== HEARTBEAT_AWARENESS_FLOW_ID)
        continue;
      const last = hook.lastTriggeredAt ? Date.parse(hook.lastTriggeredAt) : Number.NaN;
      if (Number.isFinite(last) && now < last + hook.cooldownSeconds * 1000) continue;
      const key = `${hook.id}:${event}:${projectId ?? "global"}`;
      if (this.#dispatchKeys.has(key)) continue;
      this.#dispatchKeys.add(key);
      try {
        const run =
          hook.flowId === NIGHTLY_GARDENER_FLOW_ID
            ? await this.startGardener({
                projectId: projectId ?? hook.projectId ?? "",
                trigger: "hook",
                goal: `Hook reaction: ${hook.name}`,
              })
            : await this.startFlow({
                kind: "heartbeat",
                flowId: HEARTBEAT_AWARENESS_FLOW_ID,
                name: hook.name,
                projectId: projectId ?? hook.projectId,
                worktree: null,
                goal: `Hook reaction: ${hook.name}`,
                trigger: "hook",
              });
        const updated = {
          ...hook,
          lastTriggeredAt: new Date().toISOString(),
          lastRunId: run.id,
          updatedAt: new Date().toISOString(),
        };
        await this.state.saveAutonomyRecords({ hooks: [updated] });
        started.push(run);
      } catch {
        // Hooks are advisory. A missing project or unavailable worktree must
        // not turn an unrelated event into a failed provider action.
      } finally {
        this.#dispatchKeys.delete(key);
      }
    }
    return started;
  }

  async addHeartbeat(input: {
    name: string;
    projectId?: string | null;
    worktree?: string | null;
    goal: string;
    everySeconds: number;
    flowId?: string;
    activeHours?: HeartbeatMonitor["activeHours"];
  }): Promise<HeartbeatMonitor> {
    await this.ensureBuiltInFlows();
    const now = new Date().toISOString();
    const monitor = parseHeartbeatMonitor({
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: randomUUID(),
      name: input.name,
      flowId: input.flowId ?? HEARTBEAT_AWARENESS_FLOW_ID,
      projectId: input.projectId ?? null,
      worktree: input.worktree ?? null,
      goal: input.goal,
      enabled: true,
      everySeconds: input.everySeconds,
      activeHours: input.activeHours ?? null,
      lastRunAt: null,
      lastRunId: null,
      lastStatus: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.state.saveAutonomyRecords({ heartbeatMonitors: [monitor] });
    return monitor;
  }

  async addStandingOrder(input: {
    name: string;
    scope: StandingOrder["scope"];
    projectId?: string | null;
    instruction: string;
  }): Promise<StandingOrder> {
    await this.ensureBuiltInFlows();
    const now = new Date().toISOString();
    const order = parseStandingOrder({
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: randomUUID(),
      name: input.name,
      scope: input.scope,
      projectId: input.projectId ?? null,
      instruction: input.instruction,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await this.state.saveAutonomyRecords({ standingOrders: [order] });
    return order;
  }

  async addHook(input: {
    name: string;
    event: AutonomyHookEvent;
    flowId: string;
    projectId?: string | null;
    cooldownSeconds?: number;
  }): Promise<AutonomyHook> {
    await this.ensureBuiltInFlows();
    const flow = (await this.state.inspect()).autonomyFlows.find(
      (candidate) => candidate.id === input.flowId,
    );
    if (!flow || !flow.readOnly)
      throw new AutonomyError("Only built-in read-only workflows can be hooked.", 400);
    const now = new Date().toISOString();
    const hook = parseAutonomyHook({
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: randomUUID(),
      name: input.name,
      event: input.event,
      flowId: input.flowId,
      projectId: input.projectId ?? null,
      enabled: true,
      cooldownSeconds: Math.min(
        MAX_HOOK_COOLDOWN,
        Math.max(0, Math.floor(input.cooldownSeconds ?? 300)),
      ),
      lastTriggeredAt: null,
      lastRunId: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.state.saveAutonomyRecords({ hooks: [hook] });
    return hook;
  }

  #queueRun(runId: string): void {
    const previous = this.#runTails.get(runId) ?? Promise.resolve();
    const next = previous.then(
      () => this.#executeRun(runId),
      () => this.#executeRun(runId),
    );
    this.#runTails.set(runId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.#runTails.get(runId) === next) this.#runTails.delete(runId);
      });
  }

  newTask(
    runId: string,
    step: AutonomyFlowStep,
    now: string,
    projectId: string | null,
    worktree: string | null,
  ): AutonomyTask {
    return {
      schemaVersion: AUTONOMY_SCHEMA_VERSION,
      id: randomUUID(),
      runId,
      stepId: step.id,
      kind: step.kind,
      title: step.title,
      status: "queued",
      attempt: 0,
      maxAttempts: step.maxAttempts,
      timeoutSeconds: step.timeoutSeconds,
      input: { projectId, worktree },
      output: null,
      error: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      nextRunAt: null,
    };
  }

  async #executeRun(runId: string): Promise<void> {
    let projection = await this.state.inspect();
    const initialRun = projection.autonomyRuns.find((candidate) => candidate.id === runId);
    if (!initialRun || isTerminal(initialRun.status)) return;
    const flow = projection.autonomyFlows.find((candidate) => candidate.id === initialRun.flowId);
    if (!flow || !flow.enabled || !flow.readOnly) {
      await this.failRun(initialRun, "The workflow is unavailable or not read-only.");
      return;
    }
    let run: AutonomyRun = initialRun;
    const start = Date.now();
    run = {
      ...run,
      status: "running",
      startedAt: run.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: run.revision + 1,
    };
    await this.state.saveAutonomyRecords({ runs: [run] });
    for (const flowStep of flow.steps) {
      if (Date.now() - start >= run.budget.maxRuntimeSeconds * 1000) {
        await this.failRun(run, "The workflow runtime budget was exhausted.");
        return;
      }
      projection = await this.state.inspect();
      const currentRun = projection.autonomyRuns.find((candidate) => candidate.id === runId);
      if (!currentRun || currentRun.status === "cancelled") return;
      run = currentRun;
      if (isTerminal(run.status) && run.status !== "running") return;
      const task = projection.autonomyTasks.find(
        (candidate) => candidate.runId === runId && candidate.stepId === flowStep.id,
      );
      if (!task || task.status === "succeeded") continue;
      const runningTask: AutonomyTask = {
        ...task,
        status: "running",
        attempt: task.attempt + 1,
        startedAt: task.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        nextRunAt: null,
      };
      const runningRun: AutonomyRun = {
        ...run,
        status: "running",
        currentStepId: flowStep.id,
        updatedAt: new Date().toISOString(),
        revision: run.revision + 1,
      };
      await this.state.saveAutonomyRecords({ runs: [runningRun], tasks: [runningTask] });
      let lastError: string | null = null;
      let lastAttempt = runningTask.attempt;
      for (let attempt = runningTask.attempt; attempt <= runningTask.maxAttempts; attempt += 1) {
        lastAttempt = attempt;
        try {
          const output = await this.withTimeout(
            (signal) =>
              this.executeStep(flowStep.kind, runningRun, runningTask, projection, signal),
            flowStep.timeoutSeconds * 1000,
          );
          const completedAt = new Date().toISOString();
          const completedTask: AutonomyTask = {
            ...runningTask,
            status: "succeeded",
            attempt,
            output,
            error: null,
            updatedAt: completedAt,
            completedAt,
          };
          await this.state.saveAutonomyRecords({ tasks: [completedTask] });
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : "Autonomy task failed.";
          if (
            error instanceof NonDrainingAutonomyTimeoutError ||
            attempt >= runningTask.maxAttempts
          )
            break;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(flowStep.backoffSeconds * 1000, 2000)),
          );
        }
      }
      if (lastError) {
        const failedAt = new Date().toISOString();
        await this.state.saveAutonomyRecords({
          tasks: [
            {
              ...runningTask,
              status: "failed",
              attempt: lastAttempt,
              error: bounded(lastError, 500, "Autonomy task failed."),
              updatedAt: failedAt,
              completedAt: failedAt,
            },
          ],
          runs: [
            {
              ...runningRun,
              status: "failed",
              currentStepId: flowStep.id,
              error: bounded(lastError, 500, "Autonomy run failed."),
              updatedAt: failedAt,
              completedAt: failedAt,
              revision: runningRun.revision + 1,
            },
          ],
        });
        await this.updateHeartbeatStatus(runId, "failed");
        return;
      }
    }
    projection = await this.state.inspect();
    const completedRun = projection.autonomyRuns.find((candidate) => candidate.id === runId);
    if (!completedRun || completedRun.status === "cancelled") return;
    run = completedRun;
    const reportTask = projection.autonomyTasks.find(
      (task) => task.runId === runId && task.kind === "report",
    );
    const result = reportTask?.output?.kind === "report" ? reportTask.output.result : null;
    const completedAt = new Date().toISOString();
    const completed: AutonomyRun = {
      ...run,
      status: "succeeded",
      currentStepId: null,
      result: result ?? this.emptyResult(run, Date.now() - start),
      error: null,
      updatedAt: completedAt,
      completedAt,
      revision: run.revision + 1,
    };
    await this.state.saveAutonomyRecords({ runs: [completed] });
    await this.updateHeartbeatStatus(runId, "succeeded");
    if (completed.trigger !== "hook") {
      void this.dispatch("task_completed", completed.projectId).catch(() => undefined);
    }
  }

  async executeStep(
    kind: AutonomyStepKind,
    run: AutonomyRun,
    task: AutonomyTask,
    projection: Awaited<ReturnType<LocalStateStore["load"]>>,
    signal?: AbortSignal,
  ): Promise<AutonomyTaskOutput> {
    signal?.throwIfAborted();
    switch (kind) {
      case "preflight": {
        if (!run.worktree) {
          return {
            kind,
            repositoryPresent: false,
            changedFiles: 0,
            detail: "No repository was selected for this awareness run.",
          };
        }
        const changedFiles = await listChangedFiles(run.worktree, signal);
        return {
          kind,
          repositoryPresent: true,
          changedFiles: changedFiles.length,
          detail: changedFiles.length
            ? `${changedFiles.length} workspace change${changedFiles.length === 1 ? "" : "s"} present; no changes were made.`
            : "The worktree is clean; no changes were made.",
        };
      }
      case "scan_repository": {
        if (!run.worktree) return { kind, filesScanned: 0, findings: [] };
        const context = await this.scanRepository(run.worktree, signal);
        return { kind, filesScanned: context.filesScanned, findings: context.findings };
      }
      case "rank_findings": {
        const scan = projection.autonomyTasks.find(
          (candidate) => candidate.runId === run.id && candidate.kind === "scan_repository",
        );
        const findings = scan?.output?.kind === "scan_repository" ? scan.output.findings : [];
        return { kind, findings: sortFindings(findings) };
      }
      case "report": {
        const preflight = projection.autonomyTasks.find(
          (candidate) => candidate.runId === run.id && candidate.kind === "preflight",
        );
        const scan = projection.autonomyTasks.find(
          (candidate) => candidate.runId === run.id && candidate.kind === "scan_repository",
        );
        const ranked = projection.autonomyTasks.find(
          (candidate) => candidate.runId === run.id && candidate.kind === "rank_findings",
        );
        const findings =
          ranked?.output?.kind === "rank_findings"
            ? ranked.output.findings
            : scan?.output?.kind === "scan_repository"
              ? scan.output.findings
              : [];
        const resultBase: Omit<AutonomyRunResult, "digest"> = {
          summary:
            run.kind === "heartbeat"
              ? "Heartbeat recorded without provider activity."
              : summarizeFindings(findings),
          findings,
          filesScanned: scan?.output?.kind === "scan_repository" ? scan.output.filesScanned : 0,
          changedFiles: preflight?.output?.kind === "preflight" ? preflight.output.changedFiles : 0,
          durationMs: Math.max(0, Date.now() - Date.parse(run.startedAt ?? run.createdAt)),
        };
        const result: AutonomyRunResult = {
          ...resultBase,
          digest: digestAutonomyResult(resultBase),
        };
        return { kind, result };
      }
      case "approval_gate":
        return {
          kind,
          state: "not_needed",
          detail:
            "This workflow is read-only. Any source or provider mutation must use the existing explicit approval flow.",
        };
      case "notify":
        return { kind, detail: "The autonomy result is available in the local run ledger." };
      default:
        return task.output ?? { kind: "notify", detail: "No autonomy action was performed." };
    }
  }

  async scanRepository(worktree: string, signal?: AbortSignal): Promise<ScanContext> {
    signal?.throwIfAborted();
    const changedFiles = await listChangedFiles(worktree, signal);
    const trackedFiles = await gitTrackedFiles(worktree, signal);
    const findings: MaintenanceFinding[] = [];
    if (changedFiles.length > 0) {
      findings.push(
        finding(
          "workspace",
          "info",
          null,
          `${changedFiles.length} workspace change${changedFiles.length === 1 ? "" : "s"} are present before maintenance review.`,
          "An autonomous change could overlap with work that is not part of this run.",
          "Review the diff and use an approved provider turn for any mutation.",
        ),
      );
    }
    const trackedSensitive = trackedFiles.some((path) =>
      /(^|\/)(\.env(?:\.|$)|.*\.(pem|key|p12|pfx))$/i.test(path),
    );
    if (trackedSensitive) {
      findings.push(
        finding(
          "security",
          "high",
          null,
          "A tracked path matches a secret-bearing filename pattern.",
          "Credentials or private material may be exposed to version control.",
          "Inspect tracked secret candidates and rotate or remove them through an approved workflow.",
        ),
      );
    }
    const candidates = [...new Set([...trackedFiles, ...changedFiles.map((item) => item.path)])]
      .filter((path) => shouldScanPath(path))
      .slice(0, MAX_SCAN_FILES);
    let bytes = 0;
    let filesScanned = 0;
    let hasReadme = false;
    let hasDocs = false;
    let hasPackage = false;
    let hasLock = false;
    for (const path of candidates) {
      signal?.throwIfAborted();
      if (path.toLocaleLowerCase() === "package.json") hasPackage = true;
      if (/^readme(?:\.[^.]+)?$/i.test(basename(path))) hasReadme = true;
      if (path.toLocaleLowerCase().startsWith("docs/")) hasDocs = true;
      if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i.test(basename(path)))
        hasLock = true;
      const content = await readBoundedText(worktree, path, signal);
      if (content === null || bytes >= MAX_SCAN_BYTES) continue;
      bytes += Buffer.byteLength(content, "utf8");
      filesScanned += 1;
      const todoCount = (content.match(/\b(?:TODO|FIXME|XXX)\b/gi) ?? []).length;
      if (todoCount > 0) {
        findings.push(
          finding(
            "quality",
            todoCount >= 10 ? "medium" : "low",
            path,
            `${todoCount} maintenance marker${todoCount === 1 ? "" : "s"} found.`,
            "Unowned markers tend to become stale and hide work that needs a decision.",
            "Triage the markers and convert actionable items into an owned task or remove obsolete notes.",
          ),
        );
      }
      if (path.toLocaleLowerCase() === "package.json") {
        try {
          const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
          if (!parsed.scripts || typeof parsed.scripts.test !== "string") {
            findings.push(
              finding(
                "quality",
                "low",
                path,
                "The package manifest does not declare a test script.",
                "Contributors and maintenance runs lack a discoverable verification entry point.",
                "Add or document the project’s deterministic verification command.",
              ),
            );
          }
        } catch {
          findings.push(
            finding(
              "quality",
              "medium",
              path,
              "The package manifest could not be parsed as JSON.",
              "Build and dependency tooling may fail before reaching project code.",
              "Repair the manifest in an approved change and run the repository checks.",
            ),
          );
        }
      }
    }
    if (!hasReadme && !hasDocs) {
      findings.push(
        finding(
          "documentation",
          "low",
          null,
          "No README or docs directory was found in the bounded file inventory.",
          "New contributors may not have a durable starting point for local operation.",
          "Add a concise getting-started document if the repository is intended for collaboration.",
        ),
      );
    }
    if (hasPackage && !hasLock) {
      findings.push(
        finding(
          "hygiene",
          "info",
          "package.json",
          "A package manifest was found without a recognized lockfile.",
          "Dependency resolution may vary between machines or maintenance runs.",
          "Confirm whether the repository intentionally omits a lockfile and document that choice.",
        ),
      );
    }
    return {
      changedFiles,
      trackedFiles,
      filesScanned,
      findings: sortFindings(findings),
    };
  }

  async resolveWorktree(
    projects: Project[],
    projectId: string | null,
    requestedWorktree: string | null,
  ): Promise<string | null> {
    if (!projectId) return null;
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new LocalStateError("The selected project is unavailable.", 404);
    const root = await canonicalizeRepositoryRoot(project.root);
    const candidates: WorktreeMetadata[] = await discoverWorktrees(root);
    const selected = requestedWorktree ?? root;
    const canonicalSelected = await realpath(selected).catch(() => selected);
    const match = candidates.find(
      (candidate) => candidate.path === canonicalSelected || candidate.path === selected,
    );
    if (!match || ["missing", "inaccessible"].includes(match.state)) {
      throw new AutonomyError(
        "The selected worktree is not available for read-only maintenance.",
        409,
      );
    }
    return match.path;
  }

  async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    cancellationDrainMs = AUTONOMY_CANCELLATION_DRAIN_MS,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    const active = Promise.resolve().then(() => operation(controller.signal));
    try {
      const result = await Promise.race([
        active.then(
          (value) => ({ kind: "completed" as const, value }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        new Promise<{ kind: "timed_out" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timed_out" }), timeoutMs);
        }),
      ]);
      if (result.kind === "completed") return result.value;
      if (result.kind === "failed") throw result.error;
      controller.abort();
      let drainTimer: NodeJS.Timeout | null = null;
      const drained = await Promise.race([
        active.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          drainTimer = setTimeout(() => resolve(false), cancellationDrainMs);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      if (!drained) {
        throw new NonDrainingAutonomyTimeoutError(
          "The autonomy step timed out and did not stop after cancellation.",
          408,
        );
      }
      throw new AutonomyError("The autonomy step timed out.", 408);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async failRun(run: AutonomyRun, message: string): Promise<void> {
    const now = new Date().toISOString();
    await this.state.saveAutonomyRecords({
      runs: [
        {
          ...run,
          status: "failed",
          error: bounded(message, 500, "Autonomy run failed."),
          updatedAt: now,
          completedAt: now,
          revision: run.revision + 1,
        },
      ],
    });
    await this.updateHeartbeatStatus(run.id, "failed");
  }

  async updateHeartbeatStatus(runId: string, status: AutonomyRun["status"]): Promise<void> {
    const projection = await this.state.inspect();
    const monitor = projection.heartbeatMonitors.find((candidate) => candidate.lastRunId === runId);
    if (!monitor) return;
    await this.state.saveAutonomyRecords({
      heartbeatMonitors: [{ ...monitor, lastStatus: status, updatedAt: new Date().toISOString() }],
    });
  }

  emptyResult(run: AutonomyRun, durationMs: number): AutonomyRunResult {
    const resultBase: Omit<AutonomyRunResult, "digest"> = {
      summary:
        run.kind === "heartbeat"
          ? "Heartbeat recorded without provider activity."
          : "No bounded findings were recorded.",
      findings: [],
      filesScanned: 0,
      changedFiles: 0,
      durationMs,
    };
    return { ...resultBase, digest: digestAutonomyResult(resultBase) };
  }
}

export class AutonomyScheduler {
  #timer: { unref(): void } | null = null;
  #started = false;
  #running = false;
  #refreshPromise: Promise<void> | null = null;
  #refreshRequested = false;
  #hasScheduledWork = false;

  constructor(
    private readonly engine: AutonomyEngine,
    private readonly options: {
      intervalMs?: number;
      timers?: {
        setTimeout(callback: () => void, delayMs: number): { unref(): void };
        clearTimeout(handle: { unref(): void }): void;
      };
    } = {},
  ) {}

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#wake().catch(() => undefined);
  }

  stop(): void {
    this.#started = false;
    this.#refreshRequested = false;
    this.#clearTimer();
  }

  /** Reconcile timer state after a local mutation without running workflows. */
  refresh(): Promise<void> {
    if (!this.#started) return Promise.resolve();
    this.#refreshRequested = true;
    if (!this.#refreshPromise) {
      const refresh = this.#drainRefresh();
      const tracked = refresh.finally(() => {
        if (this.#refreshPromise === tracked) this.#refreshPromise = null;
      });
      this.#refreshPromise = tracked;
    }
    return this.#refreshPromise;
  }

  #clearTimer(): void {
    if (this.#timer) {
      const clear =
        this.options.timers?.clearTimeout ??
        ((handle: { unref(): void }) => clearTimeout(handle as NodeJS.Timeout));
      clear(this.#timer);
    }
    this.#timer = null;
  }

  #schedule(): void {
    if (!this.#started || !this.#hasScheduledWork || this.#timer) return;
    const schedule =
      this.options.timers?.setTimeout ??
      ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.#timer = schedule(() => {
      this.#timer = null;
      void this.#wake().catch(() => undefined);
    }, this.options.intervalMs ?? 30_000);
    this.#timer.unref();
  }

  async #drainRefresh(): Promise<void> {
    let failed = false;
    try {
      do {
        this.#refreshRequested = false;
        this.#hasScheduledWork = await this.engine.hasScheduledWork();
        if (!this.#hasScheduledWork) this.#clearTimer();
      } while (this.#started && this.#refreshRequested);
    } catch {
      failed = true;
    } finally {
      if (failed) this.#hasScheduledWork = true;
      this.#schedule();
    }
  }

  async #wake(): Promise<void> {
    try {
      await this.tick();
    } finally {
      await this.refresh();
    }
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.engine.tickHeartbeats();
      await this.engine.dispatch("heartbeat_tick");
    } finally {
      this.#running = false;
    }
  }
}
