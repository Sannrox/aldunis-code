import type { ProviderId } from "../types";

export const USAGE_RANGE_DAYS = [7, 30, 90] as const;
/** Upper bound for one provider-reported token metric at the receipt boundary. */
export const MAX_USAGE_TOKENS = 100_000_000;
/** Upper bound for one provider-reported cost observation at the receipt boundary. */
export const MAX_USAGE_COST_USD = 1_000_000;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];
export type UsageReceiptStatus = "running" | "completed" | "failed" | "interrupted";

/**
 * A bounded, provider-reported usage observation for one Aldunis-owned turn.
 * It intentionally contains no prompt, tool, repository, or provider payload.
 */
export interface UsageReceipt {
  schemaVersion: 2;
  id: string;
  threadId: string;
  turnId: string;
  provider: ProviderId;
  model: string | null;
  status: UsageReceiptStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
  /** Legacy provider total retained for schema compatibility; not additive usage. */
  totalProcessedTokens: number | null;
  reportedCostUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageTotals {
  observedTurns: number;
  completedTurns: number;
  inputTokens: number;
  outputTokens: number;
  processedTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningOutputTokens: number;
  reportedCostUsd: number | null;
  pricedTurns: number;
}

export interface UsageProviderSummary {
  provider: ProviderId;
  turns: number;
  processedTokens: number;
  reportedCostUsd: number | null;
  pricedTurns: number;
}

export interface UsageModelSummary {
  provider: ProviderId;
  model: string | null;
  turns: number;
  processedTokens: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number | null;
}

export interface UsageDailyPoint {
  date: string;
  label: string;
  processedTokens: number;
  reportedCostUsd: number | null;
}

export interface UsageReport {
  generatedAt: string;
  rangeDays: UsageRangeDays;
  startDate: string;
  endDate: string;
  totals: UsageTotals;
  providers: UsageProviderSummary[];
  models: UsageModelSummary[];
  daily: UsageDailyPoint[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_USAGE_TOTAL = Number.MAX_SAFE_INTEGER;

function boundedNonNegative(value: number | null | undefined, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function tokenValue(value: number | null | undefined): number | null {
  return boundedNonNegative(value, MAX_USAGE_TOKENS);
}

function costValue(value: number | null | undefined): number | null {
  return boundedNonNegative(value, MAX_USAGE_COST_USD);
}

function addTotal(current: number, next: number): number {
  if (next <= 0) return current;
  return current > MAX_USAGE_TOTAL - next ? MAX_USAGE_TOTAL : current + next;
}

function dayKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function dayLabel(value: string): string {
  const [, month, day] = value.split("-");
  return `${month}/${day}`;
}

function processedTokens(receipt: UsageReceipt): number | null {
  const input = tokenValue(receipt.inputTokens);
  const output = tokenValue(receipt.outputTokens);
  if (input !== null || output !== null) {
    const processed = addTotal(input ?? 0, output ?? 0);
    // Anthropic reports cache reads/writes separately from input_tokens;
    // other providers keep their cache categories in their input total.
    return receipt.provider === "claude-code"
      ? addTotal(
          addTotal(processed, tokenValue(receipt.cachedInputTokens) ?? 0),
          tokenValue(receipt.cacheWriteInputTokens) ?? 0,
        )
      : processed;
  }
  // Provider totals can be cumulative across a session. Without a durable
  // baseline, treating them as per-turn usage would overcount multi-turn work.
  return 0;
}

function addCost(current: number | null, next: number | null): number | null {
  const value = costValue(next);
  if (value === null) return current;
  return addTotal(current ?? 0, value);
}

function createRange(now: Date, rangeDays: UsageRangeDays): { start: Date; end: Date } {
  const end = new Date(now);
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (rangeDays - 1)),
  );
  return { start, end };
}

export function isUsageRangeDays(value: unknown): value is UsageRangeDays {
  return USAGE_RANGE_DAYS.includes(value as UsageRangeDays);
}

export function buildUsageReport(
  receipts: UsageReceipt[],
  rangeDays: UsageRangeDays,
  now = new Date(),
): UsageReport {
  const { start, end } = createRange(now, rangeDays);
  const startDate = dayKey(start);
  const endDate = dayKey(end);

  const totals: UsageTotals = {
    observedTurns: 0,
    completedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    processedTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    reportedCostUsd: null,
    pricedTurns: 0,
  };
  const providers = new Map<ProviderId, UsageProviderSummary>();
  const models = new Map<ProviderId, Map<string, UsageModelSummary>>();
  const daily: UsageDailyPoint[] = [];

  for (let index = 0; index < rangeDays; index += 1) {
    const date = dayKey(new Date(start.getTime() + index * DAY_MS));
    daily.push({
      date,
      label: dayLabel(date),
      processedTokens: 0,
      reportedCostUsd: null,
    });
  }

  const startTime = start.getTime();
  const endTime = end.getTime();
  for (const receipt of receipts) {
    if (receipt.status === "running") continue;
    const observedAt = Date.parse(receipt.updatedAt);
    if (!Number.isFinite(observedAt) || observedAt < startTime || observedAt > endTime) continue;

    totals.observedTurns += 1;
    if (receipt.status === "completed") totals.completedTurns += 1;
    const input = tokenValue(receipt.inputTokens) ?? 0;
    const output = tokenValue(receipt.outputTokens) ?? 0;
    const cached = tokenValue(receipt.cachedInputTokens) ?? 0;
    const cacheWrite = tokenValue(receipt.cacheWriteInputTokens) ?? 0;
    const reasoning = tokenValue(receipt.reasoningOutputTokens) ?? 0;
    const processed = processedTokens(receipt) ?? 0;
    const provider =
      providers.get(receipt.provider) ??
      ({
        provider: receipt.provider,
        turns: 0,
        processedTokens: 0,
        reportedCostUsd: null,
        pricedTurns: 0,
      } satisfies UsageProviderSummary);
    provider.turns += 1;
    provider.processedTokens = addTotal(provider.processedTokens, processed);
    provider.reportedCostUsd = addCost(provider.reportedCostUsd, receipt.reportedCostUsd);
    if (costValue(receipt.reportedCostUsd) !== null) provider.pricedTurns += 1;
    providers.set(receipt.provider, provider);

    const providerModels = models.get(receipt.provider) ?? new Map();
    const modelKey = receipt.model ?? "";
    const model =
      providerModels.get(modelKey) ??
      ({
        provider: receipt.provider,
        model: receipt.model,
        turns: 0,
        processedTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        reportedCostUsd: null,
      } satisfies UsageModelSummary);
    model.turns += 1;
    model.processedTokens = addTotal(model.processedTokens, processed);
    model.inputTokens = addTotal(model.inputTokens, input);
    model.outputTokens = addTotal(model.outputTokens, output);
    model.reportedCostUsd = addCost(model.reportedCostUsd, receipt.reportedCostUsd);
    providerModels.set(modelKey, model);
    models.set(receipt.provider, providerModels);

    const point = daily[Math.floor((observedAt - startTime) / DAY_MS)];
    if (point) {
      point.processedTokens = addTotal(point.processedTokens, processed);
      point.reportedCostUsd = addCost(point.reportedCostUsd, receipt.reportedCostUsd);
    }

    totals.inputTokens = addTotal(totals.inputTokens, input);
    totals.outputTokens = addTotal(totals.outputTokens, output);
    totals.processedTokens = addTotal(totals.processedTokens, processed);
    totals.cachedInputTokens = addTotal(totals.cachedInputTokens, cached);
    totals.cacheWriteInputTokens = addTotal(totals.cacheWriteInputTokens, cacheWrite);
    totals.reasoningOutputTokens = addTotal(totals.reasoningOutputTokens, reasoning);
    totals.reportedCostUsd = addCost(totals.reportedCostUsd, receipt.reportedCostUsd);
    if (costValue(receipt.reportedCostUsd) !== null) totals.pricedTurns += 1;
  }

  return {
    generatedAt: now.toISOString(),
    rangeDays,
    startDate,
    endDate,
    totals,
    providers: [...providers.values()].sort(
      (left, right) =>
        right.processedTokens - left.processedTokens || left.provider.localeCompare(right.provider),
    ),
    models: [...models.values()]
      .flatMap((providerModels) => [...providerModels.values()])
      .sort(
        (left, right) =>
          right.processedTokens - left.processedTokens ||
          left.provider.localeCompare(right.provider) ||
          (left.model ?? "").localeCompare(right.model ?? ""),
      ),
    daily,
  };
}
