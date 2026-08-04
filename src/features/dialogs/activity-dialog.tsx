import React, { useEffect, useMemo, useState } from "react";
import type { ConversationSummary, ThreadStatus } from "../../types";
import { Button } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { formatElapsed, loadConversationList } from "../code/conversation-list";
import { OverlayDialog } from "./overlay-dialog";

export type ActivityBucket = "attention" | "running" | "completed" | "idle";

export function activityBucket(conversation: ConversationSummary): ActivityBucket {
  const status = conversation.status ?? "idle";
  if (status === "pending_approval" || status === "awaiting_input" || status === "failed") {
    return "attention";
  }
  if (status === "running") return "running";
  if (status === "completed" || conversation.settledAt) return "completed";
  return "idle";
}

export function activityCounts(conversations: ConversationSummary[]): Record<ActivityBucket, number> {
  return conversations.reduce((counts, conversation) => {
    const bucket = activityBucket(conversation);
    counts[bucket] += 1;
    return counts;
  }, { attention: 0, running: 0, completed: 0, idle: 0 });
}

export function activityStatusLabel(status: ThreadStatus | undefined, settledAt?: string | null): string {
  if (settledAt || status === "completed") return "Completed";
  switch (status) {
    case "pending_approval": return "Approval needed";
    case "awaiting_input": return "Input needed";
    case "running": return "Running";
    case "failed": return "Failed";
    default: return "Idle";
  }
}

const ACTIVITY_ORDER: Record<ActivityBucket, number> = {
  attention: 0,
  running: 1,
  idle: 2,
  completed: 3,
};

export function sortActivity(conversations: ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort((left, right) => (
    ACTIVITY_ORDER[activityBucket(left)] - ACTIVITY_ORDER[activityBucket(right)]
      || (right.statusSince ?? right.updatedAt).localeCompare(left.statusSince ?? left.updatedAt)
      || right.id.localeCompare(left.id)
  ));
}

export function ActivityDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (conversation: ConversationSummary) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void loadConversationList(null, { fresh: true })
      .then((next) => {
        if (active) setConversations(next);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Activity could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open, refreshKey]);

  const counts = useMemo(() => activityCounts(conversations), [conversations]);
  const ordered = useMemo(() => sortActivity(conversations), [conversations]);
  if (!open) return null;

  return (
    <OverlayDialog title="Activity" onClose={onClose}>
      <div className="activity-dialog">
        <header className="activity-header">
          <p>Cross-project supervision from the existing local conversation/status projection.</p>
          <Button type="button" size="sm" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </header>
        <div className="activity-counts" aria-label="Activity counts">
          <span className="attention"><strong>{counts.attention}</strong> attention</span>
          <span className="running"><strong>{counts.running}</strong> running</span>
          <span className="completed"><strong>{counts.completed}</strong> completed</span>
          <span><strong>{counts.idle}</strong> idle</span>
        </div>
        {loading && <p className="activity-note" role="status">Reading local activity…</p>}
        {error && <p className="activity-error" role="alert">{error}</p>}
        {!loading && !error && ordered.length === 0 && (
          <p className="activity-note">No conversations are available to supervise.</p>
        )}
        {!loading && !error && ordered.length > 0 && (
          <ul className="activity-list" aria-label="Conversation activity">
            {ordered.map((conversation) => {
              const status = activityStatusLabel(conversation.status, conversation.settledAt);
              const bucket = activityBucket(conversation);
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className="activity-row"
                    onClick={() => {
                      onSelect(conversation);
                      onClose();
                    }}
                    aria-label={`${conversation.title || "Untitled conversation"}: ${status} · ${conversation.projectName ?? "Unknown project"}`}
                  >
                    <span className={`activity-status ${bucket}`} aria-hidden="true">{status}</span>
                    <span className="activity-copy">
                      <strong>{conversation.title || "Untitled conversation"}</strong>
                      <small>{conversation.projectName ?? "Unknown project"} · {providerListLabel(conversation.provider)} · {formatElapsed(conversation.statusSince ?? conversation.updatedAt)}</small>
                    </span>
                    <span className="activity-chevron" aria-hidden="true">→</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </OverlayDialog>
  );
}
