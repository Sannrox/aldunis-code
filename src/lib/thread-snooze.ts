/**
 * Time-based conversation snooze helpers (T3 Code–inspired).
 *
 * Snooze only affects sidebar visibility. It never stops provider work, never
 * archives history, and never releases a worktree. Timer wakes are derived:
 * when `snoozedUntil` is in the past the row simply stops classifying as
 * snoozed — no server event is required.
 */

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  /** Menu-row time column complementary to the label (e.g. "9:00 AM"). */
  whenLabel: string;
  /** ISO wake time. */
  snoozedUntil: string;
}

export interface ThreadSnoozeFields {
  snoozedUntil?: string | null;
  snoozedAt?: string | null;
  status?: string | null;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

/** Calendar-day advance so DST never skips a local day. */
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices. "This evening" only appears while it is
 * meaningfully before evening; after that the list starts at "Tomorrow".
 */
export function resolveSnoozePresets(now: Date = new Date()): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });

  return presets;
}

/** True when the operator is blocked and hiding the row would bury work. */
export function threadNeedsAttentionWhileSnoozed(
  thread: Pick<ThreadSnoozeFields, "status">,
): boolean {
  return thread.status === "pending_approval" || thread.status === "awaiting_input";
}

/**
 * Snooze is allowed unless the agent is blocked on the operator. Running work
 * may remain snoozed — visibility only.
 */
export function canSnooze(thread: Pick<ThreadSnoozeFields, "status">): boolean {
  return !threadNeedsAttentionWhileSnoozed(thread);
}

/**
 * Host settle/archive/delete 409 while a turn is running or blocked on the
 * operator. Failed last turns may be settled. Running may be snoozed.
 */
export function canSettleConversation(thread: Pick<ThreadSnoozeFields, "status">): boolean {
  const status = thread.status ?? "idle";
  return status !== "pending_approval" && status !== "awaiting_input" && status !== "running";
}

/**
 * Hidden from the ordinary inbox while the wake time is in the future and the
 * thread has not raised its hand for approval or input.
 */
export function isEffectivelySnoozed(
  thread: ThreadSnoozeFields,
  now: Date | string | number = Date.now(),
): boolean {
  if (thread.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(thread.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  const nowMs = typeof now === "number" ? now : Date.parse(String(now));
  if (Number.isNaN(nowMs)) return false;
  if (wakeAtMs <= nowMs) return false;
  return !threadNeedsAttentionWhileSnoozed(thread);
}

/**
 * Compact wake countdown for snoozed rows: "2h", "18h", "3d". Minutes round
 * up so a snooze never reads "0m" while still hidden.
 */
export function snoozeWakeLabel(
  snoozedUntil: string,
  now: Date | string | number = Date.now(),
): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = typeof now === "number" ? now : Date.parse(String(now));
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

/** Validate a client-supplied wake time before the host persists it. */
export function assertValidSnoozeUntil(snoozedUntil: string, now: Date = new Date()): string {
  const wakeMs = Date.parse(snoozedUntil);
  if (Number.isNaN(wakeMs)) {
    throw new Error("A valid snooze wake time is required.");
  }
  if (wakeMs <= now.getTime()) {
    throw new Error("Snooze wake time must be in the future.");
  }
  // Bound far-future abuse without blocking legitimate multi-week hide.
  if (wakeMs - now.getTime() > 60 * DAY_MS) {
    throw new Error("Snooze wake time must be within 60 days.");
  }
  return new Date(wakeMs).toISOString();
}
