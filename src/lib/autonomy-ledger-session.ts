export type AutonomyRunStatus =
  "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed" | "cancelled" | "lost";

export type AutonomyHookEvent =
  "heartbeat_tick" | "turn_completed" | "turn_failed" | "automation_completed" | "task_completed";

export interface AutonomyFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high";
  path: string | null;
  summary: string;
  suggestedAction: string;
}

export interface AutonomyLedger {
  runs: Array<{
    id: string;
    flowId: string;
    kind: "heartbeat" | "maintenance" | "workflow";
    name: string;
    projectId: string | null;
    status: AutonomyRunStatus;
    trigger: string;
    goal: string;
    result: {
      summary: string;
      findings: AutonomyFinding[];
      filesScanned: number;
      changedFiles: number;
      durationMs: number;
      digest: string;
    } | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
  }>;
  tasks: Array<{
    id: string;
    runId: string;
    stepId: string;
    title: string;
    status: string;
    attempt: number;
    maxAttempts: number;
    error: string | null;
  }>;
  flows: Array<{
    id: string;
    name: string;
    description: string;
    readOnly: boolean;
    steps: Array<{ id: string; title: string }>;
  }>;
  heartbeatMonitors: Array<{
    id: string;
    name: string;
    flowId: string;
    projectId: string | null;
    worktree: string | null;
    goal: string;
    enabled: boolean;
    everySeconds: number;
    lastStatus: AutonomyRunStatus | null;
    lastRunAt: string | null;
  }>;
  standingOrders: Array<{
    id: string;
    name: string;
    scope: "global" | "project";
    projectId: string | null;
    instruction: string;
    enabled: boolean;
  }>;
  hooks: Array<{
    id: string;
    name: string;
    event: AutonomyHookEvent;
    flowId: string;
    projectId: string | null;
    enabled: boolean;
    cooldownSeconds: number;
  }>;
}

export interface AutonomyLedgerDraft {
  projectId: string;
  worktree: string;
  goal: string;
  heartbeatName: string;
  heartbeatGoal: string;
  heartbeatMinutes: number;
  heartbeatFlowId: string;
  orderName: string;
  orderInstruction: string;
  orderScope: "global" | "project";
  hookName: string;
  hookEvent: AutonomyHookEvent;
  hookFlowId: string;
  hookCooldown: number;
}

export interface AutonomyLedgerSnapshot {
  ledger: AutonomyLedger;
  tab: "runs" | "heartbeats" | "orders" | "hooks";
  draft: AutonomyLedgerDraft;
  busy: boolean;
  error: string | null;
  loadError: string | null;
}

export type AutonomyLedgerCommand =
  | { kind: "start_gardener" }
  | { kind: "cancel_run"; runId: string }
  | { kind: "resume_run"; runId: string }
  | { kind: "create_heartbeat" }
  | { kind: "set_heartbeat_enabled"; id: string; enabled: boolean }
  | { kind: "run_heartbeat"; id: string }
  | { kind: "delete_heartbeat"; id: string }
  | { kind: "create_order" }
  | { kind: "set_order_enabled"; id: string; enabled: boolean }
  | { kind: "delete_order"; id: string }
  | { kind: "create_hook" }
  | { kind: "set_hook_enabled"; id: string; enabled: boolean }
  | { kind: "delete_hook"; id: string };

interface VisibilityAdapter {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

interface TimerAdapter {
  setInterval(handler: () => void, timeout: number): number;
  clearInterval(handle: number): void;
}

export interface AutonomyLedgerSessionAdapters {
  request(path: string, body?: Record<string, unknown>): Promise<unknown>;
  visibility: VisibilityAdapter;
  timers: TimerAdapter;
  managed: boolean;
}

export const AUTONOMY_REFRESH_INTERVAL_MS = 5_000;

const emptyLedger = (): AutonomyLedger => ({
  runs: [],
  tasks: [],
  flows: [],
  heartbeatMonitors: [],
  standingOrders: [],
  hooks: [],
});

const initialDraft = (): AutonomyLedgerDraft => ({
  projectId: "",
  worktree: "",
  goal: "Find bounded maintenance work worth an operator review.",
  heartbeatName: "Nightly awareness",
  heartbeatGoal: "Check for maintenance signals and report them.",
  heartbeatMinutes: 60,
  heartbeatFlowId: "heartbeat-awareness.v1",
  orderName: "Maintenance preference",
  orderInstruction: "",
  orderScope: "project",
  hookName: "After completed turn",
  hookEvent: "turn_completed",
  hookFlowId: "maintenance-gardener.v1",
  hookCooldown: 300,
});

/** Owns Autonomy ledger interaction while the local host retains ledger and execution authority. */
export class AutonomyLedgerSessionModule {
  private snapshot: AutonomyLedgerSnapshot = {
    ledger: emptyLedger(),
    tab: "runs",
    draft: initialDraft(),
    busy: false,
    error: null,
    loadError: null,
  };
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private loadSequence = 0;
  private loadInFlight: Promise<void> | null = null;
  private pollingHandle: number | null = null;
  private readonly onVisibilityChange = () => this.restartPolling();

  constructor(private readonly adapters: AutonomyLedgerSessionAdapters) {}

  getSnapshot = (): AutonomyLedgerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(binding: { projectId?: string; worktree?: string }): void {
    this.active = true;
    this.generation += 1;
    this.update({
      busy: false,
      error: null,
      draft: {
        ...this.snapshot.draft,
        ...(binding.projectId ? { projectId: binding.projectId } : {}),
        ...(binding.worktree ? { worktree: binding.worktree } : {}),
      },
    });
    this.adapters.visibility.addEventListener("visibilitychange", this.onVisibilityChange);
    this.restartPolling();
  }

  close(): void {
    this.active = false;
    this.generation += 1;
    this.loadSequence += 1;
    this.stopPolling();
    this.adapters.visibility.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.loadInFlight = null;
  }

  selectTab(tab: AutonomyLedgerSnapshot["tab"]): void {
    this.update({ tab });
  }

  updateDraft(patch: Partial<AutonomyLedgerDraft>): void {
    this.update({ draft: { ...this.snapshot.draft, ...patch } });
  }

  async refresh(options: { fresh?: boolean } = {}): Promise<void> {
    if (!this.active) return;
    if (options.fresh && this.loadInFlight) await this.loadInFlight;
    if (!options.fresh && this.loadInFlight) return this.loadInFlight;
    const generation = this.generation;
    const sequence = ++this.loadSequence;
    const load = (async () => {
      try {
        const ledger = (await this.adapters.request("/api/autonomy/load")) as AutonomyLedger;
        if (this.isCurrent(generation) && sequence === this.loadSequence) {
          this.update({ ledger, loadError: null });
        }
      } catch {
        if (this.isCurrent(generation) && sequence === this.loadSequence) {
          this.update({ loadError: "Could not load the autonomy ledger." });
        }
      }
    })();
    const wrapped = load.finally(() => {
      if (this.loadInFlight === wrapped) this.loadInFlight = null;
    });
    this.loadInFlight = wrapped;
    return wrapped;
  }

  async command(command: AutonomyLedgerCommand): Promise<void> {
    if (!this.active) return;
    if (this.adapters.managed) {
      this.update({ error: "Managed mode is inspect-only for this local autonomy surface." });
      return;
    }
    const operation = this.resolveCommand(command);
    if (!operation) return;
    const generation = this.generation;
    this.update({ busy: true, error: null });
    try {
      await this.adapters.request(operation.path, operation.body);
      await this.refresh({ fresh: true });
    } catch (cause) {
      if (this.isCurrent(generation)) {
        this.update({
          error: cause instanceof Error ? cause.message : "Autonomy operation failed.",
        });
      }
    } finally {
      if (this.isCurrent(generation)) this.update({ busy: false });
    }
  }

  private resolveCommand(
    command: AutonomyLedgerCommand,
  ): { path: string; body: Record<string, unknown> } | null {
    const draft = this.snapshot.draft;
    switch (command.kind) {
      case "start_gardener":
        if (!draft.projectId) {
          this.update({ error: "Open a repository before starting the gardener." });
          return null;
        }
        return {
          path: "/api/autonomy/gardener/start",
          body: { projectId: draft.projectId, worktree: draft.worktree || null, goal: draft.goal },
        };
      case "cancel_run":
        return { path: "/api/autonomy/runs/cancel", body: { runId: command.runId } };
      case "resume_run":
        return { path: "/api/autonomy/runs/resume", body: { runId: command.runId } };
      case "create_heartbeat":
        return {
          path: "/api/autonomy/heartbeats/create",
          body: {
            name: draft.heartbeatName,
            goal: draft.heartbeatGoal,
            flowId: draft.heartbeatFlowId,
            everySeconds: draft.heartbeatMinutes * 60,
            projectId: draft.projectId || null,
            worktree: draft.worktree || null,
          },
        };
      case "set_heartbeat_enabled":
        return {
          path: "/api/autonomy/heartbeats/update",
          body: { id: command.id, enabled: command.enabled },
        };
      case "run_heartbeat":
        return { path: "/api/autonomy/heartbeats/run-now", body: { id: command.id } };
      case "delete_heartbeat":
        return { path: "/api/autonomy/heartbeats/delete", body: { id: command.id } };
      case "create_order":
        return {
          path: "/api/autonomy/standing-orders/create",
          body: {
            name: draft.orderName,
            scope: draft.orderScope,
            projectId: draft.orderScope === "project" ? draft.projectId : null,
            instruction: draft.orderInstruction,
          },
        };
      case "set_order_enabled":
        return {
          path: "/api/autonomy/standing-orders/update",
          body: { id: command.id, enabled: command.enabled },
        };
      case "delete_order":
        return { path: "/api/autonomy/standing-orders/delete", body: { id: command.id } };
      case "create_hook":
        return {
          path: "/api/autonomy/hooks/create",
          body: {
            name: draft.hookName,
            event: draft.hookEvent,
            flowId: draft.hookFlowId,
            projectId: draft.projectId || null,
            cooldownSeconds: draft.hookCooldown,
          },
        };
      case "set_hook_enabled":
        return {
          path: "/api/autonomy/hooks/update",
          body: { id: command.id, enabled: command.enabled },
        };
      case "delete_hook":
        return { path: "/api/autonomy/hooks/delete", body: { id: command.id } };
    }
  }

  private restartPolling(): void {
    this.stopPolling();
    if (this.adapters.visibility.visibilityState !== "visible") return;
    void this.refresh();
    this.pollingHandle = this.adapters.timers.setInterval(
      () => void this.refresh(),
      AUTONOMY_REFRESH_INTERVAL_MS,
    );
  }

  private stopPolling(): void {
    if (this.pollingHandle !== null) this.adapters.timers.clearInterval(this.pollingHandle);
    this.pollingHandle = null;
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private update(patch: Partial<AutonomyLedgerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function startAutonomyRefreshPolling(
  load: () => void,
  visibility: VisibilityAdapter,
  timers: TimerAdapter = window,
): () => void {
  let refresh: number | undefined;
  const stop = () => {
    if (refresh !== undefined) timers.clearInterval(refresh);
    refresh = undefined;
  };
  const start = () => {
    stop();
    if (visibility.visibilityState !== "visible") return;
    load();
    refresh = timers.setInterval(load, AUTONOMY_REFRESH_INTERVAL_MS);
  };
  const onVisibilityChange = () => start();
  start();
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    stop();
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
