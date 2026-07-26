import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutomationSchedule,
  parseSchedule,
} from "./automations-schedule.ts";

export const AUTOMATIONS_SCHEMA_VERSION = 1;
export const MAX_AUTOMATIONS = 50;

export type AutomationOutcomeStatus = "ok" | "skipped_busy" | "error" | "seeded";

export interface AutomationOutcome {
  at: string;
  status: AutomationOutcomeStatus;
  message?: string;
  turnId?: string;
}

export interface Automation {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: AutomationSchedule;
  threadId: string;
  lastRun: string | null;
  lastOutcome?: AutomationOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationsFile {
  schemaVersion: 1;
  items: Automation[];
}

export class AutomationsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOutcome(value: unknown): AutomationOutcome | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.at !== "string") return undefined;
  if (!["ok", "skipped_busy", "error", "seeded"].includes(value.status as string)) {
    return undefined;
  }
  return {
    at: value.at,
    status: value.status as AutomationOutcomeStatus,
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
  };
}

function parseAutomation(value: unknown): Automation {
  if (!isRecord(value)) throw new AutomationsError("Automation is invalid.");
  if (value.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION) {
    throw new AutomationsError("Automation uses an incompatible schema version.");
  }
  if (typeof value.id !== "string" || !value.id) {
    throw new AutomationsError("Automation id is required.");
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new AutomationsError("Automation name is required.");
  }
  if (typeof value.prompt !== "string" || !value.prompt.trim()) {
    throw new AutomationsError("Automation prompt is required.");
  }
  if (typeof value.threadId !== "string" || !value.threadId) {
    throw new AutomationsError("An existing conversation is required.");
  }
  if (typeof value.enabled !== "boolean") {
    throw new AutomationsError("Automation enabled flag is required.");
  }
  if (value.lastRun !== null && typeof value.lastRun !== "string") {
    throw new AutomationsError("Automation lastRun is invalid.");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new AutomationsError("Automation timestamps are required.");
  }
  let schedule: AutomationSchedule;
  try {
    schedule = parseSchedule(value.schedule);
  } catch (error) {
    throw new AutomationsError(error instanceof Error ? error.message : "Invalid schedule.");
  }
  const lastOutcome = parseOutcome(value.lastOutcome);
  return {
    schemaVersion: 1,
    id: value.id,
    name: value.name.trim(),
    enabled: value.enabled,
    prompt: value.prompt.trim(),
    schedule,
    threadId: value.threadId,
    lastRun: value.lastRun,
    ...(lastOutcome ? { lastOutcome } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseFile(value: unknown): AutomationsFile {
  if (!isRecord(value) || value.schemaVersion !== AUTOMATIONS_SCHEMA_VERSION) {
    throw new AutomationsError("Automations file is invalid.");
  }
  if (!Array.isArray(value.items)) {
    throw new AutomationsError("Automations list is invalid.");
  }
  if (value.items.length > MAX_AUTOMATIONS) {
    throw new AutomationsError(`At most ${MAX_AUTOMATIONS} automations are allowed.`);
  }
  return {
    schemaVersion: 1,
    items: value.items.map(parseAutomation),
  };
}

export class AutomationsStore {
  readonly #path: string;
  /** Serialize read-modify-write so concurrent creates/updates do not lose items. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {
    this.#path = join(directory, "automations.v1.json");
  }

  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    // Keep the chain alive even if the operation fails.
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async load(): Promise<{ items: Automation[]; recovered: boolean }> {
    try {
      const file = parseFile(JSON.parse(await readFile(this.#path, "utf8")));
      return { items: file.items, recovered: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { items: [], recovered: false };
      }
      return { items: [], recovered: true };
    }
  }

  async #write(items: Automation[]): Promise<Automation[]> {
    if (items.length > MAX_AUTOMATIONS) {
      throw new AutomationsError(`At most ${MAX_AUTOMATIONS} automations are allowed.`);
    }
    const file: AutomationsFile = { schemaVersion: 1, items };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    return items;
  }

  async create(input: {
    name: string;
    prompt: string;
    schedule: unknown;
    threadId: string;
    enabled?: boolean;
  }): Promise<Automation> {
    return this.#withLock(async () => {
      const { items } = await this.load();
      if (items.length >= MAX_AUTOMATIONS) {
        throw new AutomationsError(`At most ${MAX_AUTOMATIONS} automations are allowed.`, 429);
      }
      const now = new Date().toISOString();
      let schedule: AutomationSchedule;
      try {
        schedule = parseSchedule(input.schedule);
      } catch (error) {
        throw new AutomationsError(error instanceof Error ? error.message : "Invalid schedule.");
      }
      if (typeof input.name !== "string" || !input.name.trim()) {
        throw new AutomationsError("Automation name is required.");
      }
      if (typeof input.prompt !== "string" || !input.prompt.trim()) {
        throw new AutomationsError("Automation prompt is required.");
      }
      if (typeof input.threadId !== "string" || !input.threadId) {
        throw new AutomationsError("An existing conversation is required.");
      }
      const automation: Automation = {
        schemaVersion: 1,
        id: randomUUID(),
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        prompt: input.prompt.trim(),
        schedule,
        threadId: input.threadId,
        lastRun: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.#write([...items, automation]);
      return automation;
    });
  }

  async update(input: unknown): Promise<Automation> {
    return this.#withLock(async () => {
      if (!isRecord(input) || typeof input.id !== "string") {
        throw new AutomationsError("Automation id is required.");
      }
      const { items } = await this.load();
      const index = items.findIndex((item) => item.id === input.id);
      if (index === -1) throw new AutomationsError("Automation not found.", 404);
      const existing = items[index]!;
      let schedule = existing.schedule;
      if (input.schedule !== undefined) {
        try {
          schedule = parseSchedule(input.schedule);
        } catch (error) {
          throw new AutomationsError(error instanceof Error ? error.message : "Invalid schedule.");
        }
      }
      const name = input.name !== undefined
        ? (typeof input.name === "string" ? input.name.trim() : "")
        : existing.name;
      const prompt = input.prompt !== undefined
        ? (typeof input.prompt === "string" ? input.prompt.trim() : "")
        : existing.prompt;
      if (!name) throw new AutomationsError("Automation name is required.");
      if (!prompt) throw new AutomationsError("Automation prompt is required.");
      const threadId = input.threadId !== undefined
        ? (typeof input.threadId === "string" ? input.threadId : "")
        : existing.threadId;
      if (!threadId) throw new AutomationsError("An existing conversation is required.");
      const enabled = input.enabled !== undefined
        ? Boolean(input.enabled)
        : existing.enabled;
      const now = new Date().toISOString();
      const updated: Automation = {
        ...existing,
        name,
        prompt,
        schedule,
        threadId,
        enabled,
        updatedAt: now,
      };
      const next = items.slice();
      next[index] = updated;
      await this.#write(next);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    return this.#withLock(async () => {
      const { items } = await this.load();
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) {
        throw new AutomationsError("Automation not found.", 404);
      }
      await this.#write(next);
    });
  }

  async recordOutcome(
    id: string,
    patch: {
      lastRun?: string | null;
      lastOutcome: AutomationOutcome;
    },
  ): Promise<Automation | null> {
    return this.#withLock(async () => {
      const { items } = await this.load();
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const existing = items[index]!;
      const updated: Automation = {
        ...existing,
        lastRun: patch.lastRun !== undefined ? patch.lastRun : existing.lastRun,
        lastOutcome: patch.lastOutcome,
        updatedAt: new Date().toISOString(),
      };
      const next = items.slice();
      next[index] = updated;
      await this.#write(next);
      return updated;
    });
  }

  async get(id: string): Promise<Automation | null> {
    const { items } = await this.load();
    return items.find((item) => item.id === id) ?? null;
  }
}
