import type {
  ProviderEvent,
  ProviderId,
  ProviderPlanArtifact,
  ProviderPlanStepStatus,
} from "../types";
import { humanizeToolName } from "./tool-presentation";
import { latestPlanFromEvents } from "./provider-plan";

export type WorkGraphNodeSource = "root" | "plan" | "observed";
export type WorkGraphNodeStatus =
  "neutral" | "pending" | "active" | "waiting" | "completed" | "failed";

export interface WorkGraphNode {
  id: string;
  source: WorkGraphNodeSource;
  depth: 0 | 1 | 2;
  label: string;
  detail?: string;
  status: WorkGraphNodeStatus;
}

export interface WorkGraph {
  title: string;
  provider: ProviderId | null;
  nodes: WorkGraphNode[];
  plannedCount: number;
  observedCount: number;
  hasPlan: boolean;
  hasObservedActivity: boolean;
}

type ActivityNode = WorkGraphNode & { lookupId: string };

function compactLabel(value: string | undefined, fallback: string, limit = 140): string {
  const compact = value?.trim().replace(/\s+/g, " ");
  if (!compact) return fallback;
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function planStepStatus(status: ProviderPlanStepStatus): WorkGraphNodeStatus {
  return status;
}

function activityStatusFromApproval(state: string): WorkGraphNodeStatus {
  switch (state) {
    case "pending":
      return "waiting";
    case "allowed_once":
      return "completed";
    case "denied":
    case "cancelled":
    case "expired":
    case "provider_failed":
      return "failed";
    default:
      return "neutral";
  }
}

function activityStatusFromInput(state: string): WorkGraphNodeStatus {
  switch (state) {
    case "pending":
      return "waiting";
    case "answered":
      return "completed";
    case "cancelled":
      return "failed";
    default:
      return "neutral";
  }
}

function activityStatusFromTool(
  status: "running" | "done" | "failed" | "cancelled",
): WorkGraphNodeStatus {
  switch (status) {
    case "running":
      return "active";
    case "done":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
  }
}

function activityLabelForApproval(state: string, toolName: string): string {
  const tool = humanizeToolName(toolName);
  return state === "pending" ? `Approval · ${tool}` : `Approval resolved · ${tool}`;
}

function activityLabelForInput(state: string): string {
  return state === "pending" ? "Input requested" : "Input resolved";
}

function observedActivityNodes(events: ProviderEvent[]): ActivityNode[] {
  const nodes: ActivityNode[] = [];
  const byLookupId = new Map<string, ActivityNode>();

  const add = (node: ActivityNode) => {
    nodes.push(node);
    byLookupId.set(node.lookupId, node);
  };

  for (const event of events) {
    if (event.kind === "tool_started") {
      const lookupId = `tool:${event.toolCallId}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.label = humanizeToolName(event.name);
        existing.status = "active";
        continue;
      }
      add({
        id: `observed-${nodes.length}`,
        lookupId,
        source: "observed",
        depth: 2,
        label: humanizeToolName(event.name),
        detail: "Tool call observed",
        status: "active",
      });
      continue;
    }

    if (event.kind === "tool_finished") {
      const lookupId = `tool:${event.toolCallId}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.status = activityStatusFromTool(event.failed ? "failed" : "done");
      } else {
        add({
          id: `observed-${nodes.length}`,
          lookupId,
          source: "observed",
          depth: 2,
          label: "Tool",
          detail: "Completion observed without a start event",
          status: activityStatusFromTool(event.failed ? "failed" : "done"),
        });
      }
      continue;
    }

    if (event.kind === "approval_pending") {
      const lookupId = `approval:${event.id}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.status = activityStatusFromApproval(event.state);
        continue;
      }
      add({
        id: `observed-${nodes.length}`,
        lookupId,
        source: "observed",
        depth: 2,
        label: activityLabelForApproval(event.state, event.toolName),
        detail: "Operator decision observed",
        status: activityStatusFromApproval(event.state),
      });
      continue;
    }

    if (event.kind === "approval_resolved") {
      const lookupId = `approval:${event.id}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.label = "Approval resolved";
        existing.status = activityStatusFromApproval(event.state);
      } else {
        add({
          id: `observed-${nodes.length}`,
          lookupId,
          source: "observed",
          depth: 2,
          label: "Approval resolved",
          detail: "Operator decision observed without a pending event",
          status: activityStatusFromApproval(event.state),
        });
      }
      continue;
    }

    if (event.kind === "input_requested") {
      const lookupId = `input:${event.id}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.status = activityStatusFromInput(event.state);
        continue;
      }
      add({
        id: `observed-${nodes.length}`,
        lookupId,
        source: "observed",
        depth: 2,
        label: activityLabelForInput(event.state),
        detail: "Operator input observed",
        status: activityStatusFromInput(event.state),
      });
      continue;
    }

    if (event.kind === "input_resolved") {
      const lookupId = `input:${event.id}`;
      const existing = byLookupId.get(lookupId);
      if (existing) {
        existing.label = "Input resolved";
        existing.status = activityStatusFromInput(event.state);
      } else {
        add({
          id: `observed-${nodes.length}`,
          lookupId,
          source: "observed",
          depth: 2,
          label: "Input resolved",
          detail: "Operator input observed without a request event",
          status: activityStatusFromInput(event.state),
        });
      }
      continue;
    }

    if (event.kind === "turn_completed") {
      add({
        id: `observed-${nodes.length}`,
        lookupId: `result:${nodes.length}`,
        source: "observed",
        depth: 2,
        label: "Turn completed",
        detail: "Provider result observed",
        status: "completed",
      });
      continue;
    }

    if (event.kind === "failed") {
      add({
        id: `observed-${nodes.length}`,
        lookupId: `result:${nodes.length}`,
        source: "observed",
        depth: 2,
        label: "Provider failed",
        detail: "Provider result observed",
        status: "failed",
      });
      continue;
    }

    if (event.kind === "cancelled") {
      add({
        id: `observed-${nodes.length}`,
        lookupId: `result:${nodes.length}`,
        source: "observed",
        depth: 2,
        label: "Turn cancelled",
        detail: "Provider result observed",
        status: "failed",
      });
    }
  }

  return nodes;
}

function rootStatus(
  nodes: WorkGraphNode[],
  terminalStatus: WorkGraphNodeStatus | null = null,
): WorkGraphNodeStatus {
  if (terminalStatus) return terminalStatus;
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "waiting")) return "waiting";
  if (nodes.some((node) => node.status === "active")) return "active";
  const actionableNodes = nodes.filter((node) => node.status !== "neutral");
  if (actionableNodes.length > 0 && actionableNodes.every((node) => node.status === "completed")) {
    return "completed";
  }
  if (nodes.some((node) => node.status === "pending")) return "pending";
  return "neutral";
}

function latestTerminalStatus(events: ProviderEvent[]): WorkGraphNodeStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "turn_completed") return "completed";
    if (event?.kind === "failed" || event?.kind === "cancelled") return "failed";
  }
  return null;
}

export function hasWorkGraphEvidence(events: ProviderEvent[]): boolean {
  return events.some(
    (event) =>
      event.kind === "plan_updated" ||
      event.kind === "tool_started" ||
      event.kind === "tool_finished" ||
      event.kind === "approval_pending" ||
      event.kind === "approval_resolved" ||
      event.kind === "input_requested" ||
      event.kind === "input_resolved" ||
      event.kind === "turn_completed" ||
      event.kind === "failed" ||
      event.kind === "cancelled",
  );
}

export function buildWorkGraph(events: ProviderEvent[]): WorkGraph {
  const plan: ProviderPlanArtifact | null = latestPlanFromEvents([events]);
  const activityNodes = observedActivityNodes(events);
  const plannedSteps = plan?.steps ?? [];
  const plannedStepNodes: WorkGraphNode[] = plannedSteps.map((step, index) => ({
    id: `intent-step-${index}`,
    source: "plan",
    depth: 2,
    label: compactLabel(step.content, `Step ${index + 1}`),
    detail: "Provider-reported",
    status: planStepStatus(step.status),
  }));
  const aggregateStatus = rootStatus(
    [...activityNodes, ...plannedStepNodes],
    latestTerminalStatus(events),
  );
  const nodes: WorkGraphNode[] = [
    {
      id: "root",
      source: "root",
      depth: 0,
      label: compactLabel(plan?.title, "Agent turn"),
      detail: plan ? "Plan and observed activity" : "Observed activity only",
      status: aggregateStatus,
    },
  ];

  if (plan) {
    nodes.push({
      id: "intent",
      source: "plan",
      depth: 1,
      label: "Provider plan",
      detail: plannedSteps.length
        ? `${plannedSteps.length} reported step${plannedSteps.length === 1 ? "" : "s"}`
        : plan.body?.trim()
          ? "Markdown plan body"
          : "Provider-reported plan",
      status: "neutral",
    });
    if (plannedStepNodes.length > 0) {
      nodes.push(...plannedStepNodes);
    } else if (plan.body?.trim()) {
      nodes.push({
        id: "intent-body",
        source: "plan",
        depth: 2,
        label: "Plan body",
        detail: "Markdown content available in Plan view",
        status: "neutral",
      });
    }
  }

  if (activityNodes.length > 0) {
    nodes.push({
      id: "observed",
      source: "observed",
      depth: 1,
      label: "Observed execution",
      detail: `${activityNodes.length} normalized event${activityNodes.length === 1 ? "" : "s"}`,
      status: aggregateStatus,
    });
    nodes.push(...activityNodes.map(({ lookupId: _lookupId, ...node }) => node));
  }

  return {
    title: compactLabel(plan?.title, "Agent turn"),
    provider: plan?.provider ?? null,
    nodes,
    plannedCount: plannedSteps.length,
    observedCount: activityNodes.length,
    hasPlan: plan !== null,
    hasObservedActivity: activityNodes.length > 0,
  };
}
