import React from "react";
import type { WorkGraph, WorkGraphNode, WorkGraphNodeStatus } from "../../lib/work-graph";

const STATUS_LABELS: Record<WorkGraphNodeStatus, string> = {
  neutral: "context",
  pending: "planned",
  active: "active",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
};

function sourceLabel(node: WorkGraphNode): string {
  if (node.source === "plan") return "Provider-reported";
  if (node.source === "observed") return "Aldunis-observed";
  return "Work graph";
}

function nodeMarker(node: WorkGraphNode): string {
  if (node.source === "root") return "◆";
  if (node.source === "plan") return "·";
  return "+";
}

export function WorkGraphContent({ graph }: { graph: WorkGraph }) {
  if (!graph.hasPlan && !graph.hasObservedActivity) {
    return (
      <div className="work-graph-empty">
        <strong>No graph data yet</strong>
        <span>The beta view appears after a plan or observable provider activity is reported.</span>
      </div>
    );
  }

  return (
    <div className="work-graph-content">
      <div className="work-graph-beta-note">
        <span className="ui-badge ui-badge--amber">BETA</span>
        <span>Read-only map of provider intent and Aldunis-observed activity.</span>
      </div>
      <div className="work-graph-summary" aria-label="Work graph summary">
        <span>
          <strong>{graph.plannedCount}</strong> planned
        </span>
        <span>
          <strong>{graph.observedCount}</strong> observed
        </span>
      </div>
      <ol className="work-graph-tree" aria-label={`Work graph for ${graph.title}`}>
        {graph.nodes.map((node) => {
          const statusLabel = STATUS_LABELS[node.status];
          const accessibleLabel = `${node.label}, ${sourceLabel(node)}, ${statusLabel}`;
          return (
            <li
              key={node.id}
              className={`work-graph-node source-${node.source} depth-${node.depth} status-${node.status}`}
              aria-label={accessibleLabel}
            >
              <span className="work-graph-marker" aria-hidden="true">
                {nodeMarker(node)}
              </span>
              <span className="work-graph-node-copy">
                <strong>{node.label}</strong>
                {node.detail && <small>{node.detail}</small>}
              </span>
              <span className="work-graph-status">{statusLabel}</span>
            </li>
          );
        })}
      </ol>
      <p className="work-graph-disclaimer">
        Relationships are intentionally approximate in beta. Plan steps are not matched to hidden
        provider reasoning; observed rows come from normalized events only.
      </p>
    </div>
  );
}
