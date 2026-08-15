import React, { useEffect, useMemo, useState } from "react";
import type { ConversationSummary, ThreadStatus } from "../../types";
import { Button } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { formatElapsed, loadConversationList } from "../code/conversation-list";
import { OverlayDialog } from "./overlay-dialog";

export type ActivityBucket = "attention" | "running" | "completed" | "idle";
export type ActivityFilter = "all" | ActivityBucket;
export type ActivitySelectionAction = "open" | "review_changes";
export const MAX_ACTIVITY_ROWS = 100;

export const ACTIVITY_FILTERS: ActivityFilter[] = [
  "all",
  "attention",
  "running",
  "completed",
  "idle",
];

export function activityBucket(conversation: ConversationSummary): ActivityBucket {
  // Settle is the operator's done signal. A last-turn failure must not keep the
  // row in Attention after the sidebar has already moved it to Settled.
  if (conversation.settledAt) return "completed";
  const status = conversation.status ?? "idle";
  if (status === "pending_approval" || status === "awaiting_input" || status === "failed") {
    return "attention";
  }
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  return "idle";
}

export function activityCounts(
  conversations: ConversationSummary[],
): Record<ActivityBucket, number> {
  return conversations.reduce(
    (counts, conversation) => {
      const bucket = activityBucket(conversation);
      counts[bucket] += 1;
      return counts;
    },
    { attention: 0, running: 0, completed: 0, idle: 0 },
  );
}

export function activityFilterLabel(filter: ActivityFilter): string {
  switch (filter) {
    case "all":
      return "All";
    case "attention":
      return "Attention";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "idle":
      return "Idle";
  }
}

export function activityFilterCount(
  conversations: ConversationSummary[],
  filter: ActivityFilter,
): number {
  return filter === "all"
    ? conversations.length
    : conversations.filter((conversation) => activityBucket(conversation) === filter).length;
}

export function filterActivity(
  conversations: ConversationSummary[],
  filter: ActivityFilter,
): ConversationSummary[] {
  if (filter === "all") return [...conversations];
  return conversations.filter((conversation) => activityBucket(conversation) === filter);
}

export function activityStatusLabel(
  status: ThreadStatus | undefined,
  settledAt?: string | null,
): string {
  if (settledAt || status === "completed") return "Completed";
  switch (status) {
    case "pending_approval":
      return "Approval needed";
    case "awaiting_input":
      return "Input needed";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    default:
      return "Idle";
  }
}

export function activityNextActionLabel(conversation: ConversationSummary): string {
  if (conversation.settledAt) return "Review outcome";
  switch (conversation.status) {
    case "pending_approval":
      return "Resolve approval";
    case "awaiting_input":
      return "Answer input";
    case "running":
      return "Monitor run";
    case "failed":
      return "Inspect failure";
    case "completed":
      return "Review outcome";
    default:
      return "Resume conversation";
  }
}

export function activityWorktreeLabel(worktree: string): string {
  const normalized = worktree.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) ?? "selected worktree";
}

const ACTIVITY_ORDER: Record<ActivityBucket, number> = {
  attention: 0,
  running: 1,
  idle: 2,
  completed: 3,
};

function compareActivity(left: ConversationSummary, right: ConversationSummary): number {
  return (
    ACTIVITY_ORDER[activityBucket(left)] - ACTIVITY_ORDER[activityBucket(right)] ||
    (right.statusSince ?? right.updatedAt).localeCompare(left.statusSince ?? left.updatedAt) ||
    right.id.localeCompare(left.id)
  );
}

export function sortActivity(conversations: ConversationSummary[]): ConversationSummary[] {
  return [...conversations].sort(compareActivity);
}

export function selectActivityRows(
  conversations: readonly ConversationSummary[],
  filter: ActivityFilter,
  limit = MAX_ACTIVITY_ROWS,
): { rows: ConversationSummary[]; total: number } {
  const capacity = Number.isFinite(limit)
    ? Math.max(0, Math.min(MAX_ACTIVITY_ROWS, Math.floor(limit)))
    : MAX_ACTIVITY_ROWS;
  const heap: ConversationSummary[] = [];
  let total = 0;

  const siftUp = (start: number) => {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareActivity(heap[parent]!, heap[index]!) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  };
  const siftDown = () => {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const worse =
        right < heap.length && compareActivity(heap[right]!, heap[left]!) > 0 ? right : left;
      if (compareActivity(heap[index]!, heap[worse]!) >= 0) break;
      [heap[index], heap[worse]] = [heap[worse]!, heap[index]!];
      index = worse;
    }
  };

  for (const conversation of conversations) {
    if (filter !== "all" && activityBucket(conversation) !== filter) continue;
    total += 1;
    if (capacity === 0) continue;
    if (heap.length < capacity) {
      heap.push(conversation);
      siftUp(heap.length - 1);
    } else if (compareActivity(conversation, heap[0]!) < 0) {
      heap[0] = conversation;
      siftDown();
    }
  }

  return { rows: heap.sort(compareActivity), total };
}

export function ActivityDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (conversation: ConversationSummary, action: ActivitySelectionAction) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filter, setFilter] = useState<ActivityFilter>("all");

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
        if (active)
          setError(cause instanceof Error ? cause.message : "Activity could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, refreshKey]);

  const counts = useMemo(() => activityCounts(conversations), [conversations]);
  const visible = useMemo(() => selectActivityRows(conversations, filter), [conversations, filter]);
  const select = (conversation: ConversationSummary, action: ActivitySelectionAction) => {
    onSelect(conversation, action);
    onClose();
  };
  if (!open) return null;

  return (
    <OverlayDialog title="Activity" onClose={onClose}>
      <div className="activity-dialog">
        <header className="activity-header">
          <p>Cross-project supervision from the existing local conversation/status projection.</p>
          <Button
            type="button"
            size="sm"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </header>
        <div className="activity-filters" role="toolbar" aria-label="Filter activity">
          {ACTIVITY_FILTERS.map((item) => {
            const count = item === "all" ? conversations.length : counts[item];
            return (
              <button
                key={item}
                type="button"
                className={`activity-filter ${item}`}
                aria-pressed={filter === item}
                onClick={() => setFilter(item)}
              >
                <strong>{count}</strong> {activityFilterLabel(item)}
              </button>
            );
          })}
        </div>
        {loading && (
          <p className="activity-note" role="status">
            Reading local activity…
          </p>
        )}
        {error && (
          <p className="activity-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && visible.rows.length === 0 && (
          <p className="activity-note">
            {filter === "all"
              ? "No conversations are available to supervise."
              : `No ${activityFilterLabel(filter).toLowerCase()} conversations are available.`}
          </p>
        )}
        {!loading && !error && visible.rows.length > 0 && (
          <>
            {visible.total > visible.rows.length && (
              <p className="activity-note" role="status">
                Showing the first {visible.rows.length} of {visible.total} matching conversations.
              </p>
            )}
            <ul className="activity-list" aria-label="Conversation activity">
              {visible.rows.map((conversation) => {
                const status = activityStatusLabel(conversation.status, conversation.settledAt);
                const bucket = activityBucket(conversation);
                return (
                  <li key={conversation.id} className="activity-item">
                    <div className="activity-row">
                      <span className={`activity-status ${bucket}`} aria-hidden="true">
                        {status}
                      </span>
                      <span className="activity-copy">
                        <strong>{conversation.title || "Untitled conversation"}</strong>
                        <small>
                          {conversation.projectName ?? "Unknown project"}
                          {" · "}
                          {providerListLabel(conversation.provider)}
                          {" · "}
                          {activityWorktreeLabel(conversation.worktree)}
                        </small>
                        <span className="activity-next-action">
                          Next: {activityNextActionLabel(conversation)} ·{" "}
                          {formatElapsed(conversation.statusSince ?? conversation.updatedAt)}
                        </span>
                      </span>
                      <span className="activity-actions">
                        <Button
                          type="button"
                          size="xs"
                          variant={bucket === "attention" ? "primary" : "default"}
                          onClick={() => select(conversation, "open")}
                          aria-label={`Open conversation ${conversation.title || "Untitled conversation"}: ${status}`}
                        >
                          Open
                        </Button>
                        {conversation.worktree.trim() && (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => select(conversation, "review_changes")}
                            aria-label={`Review changes for ${conversation.title || "Untitled conversation"}`}
                          >
                            Review changes
                          </Button>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </OverlayDialog>
  );
}
