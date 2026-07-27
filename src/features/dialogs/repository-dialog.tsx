import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { DirectoryListing } from "../../types";
import {
  getAddProjectInitialQuery,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isFilesystemBrowseQuery,
} from "../../lib/project-paths";
import { Button, ModalSurface } from "../../components/ui";

export interface SavedProject {
  id: string;
  name: string;
  root: string;
  openedAt: string;
  /** All project record ids that collapse into this chip (main + worktrees). */
  memberIds?: string[];
}

/**
 * T3-aligned project switcher:
 * - recent/saved projects first
 * - type a path (`~/…`) with directory completion
 * - Enter opens; directory rows navigate
 */
export function RepositoryDialog({
  open,
  busy,
  error,
  projects,
  currentRoot,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  projects: SavedProject[];
  currentRoot: string | null;
  onClose: () => void;
  onSubmit: (path: string) => void;
}) {
  const [query, setQuery] = useState(getAddProjectInitialQuery());
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const browseController = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const browsing = isFilesystemBrowseQuery(query);
  const browseDirectory = browsing ? getBrowseDirectoryPath(query) : "";
  const leafFilter = browsing ? getBrowseLeafPathSegment(query) : query.trim();

  const browse = async (directoryPath: string) => {
    browseController.current?.abort();
    const controller = new AbortController();
    browseController.current = controller;
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      const response = await fetch("/api/directories/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: directoryPath, includeHidden: leafFilter.startsWith(".") }),
        signal: controller.signal,
      });
      const body = await response.json() as DirectoryListing | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body ? body.error : "Directories could not be listed.");
      }
      setListing(body as DirectoryListing);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setListing(null);
      setBrowseError(cause instanceof Error ? cause.message : "Directories could not be listed.");
    } finally {
      if (browseController.current === controller) setBrowseBusy(false);
    }
  };

  useEffect(() => {
    if (!open) {
      browseController.current?.abort();
      return;
    }
    setQuery(getAddProjectInitialQuery());
    setListing(null);
    setBrowseError(null);
    setActiveIndex(0);
    const focus = () => inputRef.current?.focus();
    focus();
    const frame = window.requestAnimationFrame(focus);
    return () => {
      window.cancelAnimationFrame(frame);
      browseController.current?.abort();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !browsing) {
      setListing(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void browse(browseDirectory || getAddProjectInitialQuery());
    }, 80);
    return () => window.clearTimeout(handle);
    // leafFilter only affects hidden visibility / client filter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, browsing, browseDirectory, leafFilter.startsWith(".")]);

  const filteredProjects = useMemo(() => {
    const needle = (!browsing ? query : leafFilter).trim().toLocaleLowerCase();
    const sorted = [...projects].sort(
      (left, right) => right.openedAt.localeCompare(left.openedAt) || left.name.localeCompare(right.name),
    );
    if (!needle || browsing) {
      // When path-browsing, still show matching recent projects under the typed prefix.
      if (browsing && query.trim().length > 0) {
        const prefix = query.trim().replace(/[\\/]+$/, "").toLocaleLowerCase();
        return sorted.filter((project) =>
          project.root.toLocaleLowerCase().startsWith(prefix)
          || project.name.toLocaleLowerCase().includes(needle),
        ).slice(0, 8);
      }
      return sorted.slice(0, 12);
    }
    return sorted.filter((project) =>
      project.name.toLocaleLowerCase().includes(needle)
      || project.root.toLocaleLowerCase().includes(needle),
    ).slice(0, 12);
  }, [browsing, leafFilter, projects, query]);

  const directoryRows = useMemo(() => {
    if (!browsing || !listing) return [] as Array<{ name: string; path: string }>;
    const filter = leafFilter.toLocaleLowerCase();
    const showHidden = leafFilter.startsWith(".");
    return listing.entries
      .filter((entry) => {
        if (!showHidden && entry.hidden) return false;
        if (!filter) return true;
        return entry.name.toLocaleLowerCase().startsWith(filter);
      })
      .slice(0, 40)
      .map((entry) => ({ name: entry.name, path: entry.path }));
  }, [browsing, leafFilter, listing]);

  const parentPath = browsing ? getBrowseParentPath(query) : null;

  type Row =
    | { kind: "project"; id: string; name: string; root: string }
    | { kind: "parent"; path: string }
    | { kind: "directory"; name: string; path: string }
    | { kind: "open-path"; path: string; label: string };

  const rows: Row[] = useMemo(() => {
    const next: Row[] = [];
    for (const project of filteredProjects) {
      next.push({ kind: "project", id: project.id, name: project.name, root: project.root });
    }
    if (browsing && parentPath) {
      next.push({ kind: "parent", path: parentPath });
    }
    for (const entry of directoryRows) {
      next.push({ kind: "directory", name: entry.name, path: entry.path });
    }
    if (browsing && query.trim().length > 0) {
      const openPath = hasTrailingPathSeparator(query)
        ? query.trim()
        : (directoryRows.find((entry) => entry.name === leafFilter)?.path ?? query.trim());
      const alreadyRecent = filteredProjects.some((project) => project.root === openPath);
      if (!alreadyRecent) {
        next.push({
          kind: "open-path",
          path: openPath,
          label: `Open ${inferProjectTitleFromPath(openPath)}`,
        });
      }
    }
    return next;
  }, [browsing, directoryRows, filteredProjects, leafFilter, parentPath, query]);

  useEffect(() => {
    setActiveIndex((index) => {
      if (rows.length === 0) return 0;
      return Math.min(index, rows.length - 1);
    });
  }, [rows.length]);

  if (!open) return null;

  const activate = (row: Row) => {
    if (row.kind === "project") {
      onSubmit(row.root);
      return;
    }
    if (row.kind === "parent") {
      const parent = row.path.endsWith("/") || row.path.endsWith("\\") ? row.path : `${row.path}/`;
      setQuery(parent);
      setActiveIndex(0);
      return;
    }
    if (row.kind === "directory") {
      // Prefer the absolute browse path so completion stays accurate after navigation.
      const next = row.path.endsWith("/") || row.path.endsWith("\\") ? row.path : `${row.path}/`;
      setQuery(next);
      setActiveIndex(0);
      return;
    }
    onSubmit(row.path);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBrowseError(null);
    if (rows[activeIndex]) {
      activate(rows[activeIndex]);
      return;
    }
    const path = query.trim();
    if (path) onSubmit(path);
  };

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      dismissible={!busy}
      className="repository-dialog project-switcher-dialog"
      ariaLabelledBy="repository-dialog-title"
    >
      <p className="eyebrow">Projects</p>
      <h2 id="repository-dialog-title">Add a project</h2>
      <p>
        Register a local git repository once. After that, use the project chips in the sidebar and
        start new threads without picking a path again. Type <kbd>~/</kbd> for path completion.
      </p>

      <form onSubmit={submit} className="project-switcher-form">
        <label htmlFor="project-path-query" className="sr-only">Project path or filter</label>
        <div className="project-switcher-input-row">
          <input
            id="project-path-query"
            name="project-path-query"
            ref={inputRef}
            data-dialog-initial-focus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (rows.length === 0) return;
                setActiveIndex((index) => (index + 1) % rows.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                if (rows.length === 0) return;
                setActiveIndex((index) => (index - 1 + rows.length) % rows.length);
                return;
              }
              if (event.key === "Backspace" && query === "" && parentPath) {
                event.preventDefault();
                setQuery(parentPath);
              }
            }}
            placeholder="~/Projects/… or filter recent projects"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
          />
          {window.aldunisDesktop && (
            <Button
              type="button"
              size="sm"
              disabled={busy || pickerBusy}
              onClick={() => {
                setPickerBusy(true);
                setBrowseError(null);
                void window.aldunisDesktop?.chooseDirectory()
                  .then((selected) => {
                    if (selected) onSubmit(selected);
                  })
                  .catch(() => setBrowseError("The system folder picker could not be opened."))
                  .finally(() => setPickerBusy(false));
              }}
            >
              {pickerBusy ? "…" : "Browse…"}
            </Button>
          )}
        </div>

        <div className="project-switcher-results" role="listbox" aria-label="Projects and directories" aria-busy={browseBusy}>
          {rows.length === 0 && !browseBusy && (
            <p className="project-switcher-empty">
              {browsing
                ? "No matching directories. Keep typing a path, or open the path with Enter."
                : projects.length === 0
                ? "No saved projects yet. Type ~/ to browse, then Enter to open a git repository."
                : "No projects match that filter."}
            </p>
          )}
          {rows.map((row, index) => {
            const active = index === activeIndex;
            if (row.kind === "project") {
              return (
                <button
                  type="button"
                  key={`project:${row.id}`}
                  role="option"
                  aria-selected={active}
                  aria-label={`${row.name}: ${row.root}${row.root === currentRoot ? ", current" : ""}`}
                  className={`project-switcher-row ${active ? "active" : ""} ${row.root === currentRoot ? "current" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(row)}
                  disabled={busy}
                >
                  <span className="project-switcher-icon" aria-hidden="true">◫</span>
                  <span className="project-switcher-text">
                    <strong>{row.name}</strong>
                    <small>{row.root}</small>
                  </span>
                  {row.root === currentRoot && <span className="project-switcher-badge">Current</span>}
                </button>
              );
            }
            if (row.kind === "parent") {
              return (
                <button
                  type="button"
                  key="parent"
                  role="option"
                  aria-selected={active}
                  aria-label={`Parent directory: ${row.path}`}
                  className={`project-switcher-row ${active ? "active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(row)}
                  disabled={busy}
                >
                  <span className="project-switcher-icon" aria-hidden="true">↰</span>
                  <span className="project-switcher-text">
                    <strong>Parent directory</strong>
                    <small>{row.path}</small>
                  </span>
                </button>
              );
            }
            if (row.kind === "directory") {
              return (
                <button
                  type="button"
                  key={`dir:${row.path}`}
                  role="option"
                  aria-selected={active}
                  aria-label={`${row.name}: Open folder`}
                  className={`project-switcher-row ${active ? "active" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => activate(row)}
                  disabled={busy}
                >
                  <span className="project-switcher-icon" aria-hidden="true">▸</span>
                  <span className="project-switcher-text">
                    <strong>{row.name}</strong>
                    <small>Open folder</small>
                  </span>
                </button>
              );
            }
            return (
              <button
                type="button"
                key={`open:${row.path}`}
                role="option"
                aria-selected={active}
                aria-label={`${row.label}: ${row.path}`}
                className={`project-switcher-row ${active ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => activate(row)}
                disabled={busy}
              >
                <span className="project-switcher-icon" aria-hidden="true">＋</span>
                <span className="project-switcher-text">
                  <strong>{row.label}</strong>
                  <small>{row.path}</small>
                </span>
              </button>
            );
          })}
          {browseBusy && <p className="project-switcher-empty" role="status">Listing directories…</p>}
        </div>

        {(browseError || error) && (
          <div className="repository-error" role="alert">{browseError ?? error}</div>
        )}

        <footer>
          <Button type="button" onClick={onClose} disabled={busy} aria-label="Cancel open project">Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || (!query.trim() && !rows[activeIndex])}
            aria-label={busy ? "Opening project" : "Open project"}
          >
            {busy ? "Opening…" : "Open project"}
          </Button>
        </footer>
      </form>
    </ModalSurface>
  );
}
