import React, { useEffect, useRef, useState } from "react";
import type { ThreadMetadata } from "../../types";
import { Icon } from "../../components/icon";
import { providerListLabel } from "../../lib/provider-readiness";
import { OverlayDialog } from "./overlay-dialog";

const THREAD_SEARCH_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export const THREAD_SEARCH_INPUT_DEBOUNCE_MS = 150;

export function scheduleThreadSearchRequest(
  callback: () => void,
  delayMs: number,
  timers: Pick<typeof window, "setTimeout" | "clearTimeout"> = window,
): () => void {
  const handle = timers.setTimeout(callback, delayMs);
  return () => timers.clearTimeout(handle);
}

export function threadSearchDetail(
  thread: ThreadMetadata,
  formatDate: (date: Date) => string = (date) => THREAD_SEARCH_DATE_FORMAT.format(date),
): string {
  const provider = thread.provider ? providerListLabel(thread.provider) : null;
  const state = thread.archivedAt ? "Archived" : thread.pinnedAt ? "Pinned" : null;
  const updatedAt = new Date(thread.updatedAt);
  const updated = Number.isFinite(updatedAt.getTime())
    ? `Updated ${formatDate(updatedAt)}`
    : "Updated time unknown";
  return [thread.projectName, provider, state, updated, thread.worktree]
    .filter(Boolean)
    .join(" · ");
}

export function threadSearchCollisionLabels(
  threads: ThreadMetadata[],
  detailFor: (thread: ThreadMetadata) => string = threadSearchDetail,
): Map<string, string> {
  const groups = new Map<string, ThreadMetadata[]>();
  for (const thread of threads) {
    const key = `${thread.title}\u0000${detailFor(thread)}`;
    groups.set(key, [...(groups.get(key) ?? []), thread]);
  }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.forEach((thread, index) => {
      labels.set(thread.id, `Match ${index + 1} of ${group.length}`);
    });
  }
  return labels;
}

export function nextThreadSearchIndex(
  current: number,
  resultCount: number,
  direction: "next" | "previous",
): number {
  if (resultCount <= 0) return 0;
  return direction === "next"
    ? (current + 1) % resultCount
    : (current - 1 + resultCount) % resultCount;
}

export function clampThreadSearchIndex(current: number, resultCount: number): number {
  if (resultCount <= 0) return 0;
  return Math.min(current, resultCount - 1);
}

export function threadSearchActiveDescendant(
  activeIndex: number,
  resultCount: number,
): string | undefined {
  return resultCount > 0 ? `thread-search-result-${activeIndex}` : undefined;
}

export function activeThreadSearchResult(
  results: ThreadMetadata[],
  activeIndex: number,
  loading: boolean,
): ThreadMetadata | undefined {
  return loading ? undefined : results[activeIndex];
}

export function ThreadSearchDialog({
  open,
  threads,
  onClose,
  onSelect,
}: {
  open: boolean;
  threads: ThreadMetadata[];
  onClose: () => void;
  /** Open a search hit in the workbench (required for results to do anything). */
  onSelect: (threadId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<"exclude" | "include" | "only">("exclude");
  const [results, setResults] = useState<ThreadMetadata[]>(threads);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    const cancelSchedule = scheduleThreadSearchRequest(
      () => {
        void fetch("/api/state/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, archived }),
          signal: controller.signal,
        })
          .then((response) => response.json())
          .then((body: { threads?: ThreadMetadata[] }) => {
            if (controller.signal.aborted) return;
            setResults(body.threads ?? []);
            setLoading(false);
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            setResults([]);
            setLoading(false);
          });
      },
      query ? THREAD_SEARCH_INPUT_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelSchedule();
      controller.abort();
    };
  }, [archived, open, query]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const focusInput = () => inputRef.current?.focus();
    // Dialog focus trap may land on Close; re-claim the search field (same as command palette).
    focusInput();
    const frame = window.requestAnimationFrame(focusInput);
    const timer = window.setTimeout(focusInput, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open]);
  useEffect(() => {
    setActiveIndex((current) => clampThreadSearchIndex(current, results.length));
  }, [results.length]);
  useEffect(() => {
    if (loading) return;
    const activeId = threadSearchActiveDescendant(activeIndex, results.length);
    if (!activeId) return;
    resultsRef.current
      ?.querySelector<HTMLElement>(`#${activeId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, loading, results.length]);
  if (!open) return null;
  const collisionLabels = threadSearchCollisionLabels(results);
  const selectResult = (index: number) => {
    const thread = activeThreadSearchResult(results, index, loading);
    if (!thread) return;
    onSelect(thread.id);
    onClose();
  };
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        nextThreadSearchIndex(
          current,
          results.length,
          event.key === "ArrowDown" ? "next" : "previous",
        ),
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectResult(activeIndex);
    }
  };
  return (
    <OverlayDialog title="Search local conversations" onClose={onClose}>
      <label className="quick-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          id="thread-search-query"
          name="thread-search-query"
          data-dialog-initial-focus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResults([]);
            setActiveIndex(0);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Title, project, or worktree"
          aria-label="Search conversations by title, project, or worktree"
          aria-controls="thread-search-results"
          aria-describedby={loading || results.length === 0 ? "thread-search-status" : undefined}
          aria-activedescendant={
            loading ? undefined : threadSearchActiveDescendant(activeIndex, results.length)
          }
        />
      </label>
      <div className="thread-search-controls">
        <label className="search-scope">
          Archived conversations{" "}
          <select
            id="thread-search-archived"
            name="thread-search-archived"
            value={archived}
            onChange={(event) => {
              setArchived(event.target.value as typeof archived);
              setResults([]);
              setActiveIndex(0);
            }}
          >
            <option value="exclude">Exclude</option>
            <option value="include">Include</option>
            <option value="only">Only archived</option>
          </select>
        </label>
        <p className="search-scope">
          Search is limited to 50 local metadata matches. Messages, provider output, and repository
          contents are excluded.
        </p>
      </div>
      {loading && (
        <p id="thread-search-status" className="quick-results-empty" role="status">
          Searching conversations…
        </p>
      )}
      {!loading && results.length === 0 && (
        <p id="thread-search-status" className="quick-results-empty" role="status">
          No matching conversations.
        </p>
      )}
      <div
        ref={resultsRef}
        className="quick-results"
        id="thread-search-results"
        role="listbox"
        aria-label="Matching conversations"
      >
        {results.map((thread, index) => {
          const detail = threadSearchDetail(thread);
          const collisionLabel = collisionLabels.get(thread.id);
          const disambiguatedDetail = [detail, collisionLabel].filter(Boolean).join(" · ");
          return (
            <button
              type="button"
              role="option"
              id={`thread-search-result-${index}`}
              key={thread.id}
              tabIndex={-1}
              aria-selected={index === activeIndex}
              aria-label={`${thread.title}: ${disambiguatedDetail}`}
              title={`${thread.title} · ${disambiguatedDetail}`}
              className={index === activeIndex ? "active" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectResult(index)}
            >
              <strong title={thread.title}>{thread.title}</strong>
              <small title={disambiguatedDetail}>{disambiguatedDetail}</small>
            </button>
          );
        })}
      </div>
    </OverlayDialog>
  );
}
