import React, { useEffect, useRef, useState } from "react";
import type { ThreadMetadata } from "../../types";
import { Icon } from "../../components/icon";
import { OverlayDialog } from "./overlay-dialog";

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
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/state/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, archived }),
      signal: controller.signal,
    }).then((response) => response.json()).then((body: { threads?: ThreadMetadata[] }) => setResults(body.threads ?? []));
    return () => controller.abort();
  }, [archived, open, query]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
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
  if (!open) return null;
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
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, project, or worktree"
          aria-label="Search conversations by title, project, or worktree"
        />
      </label>
      <label className="search-scope">
        Archived conversations{" "}
        <select
          id="thread-search-archived"
          name="thread-search-archived"
          value={archived}
          onChange={(event) => setArchived(event.target.value as typeof archived)}
        >
          <option value="exclude">Exclude</option>
          <option value="include">Include</option>
          <option value="only">Only archived</option>
        </select>
      </label>
      <p className="search-scope">Search is limited to 50 local metadata matches. Messages, provider output, and repository contents are excluded.</p>
      <div className="quick-results" role="listbox" aria-label="Matching conversations">
        {results.map((thread) => (
          <button
            type="button"
            role="option"
            key={thread.id}
            aria-label={`${thread.title}: ${thread.projectName} · ${thread.worktree}`}
            onClick={() => {
              onSelect(thread.id);
              onClose();
            }}
          >
            <strong>{thread.title}</strong>
            <small>{thread.projectName} · {thread.worktree}</small>
          </button>
        ))}
        {results.length === 0 && <p>No matching conversations.</p>}
      </div>
    </OverlayDialog>
  );
}


