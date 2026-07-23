export interface SplitWorkspaceState {
  primaryId: string | null;
  secondaryId: string | null;
  splitPercent: number;
}

export function clampSplitPercent(value: number): number {
  return Math.min(70, Math.max(30, Number.isFinite(value) ? value : 50));
}

export function normalizeSplitWorkspaceState(
  input: { primaryId?: unknown; secondaryId?: unknown; splitPercent?: unknown },
  fallbackPrimaryId: string | null,
): SplitWorkspaceState {
  const primaryId = typeof input.primaryId === "string" ? input.primaryId : fallbackPrimaryId;
  const secondaryId = typeof input.secondaryId === "string" ? input.secondaryId : null;
  return {
    primaryId,
    secondaryId: secondaryId === primaryId ? null : secondaryId,
    splitPercent: clampSplitPercent(typeof input.splitPercent === "number" ? input.splitPercent : 50),
  };
}
