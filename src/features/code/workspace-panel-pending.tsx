import React from "react";
import { CloseButton, Spinner } from "../../components/ui";
import type { ProviderBrowserObservation } from "../../types";
import type { WorkspacePanelDestination } from "../../lib/workspace-panel";

export function WorkspacePanelPendingFallback({
  destination,
  pane,
  floating = false,
  observation = null,
  onClose,
}: {
  destination: WorkspacePanelDestination;
  pane: "primary" | "secondary";
  floating?: boolean;
  observation?: ProviderBrowserObservation | null;
  onClose: () => void;
}) {
  if (destination === "files") {
    return (
      <section
        className="file-browser-panel"
        data-workspace-panel-pending="files"
        aria-busy="true"
        aria-label={`Browse active worktree, ${pane} pane`}
      >
        <header>
          <div>
            <p className="eyebrow">Bounded local context</p>
            <h2>Browse active worktree</h2>
          </div>
          <CloseButton onClick={onClose} label={`Close file browser, ${pane} pane`} />
        </header>
        <p className="workspace-panel-pending file-browser-note">
          <Spinner size="sm" label="Opening Files" />
          Opening Files…
        </p>
      </section>
    );
  }

  if (destination === "changes") {
    return (
      <div
        className="changes-panel rv-panel"
        data-workspace-panel-pending="changes"
        aria-busy="true"
        aria-label={`Changes for ${pane} conversation`}
      >
        <div className="rv-h changes-panel-header">
          <div className="changes-panel-heading">
            <span className="rv-t">Changes</span>
          </div>
          <CloseButton
            data-dialog-initial-focus
            onClick={onClose}
            label={`Close changed files, ${pane} pane`}
          />
        </div>
        <div className="changes-body rv-body">
          <p className="workspace-panel-pending changes-note">
            <Spinner size="sm" label="Opening Changes" />
            Opening Changes…
          </p>
        </div>
      </div>
    );
  }

  const hasObservation = observation != null;
  const floatingPanel = floating || hasObservation;
  return (
    <section
      className={`preview-panel${floatingPanel ? " preview-panel--floating" : ""}`}
      data-workspace-panel-pending="preview"
      aria-busy="true"
      aria-label={hasObservation ? `Agent browser view, ${pane} pane` : `Web preview, ${pane} pane`}
    >
      <header>
        <div>
          <p className="eyebrow">
            {hasObservation ? "PROVIDER OBSERVATION" : "CONSTRAINED PREVIEW"}
          </p>
          <h2>{hasObservation ? "Agent browser view" : "Local web application"}</h2>
        </div>
        <CloseButton
          onClick={onClose}
          label={`Close ${hasObservation ? "agent browser view" : "preview"}, ${pane} pane`}
        />
      </header>
      {hasObservation ? (
        <>
          <div className="preview-policy">
            <strong>Ephemeral snapshot</strong>
            <span>Opening the agent browser view…</span>
          </div>
          <div className="browser-observation-workspace">
            <div className="preview-toolbar">
              <span title={observation.url ?? undefined}>
                {observation.title ?? observation.url ?? "Provider browser frame"}
              </span>
              <em>stream-only</em>
            </div>
            <figure>
              <img
                src={observation.imageData}
                alt={
                  observation.title
                    ? `Provider browser: ${observation.title}`
                    : "Provider browser snapshot"
                }
              />
            </figure>
            <p>
              Source: {observation.provider}. The frame is visible while Preview finishes loading.
            </p>
          </div>
        </>
      ) : (
        <p className="workspace-panel-pending file-browser-note">
          <Spinner size="sm" label="Opening Preview" />
          Opening Preview…
        </p>
      )}
    </section>
  );
}
