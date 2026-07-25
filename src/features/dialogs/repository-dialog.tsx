import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { DirectoryListing } from "../../types";
import { Button, ModalSurface } from "../../components/ui";

export function RepositoryDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const browseController = useRef<AbortController | null>(null);
  const browse = async (nextPath?: string, hidden = includeHidden) => {
    browseController.current?.abort();
    const controller = new AbortController();
    browseController.current = controller;
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      const response = await fetch("/api/directories/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(nextPath ? { path: nextPath } : {}),
          includeHidden: hidden,
        }),
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
    setPath("");
    setListing(null);
    setIncludeHidden(false);
    void browse(undefined, false);
    return () => browseController.current?.abort();
  }, [open]);
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBrowseError(null);
    onSubmit(path);
  };
  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      dismissible={!busy}
      className="repository-dialog"
      ariaLabelledBy="repository-dialog-title"
    >
        <p className="eyebrow">Local access</p>
        <h2 id="repository-dialog-title">Open a repository</h2>
        <p>Choose a local directory or enter an absolute path. Every selection is canonicalized and validated before the active repository changes.</p>
        {window.aldunisDesktop && (
          <button
            className="native-directory-picker"
            type="button"
            disabled={busy || pickerBusy}
            onClick={() => {
              setPickerBusy(true);
              setBrowseError(null);
              void window.aldunisDesktop?.chooseDirectory()
                .then((selected) => {
                  if (selected) {
                    setPath(selected);
                    onSubmit(selected);
                  }
                })
                .catch(() => setBrowseError("The system folder picker could not be opened."))
                .finally(() => setPickerBusy(false));
            }}
          >
            {pickerBusy ? "Opening system picker…" : "Choose with system picker…"}
          </button>
        )}
        <section className="directory-browser" aria-label="Permitted local directories" aria-busy={browseBusy}>
          <header>
            <strong>{listing?.path ?? "Local directories"}</strong>
            <label>
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setIncludeHidden(checked);
                  void browse(listing?.path, checked);
                }}
                disabled={busy || browseBusy}
              />
              Show hidden
            </label>
          </header>
          <nav aria-label="Directory choices">
            {listing?.parent && (
              <button type="button" onClick={() => void browse(listing.parent ?? undefined)} disabled={busy || browseBusy}>
                <span aria-hidden="true">↰</span><strong>Parent directory</strong>
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button type="button" key={entry.path} onClick={() => void browse(entry.path)} disabled={busy || browseBusy}>
                <span aria-hidden="true">▰</span><strong>{entry.name}</strong>
              </button>
            ))}
            {browseBusy && <p role="status">Listing directories…</p>}
            {!browseBusy && listing && listing.entries.length === 0 && <p>No available subdirectories.</p>}
          </nav>
          {listing && (
            <footer>
              <small>{listing.truncated ? `Showing the first ${listing.limits.maxEntries} directories.` : "Directory metadata only."}</small>
              <Button type="button" size="sm" onClick={() => setPath(listing.path)} disabled={busy}>Use this directory</Button>
            </footer>
          )}
        </section>
        <form onSubmit={submit}>
          <label htmlFor="repository-path">Repository path <span>— manual fallback</span></label>
          <input
            id="repository-path"
            data-dialog-initial-focus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/Projects/repository"
            disabled={busy}
          />
          {(browseError || error) && <div className="repository-error" role="alert">{browseError ?? error}</div>}
          <footer>
            <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={busy || !path.trim()}>
              {busy ? "Inspecting…" : "Open repository"}
            </Button>
          </footer>
        </form>
    </ModalSurface>
  );
}


