/**
 * Ephemeral context-window helpers (T3 Code–inspired).
 * Snapshots come from live provider events, not durable history.
 */

export interface ContextWindowSnapshot {
  usedTokens: number;
  maxTokens: number | null;
  totalProcessedTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usedPercentage: number | null;
  remainingTokens: number | null;
}

export function contextWindowFromUsage(input: {
  usedTokens: number;
  maxTokens?: number | null;
  totalProcessedTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}): ContextWindowSnapshot | null {
  if (!Number.isFinite(input.usedTokens) || input.usedTokens < 0) return null;
  const maxTokens =
    typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : null;
  const usedPercentage =
    maxTokens !== null ? Math.min(100, (input.usedTokens / maxTokens) * 100) : null;
  return {
    usedTokens: input.usedTokens,
    maxTokens,
    totalProcessedTokens:
      typeof input.totalProcessedTokens === "number" && Number.isFinite(input.totalProcessedTokens)
        ? input.totalProcessedTokens
        : null,
    inputTokens:
      typeof input.inputTokens === "number" && Number.isFinite(input.inputTokens)
        ? input.inputTokens
        : null,
    outputTokens:
      typeof input.outputTokens === "number" && Number.isFinite(input.outputTokens)
        ? input.outputTokens
        : null,
    usedPercentage,
    remainingTokens:
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - input.usedTokens)) : null,
  };
}

export function formatContextWindowTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function formatContextWindowPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}
