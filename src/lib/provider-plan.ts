import type { ProviderEvent, ProviderPlanArtifact } from "../types";

export function mergePlanArtifact(
  current: ProviderPlanArtifact | undefined,
  event: Extract<ProviderEvent, { kind: "plan_updated" }>,
): ProviderPlanArtifact {
  const body = event.artifact.body === undefined
    ? current?.body
    : event.bodyMode === "append"
      ? `${current?.body ?? ""}${event.artifact.body}`
      : event.artifact.body;
  return {
    ...current,
    ...event.artifact,
    ...(body === undefined ? {} : { body }),
  };
}

export function planMarkdown(plan: ProviderPlanArtifact): string {
  const sections: string[] = [];
  if (plan.title?.trim()) sections.push(`# ${plan.title.trim()}`);
  if (plan.body?.trim()) sections.push(plan.body.trim());
  if (plan.steps?.length) {
    sections.push(plan.steps.map((step) => {
      const marker = step.status === "completed" ? "x" : " ";
      const suffix = step.status === "active"
        ? " _(active)_"
        : step.status === "neutral"
          ? ""
          : step.status === "pending"
            ? " _(pending)_"
            : "";
      return `- [${marker}] ${step.content}${suffix}`;
    }).join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

export function latestPlanFromEvents(
  eventGroups: ProviderEvent[][],
): ProviderPlanArtifact | null {
  let latestGroupPlan: ProviderPlanArtifact | null = null;
  for (const events of eventGroups) {
    const plans = new Map<string, {
      artifact: ProviderPlanArtifact;
      lastIndex: number;
      hasLiveUpdate: boolean;
    }>();
    let index = 0;
    for (const event of events) {
      if (event.kind !== "plan_updated") continue;
      const key = `${event.artifact.provider}\n${event.artifact.id}`;
      const current = plans.get(key);
      plans.set(key, {
        artifact: mergePlanArtifact(current?.artifact, event),
        lastIndex: index,
        hasLiveUpdate: current?.hasLiveUpdate === true || event.artifact.updatedAt === undefined,
      });
      index += 1;
    }
    if (plans.size === 0) continue;
    latestGroupPlan = [...plans.values()]
      .sort((left, right) => {
        if (left.hasLiveUpdate !== right.hasLiveUpdate) return left.hasLiveUpdate ? 1 : -1;
        if (!left.hasLiveUpdate && !right.hasLiveUpdate) {
          const byUpdatedAt = (left.artifact.updatedAt ?? "")
            .localeCompare(right.artifact.updatedAt ?? "");
          if (byUpdatedAt !== 0) return byUpdatedAt;
        }
        return left.lastIndex - right.lastIndex;
      })
      .at(-1)?.artifact ?? null;
  }
  return latestGroupPlan;
}
