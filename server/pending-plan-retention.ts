export const MAX_PENDING_APPROVAL_PLANS = 64;

interface ExpiringPendingPlan {
  id: string;
  expiresAt: string;
}

/** Retain only live, recently created approval plans without adding timers. */
export function retainBoundedPendingPlan<T extends ExpiringPendingPlan>(
  plans: Map<string, T>,
  plan: T,
  now = Date.now(),
  limit = MAX_PENDING_APPROVAL_PLANS,
): void {
  for (const [id, pending] of plans) {
    if (Date.parse(pending.expiresAt) <= now) plans.delete(id);
  }
  plans.set(plan.id, plan);
  while (plans.size > Math.max(0, limit)) {
    const oldest = plans.keys().next().value as string | undefined;
    if (!oldest) break;
    plans.delete(oldest);
  }
}
