import {
  type Automation,
  type AutomationOutcome,
  AutomationsError,
  type AutomationsStore,
} from "./automations.ts";
import { isDue } from "./automations-schedule.ts";

export type { Automation };

export type AutomationFireResult = {
  status: "ok" | "skipped_busy" | "error";
  message?: string;
  turnId?: string;
};

export type AutomationFireHandler = (automation: Automation) => Promise<AutomationFireResult>;

/**
 * Host-owned poll loop for due automations. Only runs while the host process is alive.
 */
export class AutomationsScheduler {
  readonly #store: AutomationsStore;
  readonly #fire: AutomationFireHandler;
  readonly #now: () => number;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;
  /** Thread ids currently mid-fire — treat concurrent targets as busy. */
  readonly #inflightThreads = new Set<string>();

  constructor(
    store: AutomationsStore,
    fire: AutomationFireHandler,
    options?: { now?: () => number; intervalMs?: number },
  ) {
    this.#store = store;
    this.#fire = fire;
    this.#now = options?.now ?? Date.now;
    this.#intervalMs = options?.intervalMs ?? 20_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#intervalMs);
    // Unref so the timer alone does not keep the process alive in tests.
    if (typeof this.#timer === "object" && this.#timer && "unref" in this.#timer) {
      (this.#timer as NodeJS.Timeout).unref?.();
    }
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Evaluate enabled automations once (also used by tests). */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const { items } = await this.#store.load();
      const nowMs = this.#now();
      const nowIso = new Date(nowMs).toISOString();
      for (const automation of items) {
        if (!automation.enabled) continue;
        if (this.#inflightThreads.has(automation.threadId)) continue;

        const lastRunMs = automation.lastRun ? Date.parse(automation.lastRun) : null;
        const decision = isDue(
          automation.schedule,
          nowMs,
          lastRunMs !== null && Number.isFinite(lastRunMs) ? lastRunMs : null,
        );

        if (decision === "seed") {
          await this.#store.recordOutcome(automation.id, {
            lastRun: nowIso,
            lastOutcome: { at: nowIso, status: "seeded" },
          });
          continue;
        }
        if (decision !== "due") continue;

        await this.#execute(automation, nowIso, /* advanceOnBusy */ false);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Immediate fire for Run now — ignores schedule, still respects busy. */
  async runNow(id: string): Promise<Automation> {
    const automation = await this.#store.get(id);
    if (!automation) throw new AutomationsError("Automation not found.", 404);
    const nowIso = new Date(this.#now()).toISOString();
    await this.#execute(automation, nowIso, /* advanceOnBusy */ true);
    const updated = await this.#store.get(id);
    if (!updated) throw new AutomationsError("Automation not found.", 404);
    return updated;
  }

  async #execute(
    automation: Automation,
    nowIso: string,
    advanceOnBusy: boolean,
  ): Promise<void> {
    if (this.#inflightThreads.has(automation.threadId)) {
      const outcome: AutomationOutcome = {
        at: nowIso,
        status: "skipped_busy",
        message: "Another automation is already running on this conversation.",
      };
      await this.#store.recordOutcome(automation.id, {
        lastRun: advanceOnBusy ? nowIso : automation.lastRun,
        lastOutcome: outcome,
      });
      return;
    }

    this.#inflightThreads.add(automation.threadId);
    try {
      const result = await this.#fire(automation);
      if (result.status === "skipped_busy") {
        await this.#store.recordOutcome(automation.id, {
          lastRun: advanceOnBusy ? nowIso : automation.lastRun,
          lastOutcome: {
            at: nowIso,
            status: "skipped_busy",
            message: result.message ?? "Conversation is busy.",
          },
        });
        return;
      }
      if (result.status === "error") {
        await this.#store.recordOutcome(automation.id, {
          lastRun: nowIso,
          lastOutcome: {
            at: nowIso,
            status: "error",
            message: result.message ?? "Automation could not start.",
          },
        });
        return;
      }
      await this.#store.recordOutcome(automation.id, {
        lastRun: nowIso,
        lastOutcome: {
          at: nowIso,
          status: "ok",
          ...(result.turnId ? { turnId: result.turnId } : {}),
          ...(result.message ? { message: result.message } : {}),
        },
      });
    } catch (error) {
      await this.#store.recordOutcome(automation.id, {
        lastRun: nowIso,
        lastOutcome: {
          at: nowIso,
          status: "error",
          message: error instanceof Error ? error.message : "Automation failed.",
        },
      });
    } finally {
      this.#inflightThreads.delete(automation.threadId);
    }
  }
}
