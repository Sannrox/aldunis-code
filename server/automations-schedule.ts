/**
 * Pure schedule due-checks for automations (interval + 5-field Unix cron).
 * No I/O — inject `nowMs` and `lastRunMs` for deterministic tests.
 */

export type AutomationSchedule =
  | { type: "interval"; secs: number }
  | { type: "cron"; expr: string };

export type DueDecision = "seed" | "due" | "wait";

export const MIN_INTERVAL_SECS = 60;
export const MAX_INTERVAL_SECS = 60 * 60 * 24 * 30; // 30 days

/** Whether a never-run schedule should fire immediately (it should not). */
export function isDue(
  schedule: AutomationSchedule,
  nowMs: number,
  lastRunMs: number | null,
): DueDecision {
  if (lastRunMs === null || !Number.isFinite(lastRunMs)) return "seed";
  if (!Number.isFinite(nowMs) || nowMs < lastRunMs) return "wait";

  if (schedule.type === "interval") {
    const secs = schedule.secs;
    if (!Number.isInteger(secs) || secs < MIN_INTERVAL_SECS) return "wait";
    return nowMs - lastRunMs >= secs * 1000 ? "due" : "wait";
  }

  const next = nextCronOccurrenceMs(schedule.expr, lastRunMs);
  if (next === null) return "wait";
  return next <= nowMs ? "due" : "wait";
}

/**
 * Validate and normalize a schedule from user input.
 * Throws Error with a user-facing message on invalid values.
 */
export function parseSchedule(value: unknown): AutomationSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A schedule is required.");
  }
  const input = value as Record<string, unknown>;
  if (input.type === "interval") {
    const secs = input.secs;
    if (!Number.isInteger(secs) || (secs as number) < MIN_INTERVAL_SECS) {
      throw new Error(`Interval must be an integer of at least ${MIN_INTERVAL_SECS} seconds.`);
    }
    if ((secs as number) > MAX_INTERVAL_SECS) {
      throw new Error(`Interval must be at most ${MAX_INTERVAL_SECS} seconds.`);
    }
    return { type: "interval", secs: secs as number };
  }
  if (input.type === "cron") {
    if (typeof input.expr !== "string" || !input.expr.trim()) {
      throw new Error("A cron expression is required.");
    }
    const expr = input.expr.trim();
    // Force parseability by computing a next occurrence.
    if (nextCronOccurrenceMs(expr, Date.UTC(2000, 0, 1, 0, 0, 0)) === null) {
      throw new Error("Cron expression must be a valid 5-field Unix schedule (min hour dom mon dow).");
    }
    return { type: "cron", expr };
  }
  throw new Error("Schedule type must be 'interval' or 'cron'.");
}

/**
 * Next matching minute strictly after `afterMs` (exclusive), or null if invalid.
 * Fields: minute hour day-of-month month day-of-week (0=Sunday or 7=Sunday).
 */
export function nextCronOccurrenceMs(expr: string, afterMs: number): number | null {
  const fields = parseCronFields(expr);
  if (!fields) return null;

  // Search forward minute-by-minute from the next full minute after afterMs.
  // Cap search at ~2 years to avoid infinite loops on impossible rules.
  const start = new Date(afterMs);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  const limit = afterMs + 2 * 365 * 24 * 60 * 60 * 1000;

  for (let cursor = start.getTime(); cursor <= limit; cursor += 60_000) {
    const d = new Date(cursor);
    if (matchesCron(fields, d)) return cursor;
  }
  return null;
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  /** True when the day-of-month field is unrestricted (`*` / full range). */
  domAny: boolean;
  /** True when the day-of-week field is unrestricted (`*` / full range). */
  dowAny: boolean;
}

function parseCronFields(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  try {
    const domRaw = parts[2]!;
    const dowRaw = parts[4]!;
    return {
      minutes: expandField(parts[0]!, 0, 59),
      hours: expandField(parts[1]!, 0, 23),
      dom: expandField(domRaw, 1, 31),
      months: expandField(parts[3]!, 1, 12),
      // Accept 0-7 where 0 and 7 are Sunday.
      dow: expandDow(dowRaw),
      // POSIX: restricted DOM and DOW combine with OR, not AND.
      domAny: isUnrestrictedField(domRaw),
      dowAny: isUnrestrictedField(dowRaw),
    };
  } catch {
    return null;
  }
}

// Star or star-slash-N over the full domain — not a restricted list/range.
function isUnrestrictedField(field: string): boolean {
  const trimmed = field.trim();
  if (trimmed === "*") return true;
  // Star-step still means every k-th unit across the full domain.
  return /^\*\/\d+$/.test(trimmed);
}

function expandDow(field: string): Set<number> {
  const raw = expandField(field, 0, 7);
  const result = new Set<number>();
  for (const value of raw) {
    result.add(value === 7 ? 0 : value);
  }
  return result;
}

function expandField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const piece of field.split(",")) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(piece);
    const body = stepMatch ? stepMatch[1]! : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error("bad step");

    let rangeStart: number;
    let rangeEnd: number;
    if (body === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      rangeStart = Number(a);
      rangeEnd = Number(b);
    } else {
      rangeStart = Number(body);
      rangeEnd = rangeStart;
    }
    if (
      !Number.isInteger(rangeStart)
      || !Number.isInteger(rangeEnd)
      || rangeStart < min
      || rangeEnd > max
      || rangeStart > rangeEnd
    ) {
      throw new Error("bad range");
    }
    for (let value = rangeStart; value <= rangeEnd; value += step) {
      result.add(value);
    }
  }
  if (result.size === 0) throw new Error("empty");
  return result;
}

function matchesCron(fields: CronFields, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay(); // 0=Sunday
  if (!fields.minutes.has(minute) || !fields.hours.has(hour) || !fields.months.has(month)) {
    return false;
  }
  // POSIX/Vixie: when both DOM and DOW are restricted, match if either hits.
  // When either is unrestricted, require the restricted field(s) as usual.
  const domOk = fields.dom.has(dom);
  const dowOk = fields.dow.has(dow);
  if (!fields.domAny && !fields.dowAny) return domOk || dowOk;
  if (!fields.domAny) return domOk;
  if (!fields.dowAny) return dowOk;
  return true;
}
