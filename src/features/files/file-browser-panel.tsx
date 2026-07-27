import React, { useEffect, useRef, useState } from "react";
import type { RepositoryFileResult, RepositoryFilePreview, RepositoryMetadata } from "../../types";
import { CloseButton } from "../../components/ui";
import { Icon } from "../../components/icon";

export function FileBrowserPanel({
  repository,
  attached,
  maxAttachments,
  onAttach,
  onClose,
}: {
  repository: RepositoryMetadata;
  attached: string[];
  maxAttachments: number;
  onAttach: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<RepositoryFileResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepositoryFilePreview | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetch("/api/context/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          query,
        }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json() as {
          files?: RepositoryFileResult[];
          truncated?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? "Worktree files could not be searched.");
        const next = body.files ?? [];
        setFiles(next);
        setTruncated(body.truncated ?? false);
        setSelected((current) => next.some(({ path }) => path === current) ? current : next[0]?.path ?? null);
      }).catch((cause) => {
        if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, repository.root, repository.selectedWorktree]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    void fetch("/api/context/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        path: selected,
      }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { preview?: RepositoryFilePreview; error?: string };
      if (!response.ok || !body.preview) throw new Error(body.error ?? "The selected file could not be previewed.");
      setPreview(body.preview);
    }).catch((cause) => {
      if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message);
    });
    return () => controller.abort();
  }, [repository.root, repository.selectedWorktree, selected]);

  useEffect(() => {
    // Capture phase so ⌘K focuses this search instead of opening the command palette
    // while the file browser is open (both claim mod+k).
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k" && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        // Overlay dialogs (command palette, etc.) must dismiss first.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [onClose]);

  const selectedIndex = files.findIndex(({ path }) => path === selected);
  return (
    <section className="file-browser-panel" aria-label="Browse active worktree">
      <header>
        <div><p className="eyebrow">Bounded local context</p><h2>Browse active worktree</h2></div>
        <CloseButton onClick={onClose} label="Close file browser" />
      </header>
      <div className="file-browser-policy">
        Hidden, ignored, secret-like, and generated ignored files are excluded. Search is local, capped, and not indexed.
      </div>
      <label className="file-search">
        <Icon name="search" />
        <span className="sr-only">Search file names and text content</span>
        <input
          ref={searchRef}
          id="file-browser-search"
          name="file-browser-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file names and supported text content"
          aria-keyshortcuts="Meta+K Control+K"
        />
        <kbd aria-hidden="true">⌘ K</kbd>
      </label>
      <div className="file-browser-body">
        <nav
          aria-label="Worktree files"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!files.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0
              : event.key === "End" ? files.length - 1
              : event.key === "ArrowDown" ? Math.min(files.length - 1, selectedIndex + 1)
              : Math.max(0, selectedIndex - 1);
            setSelected(files[next].path);
          }}
        >
          {loading && <p className="file-browser-note">Searching active worktree…</p>}
          {!loading && files.length === 0 && <p className="file-browser-note">No supported files match this search.</p>}
          {files.map((file) => (
            <button
              className={selected === file.path ? "active" : ""}
              key={file.path}
              onClick={() => setSelected(file.path)}
              aria-current={selected === file.path ? "true" : undefined}
            >
              <strong>{file.path}</strong>
              <small>{file.match ? `${file.match} match · ` : ""}{file.kind}{file.size === null ? "" : ` · ${file.size.toLocaleString()} B`}</small>
            </button>
          ))}
          {truncated && <p className="file-browser-note">Results are capped. Refine the search to find more.</p>}
        </nav>
        <article className="file-preview" tabIndex={0}>
          {!selected && <div className="file-preview-state">Select a file to preview it.</div>}
          {selected && !preview && !error && <div className="file-preview-state">Loading bounded preview…</div>}
          {preview && (
            <>
              <header>
                <div><strong>{preview.path}</strong><small>{preview.encoding} · {preview.size?.toLocaleString() ?? "unknown"} B</small></div>
                <button
                  onClick={() => onAttach(preview.path)}
                  disabled={attached.includes(preview.path) || attached.length >= maxAttachments || !preview.attachable}
                >
                  {attached.includes(preview.path) ? "Attached" : "Attach to composer"}
                </button>
              </header>
              {preview.message && <p className="file-preview-message">{preview.message}</p>}
              {preview.imageData
                ? <img src={preview.imageData} alt={`Preview of ${preview.path}`} />
                : preview.content !== null
                ? <pre>{preview.content}</pre>
                : <div className="file-preview-state">Preview unavailable for this file type.</div>}
            </>
          )}
          {error && <div className="file-browser-error" role="alert">{error}</div>}
        </article>
      </div>
    </section>
  );
}


