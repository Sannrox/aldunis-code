/**
 * Timer-only conversation automations (interval or 5-field UTC cron).
 * Evaluated only while the local host process is running.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InteractionMode } from "./provider.ts";

export const AUTOMATIONS_SCHEMA_VERSION = 1 as const;
export const MIN_INTERVAL_SECONDS = 60;

export type AutomationSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "cron"; expression: string };

export type AutomationFireKind = "scheduled" | "manual";
export type AutomationFireStatus =
  | "started"
  | "completed"
  | "failed"
  | "skipped_busy"
  | "unknown";

/** Metadata-only durable identity for one automation execution attempt. */
export interface AutomationFire {
  schemaVersion: 2;
  id: string;
  automationId: string;
  key: string;
  kind: AutomationFireKind;
  scheduledAt: string | null;
  requestedAt: string;
  turnId: string | null;
  providerRunId: string | null;
  status: AutomationFireStatus;
  error: string | null;
  retryOf: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationFireKey {
  automationId: string;
  key: string;
  kind: AutomationFireKind;
  scheduledAt: string | null;
  requestedAt: string;
  retryOf?: string | null;
}

export interface AutomationFireExecution {
  status: Exclude<AutomationFireStatus, "started" | "skipped_busy">;
  error?: string | null;
}

export interface AutomationFireStore {
  get(automationId: string, key: string): Promise<AutomationFire | null>;
  getById?(fireId: string): Promise<AutomationFire | null>;
  latest?(automationId: string): Promise<AutomationFire | null>;
  recordSkippedBusy(input: AutomationFireKey): Promise<AutomationFire>;
  claim(input: AutomationFireKey): Promise<{ fire: AutomationFire; claimed: boolean }>;
  finish(
    fireId: string,
    status: Exclude<AutomationFireStatus, "started" | "skipped_busy">,
    error?: string | null,
  ): Promise<AutomationFire>;
}

export interface Automation {
  schemaVersion: 1;
  id: string;
  name: string;
  threadId: string;
  prompt: string;
  mode: InteractionMode;
  enabled: boolean;
  schedule: AutomationSchedule;
  createdAt: string;
  updatedAt: string;
  /** null until first host evaluation seeds without firing. */
  lastRunAt: string | null;
  lastStatus: "ok" | "skipped_busy" | "error" | "unknown" | null;
  lastError: string | null;
}

export interface AutomationStoreFile {
  schemaVersion: 1;
  items: Automation[];
}

export class AutomationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function isMode(value: unknown): value is InteractionMode {
  return value === "ask" || value === "plan" || value === "build";
}

/** Validate standard 5-field cron (minute hour day-of-month month day-of-week). */
export function assertValidCron(expression: string): void {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new AutomationError("Cron must be a 5-field UTC expression (min hour dom month dow).");
  }
  const [minute, hour, dom, month, dow] = parts;
  const check = (field: string, min: number, max: number, label: string) => {
    if (field === "*") return;
    for (const piece of field.split(",")) {
      const stepMatch = piece.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
      if (!stepMatch) throw new AutomationError(`Invalid cron ${label} field: ${field}`);
      const start = stepMatch[1] === "*" ? min : Number(stepMatch[1]);
      const end = stepMatch[2] !== undefined ? Number(stepMatch[2]) : start;
      const step = stepMatch[3] !== undefined ? Number(stepMatch[3]) : 1;
      if (
        !Number.isInteger(start)
        || !Number.isInteger(end)
        || !Number.isInteger(step)
        || start < min
        || end > max
        || start > end
        || step < 1
      ) {
        throw new AutomationError(`Invalid cron ${label} field: ${field}`);
      }
    }
  };
  check(minute, 0, 59, "minute");
  check(hour, 0, 23, "hour");
  check(dom, 1, 31, "day-of-month");
  check(month, 1, 12, "month");
  check(dow, 0, 6, "day-of-week");
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const piece of field.split(",")) {
    const stepMatch = piece.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!stepMatch) return false;
    const start = stepMatch[1] === "*" ? min : Number(stepMatch[1]);
    const end = stepMatch[2] !== undefined ? Number(stepMatch[2]) : start;
    const step = stepMatch[3] !== undefined ? Number(stepMatch[3]) : 1;
    for (let cursor = start; cursor <= end; cursor += step) {
      if (cursor === value) return true;
    }
  }
  return false;
}

/** Star or star-step over the full domain — not a restricted list/range. */
function isUnrestrictedField(field: string): boolean {
  const trimmed = field.trim();
  if (trimmed === "*") return true;
  return /^\*\/\d+$/.test(trimmed);
}

export function cronMatchesUtc(expression: string, date: Date): boolean {
  const [minute, hour, dom, month, dow] = expression.trim().split(/\s+/);
  if (
    !fieldMatches(minute, date.getUTCMinutes(), 0, 59)
    || !fieldMatches(hour, date.getUTCHours(), 0, 23)
    || !fieldMatches(month, date.getUTCMonth() + 1, 1, 12)
  ) {
    return false;
  }
  // POSIX/Vixie: when both DOM and DOW are restricted, match if either hits.
  const domOk = fieldMatches(dom, date.getUTCDate(), 1, 31);
  const dowOk = fieldMatches(dow, date.getUTCDay(), 0, 6);
  if (!isUnrestrictedField(dom) && !isUnrestrictedField(dow)) return domOk || dowOk;
  if (!isUnrestrictedField(dom)) return domOk;
  if (!isUnrestrictedField(dow)) return dowOk;
  return true;
}

/**
 * Whether a scheduled tick should fire at `now` given lastRunAt semantics.
 * First evaluation (lastRunAt null) never fires — caller seeds lastRunAt.
 */
export function isScheduleDue(automation: Automation, now: Date): boolean {
  if (!automation.enabled) return false;
  if (automation.lastRunAt == null) return true; // seed tick
  const last = new Date(automation.lastRunAt).getTime();
  if (!Number.isFinite(last)) return true;
  if (automation.schedule.kind === "interval") {
    return now.getTime() >= last + automation.schedule.seconds * 1000;
  }
  // Cron: fire when the current UTC minute matches and we have not run in this minute.
  const lastMinute = Math.floor(last / 60_000);
  const nowMinute = Math.floor(now.getTime() / 60_000);
  if (nowMinute <= lastMinute) return false;
  return cronMatchesUtc(automation.schedule.expression, now);
}

export function parseAutomation(value: unknown): Automation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutomationError("Automation is invalid.");
  }
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION
    || typeof input.id !== "string"
    || typeof input.name !== "string"
    || !input.name.trim()
    || typeof input.threadId !== "string"
    || !input.threadId
    || typeof input.prompt !== "string"
    || !input.prompt.trim()
    || !isMode(input.mode)
    || typeof input.enabled !== "boolean"
    || typeof input.createdAt !== "string"
    || typeof input.updatedAt !== "string"
    || (input.lastRunAt !== null && typeof input.lastRunAt !== "string")
    || (input.lastStatus !== null
      && input.lastStatus !== "ok"
      && input.lastStatus !== "skipped_busy"
      && input.lastStatus !== "error"
      && input.lastStatus !== "unknown")
    || (input.lastError !== null && typeof input.lastError !== "string")
  ) {
    throw new AutomationError("Automation uses an incompatible or invalid value.");
  }
  const scheduleRaw = input.schedule;
  if (!scheduleRaw || typeof scheduleRaw !== "object" || Array.isArray(scheduleRaw)) {
    throw new AutomationError("Automation schedule is required.");
  }
  const schedule = scheduleRaw as Record<string, unknown>;
  let parsedSchedule: AutomationSchedule;
  if (schedule.kind === "interval") {
    if (
      typeof schedule.seconds !== "number"
      || !Number.isInteger(schedule.seconds)
      || schedule.seconds < MIN_INTERVAL_SECONDS
    ) {
      throw new AutomationError(`Interval must be an integer >= ${MIN_INTERVAL_SECONDS} seconds.`);
    }
    parsedSchedule = { kind: "interval", seconds: schedule.seconds };
  } else if (schedule.kind === "cron") {
    if (typeof schedule.expression !== "string") {
      throw new AutomationError("Cron expression is required.");
    }
    assertValidCron(schedule.expression);
    parsedSchedule = { kind: "cron", expression: schedule.expression.trim() };
  } else {
    throw new AutomationError("Schedule kind must be interval or cron.");
  }
  return {
    schemaVersion: 1,
    id: input.id,
    name: input.name.trim(),
    threadId: input.threadId,
    prompt: input.prompt.trim(),
    mode: input.mode,
    enabled: input.enabled,
    schedule: parsedSchedule,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastRunAt: input.lastRunAt,
    lastStatus: input.lastStatus,
    lastError: input.lastError,
  };
}

function parseStore(value: unknown): AutomationStoreFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AutomationError("Automations store is invalid.");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION || !Array.isArray(input.items)) {
    throw new AutomationError("Automations store uses an incompatible schema.");
  }
  return {
    schemaVersion: 1,
    items: input.items.map((item) => parseAutomation(item)),
  };
}

export class AutomationStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {
    this.#path = join(directory, "automations.v1.json");
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async list(): Promise<Automation[]> {
    return this.#serialize(async () => (await this.#read()).items);
  }

  async get(id: string): Promise<Automation | null> {
    const items = await this.list();
    return items.find((item) => item.id === id) ?? null;
  }

  async create(input: {
    name: string;
    threadId: string;
    prompt: string;
    mode?: InteractionMode;
    enabled?: boolean;
    schedule: AutomationSchedule;
  }): Promise<Automation> {
    return this.#serialize(async () => {
      const now = new Date().toISOString();
      const draft: Automation = {
        schemaVersion: 1,
        id: randomUUID(),
        name: input.name,
        threadId: input.threadId,
        prompt: input.prompt,
        mode: input.mode ?? "build",
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
      };
      const automation = parseAutomation(draft);
      const store = await this.#read();
      store.items.push(automation);
      await this.#write(store);
      return automation;
    });
  }

  async update(id: string, patch: Partial<{
    name: string;
    prompt: string;
    mode: InteractionMode;
    enabled: boolean;
    schedule: AutomationSchedule;
    lastRunAt: string | null;
    lastStatus: Automation["lastStatus"];
    lastError: string | null;
  }>): Promise<Automation> {
    return this.#serialize(async () => {
      const store = await this.#read();
      const index = store.items.findIndex((item) => item.id === id);
      if (index < 0) throw new AutomationError("Automation not found.", 404);
      const current = store.items[index]!;
      const next = parseAutomation({
        ...current,
        ...patch,
        id: current.id,
        threadId: current.threadId,
        schemaVersion: 1,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
      store.items[index] = next;
      await this.#write(store);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    return this.#serialize(async () => {
      const store = await this.#read();
      const next = store.items.filter((item) => item.id !== id);
      if (next.length === store.items.length) {
        throw new AutomationError("Automation not found.", 404);
      }
      await this.#write({ schemaVersion: 1, items: next });
    });
  }

  async #read(): Promise<AutomationStoreFile> {
    try {
      return parseStore(JSON.parse(await readFile(this.#path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, items: [] };
      }
      if (error instanceof AutomationError) throw error;
      return { schemaVersion: 1, items: [] };
    }
  }

  async #write(store: AutomationStoreFile): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }
}

export class AutomationScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #threadExecutionTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: AutomationStore,
    private readonly options: {
      /** Return true when the target thread cannot accept a new turn. */
      isThreadBusy: (threadId: string) => Promise<boolean>;
      /** Start a provider turn for this automation; throws on hard failure. */
      fire: (
        automation: Automation,
        fire?: AutomationFire,
      ) => Promise<AutomationFireExecution | void>;
      /** Production state hooks; omitted by focused scheduler tests. */
      fireStore?: AutomationFireStore;
      intervalMs?: number;
      now?: () => Date;
    },
  ) {}

  start(): void {
    if (this.#timer) return;
    const intervalMs = this.options.intervalMs ?? 15_000;
    this.#timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #scheduledFireKey(automation: Automation, now: Date): AutomationFireKey {
    let scheduledAt = now;
    if (automation.schedule.kind === "interval") {
      const lastRun = automation.lastRunAt ? Date.parse(automation.lastRunAt) : Number.NaN;
      if (Number.isFinite(lastRun)) {
        scheduledAt = new Date(lastRun + automation.schedule.seconds * 1000);
      }
    } else {
      scheduledAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    }
    const scheduledAtValue = scheduledAt.toISOString();
    return {
      automationId: automation.id,
      key: `scheduled:${scheduledAtValue}`,
      kind: "scheduled",
      scheduledAt: scheduledAtValue,
      requestedAt: now.toISOString(),
      retryOf: null,
    };
  }

  #statusForAutomation(status: AutomationFireStatus): Automation["lastStatus"] {
    switch (status) {
      case "completed": return "ok";
      case "skipped_busy": return "skipped_busy";
      case "failed": return "error";
      case "unknown": return "unknown";
      default: return null;
    }
  }

  #errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "Automation failed.";
    return message.trim().slice(0, 500) || "Automation failed.";
  }

  async #saveOutcome(
    automation: Automation,
    fire: AutomationFire | null,
    now: Date,
    outcome: AutomationFireExecution,
  ): Promise<void> {
    const status = outcome.status;
    const error = outcome.error == null ? null : this.#errorMessage(outcome.error);
    if (this.options.fireStore && fire) {
      await this.options.fireStore.finish(fire.id, status, error);
    }
    await this.store.update(automation.id, {
      lastRunAt: now.toISOString(),
      lastStatus: this.#statusForAutomation(status),
      lastError: error,
    });
  }

  async #saveSkippedBusy(automation: Automation, input: AutomationFireKey): Promise<void> {
    if (this.options.fireStore) {
      await this.options.fireStore.recordSkippedBusy(input);
    }
    await this.store.update(automation.id, {
      lastStatus: "skipped_busy",
      lastError: null,
    });
  }

  async #syncExisting(
    automation: Automation,
    fire: AutomationFire,
    now: Date,
  ): Promise<void> {
    if (fire.status === "started" || fire.status === "skipped_busy") return;
    const latest = await this.options.fireStore?.latest?.(automation.id);
    if (latest && latest.id !== fire.id) return;
    await this.store.update(automation.id, {
      lastRunAt: now.toISOString(),
      lastStatus: this.#statusForAutomation(fire.status),
      lastError: fire.error,
    });
  }

  async #execute(
    automation: Automation,
    input: AutomationFireKey,
    now: Date,
    syncExisting = false,
  ): Promise<void> {
    const previous = this.#threadExecutionTails.get(automation.threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#threadExecutionTails.set(automation.threadId, queued);
    await previous;
    try {
      const existing = await this.options.fireStore?.get(automation.id, input.key);
      if (existing && existing.status !== "skipped_busy") {
        if (syncExisting) await this.#syncExisting(automation, existing, now);
        return;
      }
      if (await this.options.isThreadBusy(automation.threadId)) {
        await this.#saveSkippedBusy(automation, input);
        return;
      }
      const claim = this.options.fireStore
        ? await this.options.fireStore.claim(input)
        : null;
      if (claim && !claim.claimed) {
        if (syncExisting) await this.#syncExisting(automation, claim.fire, now);
        return;
      }
      const fire = claim?.fire ?? null;
      try {
        const outcome = await this.options.fire(automation, fire ?? undefined);
        await this.#saveOutcome(
          automation,
          fire,
          now,
          outcome ?? { status: "completed" },
        );
      } catch (error) {
        const message = this.#errorMessage(error);
        if (this.options.fireStore && fire) {
          await this.options.fireStore.finish(fire.id, "failed", message);
        }
        await this.store.update(automation.id, {
          lastRunAt: now.toISOString(),
          lastStatus: "error",
          lastError: message,
        });
      }
    } finally {
      release();
      if (this.#threadExecutionTails.get(automation.threadId) === queued) {
        this.#threadExecutionTails.delete(automation.threadId);
      }
    }
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = this.#now();
      const items = await this.store.list();
      // Evaluate schedules first, then fire due items concurrently so one long
      // provider turn does not delay other due automations.
      const due: Array<{ automation: Automation; input: AutomationFireKey }> = [];
      const claimedThreads = new Set<string>();
      for (const automation of items) {
        if (!isScheduleDue(automation, now)) continue;
        // First evaluation seeds lastRun without firing.
        if (automation.lastRunAt == null) {
          await this.store.update(automation.id, {
            lastRunAt: now.toISOString(),
            lastStatus: null,
            lastError: null,
          });
          continue;
        }
        const input = this.#scheduledFireKey(automation, now);
        if (claimedThreads.has(automation.threadId) || await this.options.isThreadBusy(automation.threadId)) {
          // Skip without advancing lastRun on scheduled ticks.
          await this.#saveSkippedBusy(automation, input);
          continue;
        }
        claimedThreads.add(automation.threadId);
        due.push({ automation, input });
      }
      await Promise.all(due.map(({ automation, input }) => (
        this.#execute(automation, input, now, true)
      )));
    } finally {
      this.#running = false;
    }
  }

  /** Immediate run; advances lastRun even if the schedule is not due. */
  async runNow(
    id: string,
    idempotencyKey = randomUUID(),
    retryOf: string | null = null,
  ): Promise<Automation> {
    const automation = await this.store.get(id);
    if (!automation) throw new AutomationError("Automation not found.", 404);
    if (retryOf && this.options.fireStore?.getById) {
      const original = await this.options.fireStore.getById(retryOf);
      if (!original || original.automationId !== id || original.status !== "unknown") {
        throw new AutomationError("Only an unknown fire for this automation can be retried.", 409);
      }
    }
    const now = this.#now();
    const input: AutomationFireKey = {
      automationId: id,
      key: `manual:${idempotencyKey}`,
      kind: "manual",
      scheduledAt: null,
      requestedAt: now.toISOString(),
      retryOf,
    };
    if (retryOf && this.options.fireStore?.get) {
      const existingKey = await this.options.fireStore.get(id, input.key);
      if (existingKey) {
        throw new AutomationError("An explicit retry must use a new idempotency key.", 409);
      }
    }
    await this.#execute(automation, input, now);
    return (await this.store.get(id)) ?? automation;
  }
}
