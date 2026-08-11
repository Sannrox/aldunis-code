export type AutomationSchedule =
  { kind: "interval"; seconds: number } | { kind: "cron"; expression: string };

export interface AutomationFireSummary {
  id: string;
  key: string;
  kind: "scheduled" | "manual";
  scheduledAt: string | null;
  requestedAt: string;
  turnId: string | null;
  providerRunId: string | null;
  status: "started" | "completed" | "failed" | "skipped_busy" | "unknown";
  error: string | null;
}

export interface AutomationItem {
  id: string;
  name: string;
  threadId: string;
  prompt: string;
  mode: "ask" | "plan" | "build";
  enabled: boolean;
  schedule: AutomationSchedule;
  lastRunAt: string | null;
  lastStatus: "ok" | "skipped_busy" | "error" | "unknown" | null;
  lastError: string | null;
  lastFire: AutomationFireSummary | null;
}

export interface AutomationDraft {
  name: string;
  threadId: string;
  prompt: string;
  mode: "ask" | "plan" | "build";
  scheduleKind: "interval" | "cron";
  intervalMinutes: number;
  cron: string;
}

export interface AutomationSessionSnapshot {
  items: AutomationItem[];
  draft: AutomationDraft;
  busy: boolean;
  error: string | null;
}

export type AutomationSessionCommand =
  | { kind: "create" }
  | { kind: "set_enabled"; id: string; enabled: boolean }
  | { kind: "run"; id: string; retryOf?: string }
  | { kind: "delete"; id: string };

export interface AutomationSessionAdapters {
  request(path: string, body?: Record<string, unknown>): Promise<unknown>;
  randomUUID(): string;
}

const initialDraft = (): AutomationDraft => ({
  name: "Recurring check",
  threadId: "",
  prompt: "",
  mode: "ask",
  scheduleKind: "interval",
  intervalMinutes: 60,
  cron: "0 * * * *",
});

/** Owns automation interaction while the local host retains schedule and run authority. */
export class ConversationAutomationSessionModule {
  private snapshot: AutomationSessionSnapshot = {
    items: [],
    draft: initialDraft(),
    busy: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private sequence = 0;

  constructor(private readonly adapters: AutomationSessionAdapters) {}

  getSnapshot = (): AutomationSessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(threadIds: string[]): void {
    this.active = true;
    this.generation += 1;
    this.update({
      busy: false,
      error: null,
      draft: {
        ...this.snapshot.draft,
        threadId: this.snapshot.draft.threadId || threadIds[0] || "",
      },
    });
    void this.load();
  }

  close(): void {
    this.active = false;
    this.generation += 1;
    this.sequence += 1;
    this.update({ busy: false });
  }

  updateDraft(patch: Partial<AutomationDraft>): void {
    const intervalMinutes =
      patch.intervalMinutes === undefined
        ? this.snapshot.draft.intervalMinutes
        : Math.min(10_080, Math.max(1, Math.floor(patch.intervalMinutes || 1)));
    this.update({
      draft: { ...this.snapshot.draft, ...patch, intervalMinutes },
    });
  }

  async execute(command: AutomationSessionCommand): Promise<void> {
    if (this.snapshot.busy) return;
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.update({ busy: true, error: null });
    try {
      await this.requestCommand(command);
      if (!this.isCurrent(generation, sequence)) return;
      if (command.kind === "create") {
        this.update({ draft: { ...this.snapshot.draft, prompt: "" } });
      }
      await this.load(generation, sequence);
    } catch (error) {
      if (this.isCurrent(generation, sequence)) {
        this.update({
          error: error instanceof Error ? error.message : "Automation request failed.",
        });
      }
    } finally {
      if (this.isCurrent(generation, sequence)) this.update({ busy: false });
    }
  }

  private async load(generation = this.generation, sequence = ++this.sequence): Promise<void> {
    try {
      const body = (await this.adapters.request("/api/automations/list")) as {
        automations?: AutomationItem[];
      };
      if (this.isCurrent(generation, sequence)) {
        this.update({ items: body.automations ?? [], error: null });
      }
    } catch {
      if (this.isCurrent(generation, sequence))
        this.update({ error: "Could not load automations." });
    }
  }

  private requestCommand(command: AutomationSessionCommand): Promise<unknown> {
    switch (command.kind) {
      case "create": {
        const draft = this.snapshot.draft;
        const schedule: AutomationSchedule =
          draft.scheduleKind === "interval"
            ? { kind: "interval", seconds: draft.intervalMinutes * 60 }
            : { kind: "cron", expression: draft.cron.trim() };
        return this.adapters.request("/api/automations/create", {
          name: draft.name,
          threadId: draft.threadId,
          prompt: draft.prompt,
          mode: draft.mode,
          schedule,
          enabled: true,
        });
      }
      case "set_enabled":
        return this.adapters.request("/api/automations/update", {
          id: command.id,
          enabled: command.enabled,
        });
      case "run":
        return this.adapters.request("/api/automations/run-now", {
          id: command.id,
          idempotencyKey: this.adapters.randomUUID(),
          ...(command.retryOf ? { retryOf: command.retryOf } : {}),
        });
      case "delete":
        return this.adapters.request("/api/automations/delete", { id: command.id });
    }
  }

  private isCurrent(generation: number, sequence: number): boolean {
    return this.active && generation === this.generation && sequence === this.sequence;
  }

  private update(patch: Partial<AutomationSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
