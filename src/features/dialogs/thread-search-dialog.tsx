import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ThreadMetadata } from "../../types";
import { Icon } from "../../components/icon";
import { OverlayDialog } from "./overlay-dialog";

export function ThreadSearchDialog({ open, threads, onClose }: { open: boolean; threads: ThreadMetadata[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<"exclude" | "include" | "only">("exclude");
  const [results, setResults] = useState<ThreadMetadata[]>(threads);
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
  if (!open) return null;
  return (
    <OverlayDialog title="Search local conversations" onClose={onClose}>
      <label className="quick-search"><Icon name="search" /><input data-dialog-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, project, or worktree" /></label>
      <label className="search-scope">
        Archived conversations{" "}
        <select value={archived} onChange={(event) => setArchived(event.target.value as typeof archived)}>
          <option value="exclude">Exclude</option>
          <option value="include">Include</option>
          <option value="only">Only archived</option>
        </select>
      </label>
      <p className="search-scope">Search is limited to 50 local metadata matches. Messages, provider output, and repository contents are excluded.</p>
      <div className="quick-results">
        {results.map((thread) => <button key={thread.id}><strong>{thread.title}</strong><small>{thread.projectName} · {thread.worktree}</small></button>)}
        {results.length === 0 && <p>No matching conversations.</p>}
      </div>
    </OverlayDialog>
  );
}


