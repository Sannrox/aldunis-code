import React, { useEffect, useRef, useState } from "react";
import type { ChangedFile, DeliveryAction, RepositoryMetadata } from "../../types";
import { Button, CloseButton, handleNestedEscape } from "../../components/ui";
import { useChangedFileReviewSession } from "./review-session";
import { useReviewedDeliverySession } from "./delivery-session";

export type ChangesPanelMode = "review" | "deliver";

export function ChangesPanel({
  repository,
  threadId,
  pane = "primary",
  files,
  loading,
  error,
  onClose,
  onRefresh,
  onSendRevision,
  canSendRevision,
  mode,
  onModeChange,
  checkpointId = null,
  readOnly = false,
  panelTitle = "Changes",
}: {
  repository: RepositoryMetadata;
  threadId: string | null;
  /** Dual-pane scope for review dock chrome labels. */
  pane?: "primary" | "secondary";
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSendRevision: (prompt: string) => void;
  canSendRevision: boolean;
  /** Review and delivery share the dock, but never compete for the same primary action. */
  mode?: ChangesPanelMode;
  onModeChange?: (mode: ChangesPanelMode) => void;
  /** When set, review is read from this completed turn checkpoint instead of the current worktree. */
  checkpointId?: string | null;
  /** Historical checkpoint review cannot stage, publish, or bind comments to the mutable worktree. */
  readOnly?: boolean;
  panelTitle?: string;
}) {
  const [uncontrolledMode, setUncontrolledMode] = useState<ChangesPanelMode>("review");
  const panelMode = readOnly ? "review" : (mode ?? uncontrolledMode);
  const revisionPreviewRef = useRef<HTMLElement>(null);
  const review = useChangedFileReviewSession({
    repository,
    threadId,
    files,
    checkpointId,
    readOnly,
  });
  const {
    selected,
    diff,
    diffError,
    annotations,
    annotationError,
    annotationBusy,
    commentLineIndex,
    commentText,
    selectedAnnotationIds,
    revisionPreview,
  } = review.state;
  const { snapshot: deliveryState, session: deliverySession } = useReviewedDeliverySession({
    root: repository.root,
    worktree: repository.selectedWorktree,
    active: panelMode === "deliver",
  });
  const {
    context: delivery,
    selectedPaths,
    action: deliveryAction,
    message,
    remote,
    base,
    title,
    body,
    plan,
    error: deliveryError,
    busy: deliveryBusy,
    loading: deliveryLoading,
  } = deliveryState;
  // Match file-browser Escape: dismiss nested review first, then the dock.
  // Skip when a true modal dialog owns the key (command palette, etc.).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (revisionPreview || commentLineIndex !== undefined) {
        review.dispatch({ type: "dismiss_nested" });
        return;
      }
      if (plan) {
        deliverySession.clearPlan();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [deliverySession, onClose, revisionPreview, commentLineIndex, plan]);
  useEffect(() => {
    if (revisionPreview) revisionPreviewRef.current?.focus();
  }, [revisionPreview]);
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const changeMode = (next: ChangesPanelMode) => {
    if (readOnly) return;
    if (next === panelMode) return;
    if (next === "deliver") {
      review.dispatch({ type: "leave_review" });
    } else {
      deliverySession.clearPlan();
    }
    setUncontrolledMode(next);
    onModeChange?.(next);
  };

  // Embedded in the conversation review dock (mock .rv) — not a portal modal.
  return (
    <div className="changes-panel rv-panel" aria-label={`${panelTitle} for ${pane} conversation`}>
      <div className="rv-h changes-panel-header">
        <div className="changes-panel-heading">
          <span className="rv-t">{panelTitle}</span>
          <span className="rv-s">
            {files.length} files
            {(added > 0 || removed > 0) && (
              <>
                {" "}
                · <b className="ok">+{added}</b> <b className="bad">−{removed}</b>
              </>
            )}
          </span>
        </div>
        {!readOnly && (
          <div
            className="changes-panel-tabs"
            role="tablist"
            aria-label={`Change workspace, ${pane} pane`}
          >
            <button
              type="button"
              role="tab"
              id={`${pane}-changes-review-tab`}
              className={panelMode === "review" ? "active" : ""}
              aria-selected={panelMode === "review"}
              aria-controls={`${pane}-changes-review-panel`}
              onClick={() => changeMode("review")}
            >
              Review
            </button>
            <button
              type="button"
              role="tab"
              id={`${pane}-changes-deliver-tab`}
              className={panelMode === "deliver" ? "active" : ""}
              aria-selected={panelMode === "deliver"}
              aria-controls={`${pane}-changes-deliver-panel`}
              onClick={() => changeMode("deliver")}
            >
              Deliver
            </button>
          </div>
        )}
        <Button
          size="sm"
          className="btn btn-ghost btn-xs changes-panel-refresh"
          aria-label={`Refresh changed files and review comments, ${pane} pane`}
          onClick={() => {
            onRefresh();
            void review.loadAnnotations();
          }}
        >
          Refresh
        </Button>
        <CloseButton
          data-dialog-initial-focus
          onClick={onClose}
          label={`Close changed files, ${pane} pane`}
        />
      </div>
      <div className="changes-body rv-body">
        <nav className="rv-files" aria-label={`Changed files, ${pane} pane`}>
          {loading && <p className="changes-note">Inspecting worktree…</p>}
          {error && (
            <p className="changes-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !error && files.length === 0 && (
            <p className="changes-note">The active worktree is clean.</p>
          )}
          {files.map((file) => (
            <div
              className={selected === file.path ? "changed-file active" : "changed-file"}
              key={file.path}
            >
              {!readOnly && panelMode === "deliver" && (
                <label className="changed-file-select">
                  <input
                    type="checkbox"
                    aria-label={`Select ${file.path} for staging`}
                    checked={selectedPaths.includes(file.path)}
                    onChange={(event) => {
                      const stagedPaths = file.previousPath
                        ? [file.path, file.previousPath]
                        : [file.path];
                      deliverySession.toggleSelectedPaths(stagedPaths, event.target.checked);
                    }}
                  />
                </label>
              )}
              <button
                type="button"
                className="changed-file-main"
                onClick={() => review.dispatch({ type: "select_file", path: file.path })}
                aria-current={selected === file.path ? "true" : undefined}
                aria-label={[
                  file.state,
                  file.path,
                  file.previousPath ? `from ${file.previousPath}` : null,
                  file.additions === null && file.deletions === null
                    ? null
                    : `${file.additions === null ? "—" : `+${file.additions}`} ${file.deletions === null ? "—" : `−${file.deletions}`}`,
                ]
                  .filter(Boolean)
                  .join(", ")}
              >
                <span className={`change-state ${file.state}`}>{file.state}</span>
                <span
                  className="changed-file-path"
                  title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                >
                  <strong>{file.path}</strong>
                  {file.previousPath && <small> from {file.previousPath}</small>}
                </span>
                <small className="change-lines">
                  {file.additions === null ? "—" : `+${file.additions}`}{" "}
                  {file.deletions === null ? "—" : `−${file.deletions}`}
                </small>
              </button>
            </div>
          ))}
        </nav>
        <div className="review-workspace">
          <div
            id={`${pane}-changes-review-panel`}
            className="diff-view"
            role="tabpanel"
            aria-labelledby={!readOnly ? `${pane}-changes-review-tab` : undefined}
            hidden={panelMode !== "review"}
            tabIndex={0}
            aria-label={selected ? `Diff for ${selected}, ${pane} pane` : `File diff, ${pane} pane`}
          >
            {diffError && (
              <p className="changes-error" role="alert">
                {diffError}
              </p>
            )}
            {selected && !diff && !diffError && (
              <p className="changes-note">Loading structured diff…</p>
            )}
            {diff?.message && (
              <div className={`diff-placeholder ${diff.state}`}>
                <strong>{diff.state}</strong>
                <p>{diff.message}</p>
              </div>
            )}
            {diff && threadId && !readOnly && (
              <button
                type="button"
                className="file-comment-button"
                onClick={() => review.dispatch({ type: "open_comment", lineIndex: null })}
                aria-label={`Comment on ${diff.path}, ${pane} pane`}
              >
                Comment on {diff.path}
              </button>
            )}
            {diff?.patch && (
              <pre>
                {diff.lines.map((line) => (
                  <span className={line.side} key={line.index}>
                    {line.side !== "metadata" && threadId && !readOnly ? (
                      <button
                        type="button"
                        className="diff-comment-button"
                        onClick={() =>
                          review.dispatch({ type: "open_comment", lineIndex: line.index })
                        }
                        aria-label={`Comment on ${diff.path} ${line.side} line ${line.newLine ?? line.oldLine}`}
                      >
                        +
                      </button>
                    ) : (
                      <i aria-hidden="true" />
                    )}
                    <code>{line.content || " "}</code>
                  </span>
                ))}
              </pre>
            )}
            {!readOnly && !threadId && (
              <p className="changes-note">
                Send the first conversation turn before saving review comments.
              </p>
            )}
            {!readOnly && commentLineIndex !== undefined && diff && (
              <section
                className="annotation-composer"
                aria-label={`New local diff comment, ${pane} pane`}
              >
                <strong>
                  {commentLineIndex === null
                    ? `Comment on ${diff.path}`
                    : `Comment on ${diff.path} line ${
                        diff.lines.find((line) => line.index === commentLineIndex)?.newLine ??
                        diff.lines.find((line) => line.index === commentLineIndex)?.oldLine
                      }`}
                </strong>
                <textarea
                  id="review-comment-text"
                  name="review-comment-text"
                  autoFocus
                  maxLength={2000}
                  value={commentText}
                  onChange={(event) =>
                    review.dispatch({ type: "set_comment_text", text: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
                      void review.saveAnnotation();
                    if (
                      handleNestedEscape(event, () => {
                        review.dispatch({ type: "close_comment" });
                      })
                    )
                      return;
                  }}
                  aria-label={`Review comment, ${pane} pane`}
                />
                <footer>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Cancel review comment, ${pane} pane`}
                    onClick={() => review.dispatch({ type: "close_comment" })}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    aria-label={`Save review comment, ${pane} pane`}
                    onClick={() => void review.saveAnnotation()}
                    disabled={annotationBusy || !commentText.trim()}
                  >
                    Save comment
                  </Button>
                </footer>
              </section>
            )}
          </div>
          {!readOnly && (
            <section
              className="annotations-panel"
              role="tabpanel"
              aria-labelledby={`${pane}-changes-review-tab`}
              hidden={panelMode !== "review"}
              aria-label={`Local diff comments, ${pane} pane`}
            >
              <header className="review-section-header">
                <strong>Review comments</strong>
                <small>
                  {annotations.filter((item) => item.resolution === "unresolved").length} unresolved
                </small>
              </header>
              {annotations.length === 0 && <p>No local comments yet.</p>}
              <ul className="annotation-list">
                {annotations.map((annotation) => {
                  const target =
                    annotation.scope === "file"
                      ? `${annotation.path} (file)`
                      : annotation.side === "deletion"
                        ? `${annotation.path} old line ${annotation.oldLine}`
                        : `${annotation.path} new line ${annotation.newLine}`;
                  const resolveLabel =
                    annotation.resolution === "unresolved" ? "Resolve" : "Reopen";
                  return (
                    <li
                      className={`annotation-item ${annotation.resolution} ${annotation.stale ? "stale" : ""}`}
                      key={annotation.id}
                    >
                      <label className="annotation-select">
                        <input
                          type="checkbox"
                          checked={selectedAnnotationIds.includes(annotation.id)}
                          aria-label={`Select comment on ${target}`}
                          onChange={(event) =>
                            review.dispatch({
                              type: "toggle_annotation",
                              id: annotation.id,
                              selected: event.target.checked,
                            })
                          }
                        />
                        <span className="annotation-body">
                          <strong className="annotation-target" title={target}>
                            {annotation.path}
                            <span className="annotation-scope">
                              {" "}
                              ·{" "}
                              {annotation.scope === "file"
                                ? "file"
                                : annotation.side === "deletion"
                                  ? `old line ${annotation.oldLine}`
                                  : `new line ${annotation.newLine}`}
                            </span>
                          </strong>
                          <small className="annotation-meta">
                            {annotation.stale
                              ? annotation.staleReason
                              : annotation.checkpointId
                                ? "Checkpoint-bound target"
                                : "Diff-bound target"}
                          </small>
                          <p className="annotation-text">{annotation.text}</p>
                        </span>
                      </label>
                      <button
                        type="button"
                        className="annotation-resolve"
                        aria-label={`${resolveLabel} comment on ${target}`}
                        onClick={() => void review.setResolution(annotation)}
                        disabled={annotationBusy}
                      >
                        {resolveLabel}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {annotationError && (
                <p className="changes-error" role="alert">
                  {annotationError}
                </p>
              )}
              <Button
                size="sm"
                onClick={() => void review.previewRevision()}
                disabled={annotationBusy || selectedAnnotationIds.length === 0}
                aria-label={`Preview revision request, ${pane} pane`}
              >
                Preview revision request
              </Button>
            </section>
          )}
          {readOnly && panelMode === "review" && (
            <p className="changes-note checkpoint-review-note">
              Historical turn diff. Comments and delivery apply to the current worktree.
            </p>
          )}
          {panelMode === "review" && revisionPreview && (
            <section
              ref={revisionPreviewRef}
              tabIndex={-1}
              className="revision-preview"
              role="dialog"
              aria-modal="true"
              aria-label={`Revision request preview, ${pane} pane`}
              onKeyDown={(event) => {
                handleNestedEscape(event, () => review.dispatch({ type: "close_revision" }));
              }}
            >
              <header>
                <strong>Exact provider context</strong>
                <CloseButton
                  onClick={() => review.dispatch({ type: "close_revision" })}
                  label={`Close revision preview, ${pane} pane`}
                />
              </header>
              <pre>{revisionPreview}</pre>
              <p>
                Sending starts a normal follow-up turn. It does not resolve comments, edit files,
                approve tools, or publish a hosted review.
              </p>
              <footer>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => review.dispatch({ type: "close_revision" })}
                  aria-label={`Cancel revision request, ${pane} pane`}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => onSendRevision(revisionPreview)}
                  disabled={!canSendRevision}
                  aria-label={`Send selected comments, ${pane} pane`}
                >
                  Send selected comments
                </Button>
              </footer>
              {!canSendRevision && (
                <p role="alert">
                  Configure an available provider before sending this revision request.
                </p>
              )}
            </section>
          )}
          {panelMode === "deliver" && (
            <section
              id={`${pane}-changes-deliver-panel`}
              className="delivery-panel"
              role="tabpanel"
              aria-labelledby={`${pane}-changes-deliver-tab`}
              aria-label={`Commit, push, and pull request actions, ${pane} pane`}
            >
              <header className="review-section-header delivery-header">
                <div>
                  <strong>Reviewed delivery</strong>
                  <small
                    title={`${delivery?.branch ?? "Detached HEAD"} · ${repository.selectedWorktree}`}
                  >
                    {delivery?.branch ?? "Detached HEAD"} · {repository.selectedWorktree}
                  </small>
                </div>
                <span title={delivery?.upstream ?? "No upstream"}>
                  {delivery?.upstream ?? "No upstream"}
                </span>
              </header>
              <p className="delivery-boundary-note">
                Preview first. Nothing changes until you approve the reviewed plan.
              </p>
              {!delivery && !deliveryError && (
                <p className="delivery-loading" role="status">
                  Reading branch and remote…
                </p>
              )}
              <div className="delivery-form">
                <label htmlFor={`${pane}-delivery-action`}>
                  Action
                  <select
                    id={`${pane}-delivery-action`}
                    name={`${pane}-delivery-action`}
                    value={deliveryAction}
                    onChange={(event) => {
                      deliverySession.setAction(event.target.value as DeliveryAction);
                    }}
                  >
                    <option value="stage">Stage selected files</option>
                    <option value="commit">Commit staged files</option>
                    <option value="push">Push branch</option>
                    <option value="pull_request">Open pull request</option>
                  </select>
                </label>
                {deliveryAction === "commit" && (
                  <label htmlFor={`${pane}-delivery-commit-message`}>
                    Commit message
                    <input
                      id={`${pane}-delivery-commit-message`}
                      name={`${pane}-delivery-commit-message`}
                      value={message}
                      onChange={(event) => deliverySession.setMessage(event.target.value)}
                    />
                  </label>
                )}
                {(deliveryAction === "push" || deliveryAction === "pull_request") && (
                  <label htmlFor={`${pane}-delivery-remote`}>
                    Remote
                    <select
                      id={`${pane}-delivery-remote`}
                      name={`${pane}-delivery-remote`}
                      value={remote}
                      onChange={(event) => deliverySession.setRemote(event.target.value)}
                    >
                      {delivery?.remotes.map((item) => (
                        <option key={item.name} value={item.name}>
                          {item.name} · {item.url}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {deliveryAction === "pull_request" && (
                  <>
                    <label htmlFor={`${pane}-delivery-pr-base`}>
                      Base
                      <input
                        id={`${pane}-delivery-pr-base`}
                        name={`${pane}-delivery-pr-base`}
                        value={base}
                        onChange={(event) => deliverySession.setBase(event.target.value)}
                      />
                    </label>
                    <div className="delivery-draft-actions">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() =>
                          void deliverySession.generatePullRequestDraft(
                            repository.root,
                            repository.selectedWorktree,
                          )
                        }
                        disabled={
                          deliveryBusy ||
                          deliveryLoading ||
                          !delivery ||
                          delivery.detached ||
                          !base.trim()
                        }
                        aria-label={`Generate local pull-request draft, ${pane} pane`}
                      >
                        {deliveryBusy ? "Generating…" : "Generate draft"}
                      </Button>
                      <small>Uses branch and changed-path metadata only.</small>
                    </div>
                    <label htmlFor={`${pane}-delivery-pr-title`}>
                      Title
                      <input
                        id={`${pane}-delivery-pr-title`}
                        name={`${pane}-delivery-pr-title`}
                        value={title}
                        onChange={(event) => deliverySession.setTitle(event.target.value)}
                      />
                    </label>
                    <label className="delivery-body" htmlFor={`${pane}-delivery-pr-body`}>
                      Body
                      <textarea
                        id={`${pane}-delivery-pr-body`}
                        name={`${pane}-delivery-pr-body`}
                        value={body}
                        onChange={(event) => deliverySession.setBody(event.target.value)}
                      />
                    </label>
                  </>
                )}
                {!plan && (
                  <Button
                    type="button"
                    size="sm"
                    className="prepare-delivery"
                    onClick={() =>
                      void deliverySession.prepare(repository.root, repository.selectedWorktree)
                    }
                    disabled={deliveryBusy || deliveryLoading || !delivery || delivery.detached}
                    aria-label={`Preview ${deliveryAction} action for delivery, ${pane} pane`}
                  >
                    {deliveryBusy ? "Preparing…" : "Preview action"}
                  </Button>
                )}
              </div>
              {delivery?.detached && (
                <p className="delivery-warning" role="alert">
                  Detached HEAD cannot be delivered. Create or select a branch first.
                </p>
              )}
              {deliveryError && (
                <p className="delivery-warning" role="alert">
                  {deliveryError}
                </p>
              )}
              {plan && (
                <div className="delivery-approval">
                  <strong title={plan.summary}>{plan.summary}</strong>
                  <small title={`${plan.repository} · ${plan.worktree} · ${plan.branch}`}>
                    {plan.repository} · {plan.worktree} · {plan.branch}
                  </small>
                  <ul>
                    {plan.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                  <footer>
                    <Button
                      onClick={() => deliverySession.clearPlan()}
                      aria-label={`Cancel delivery plan, ${pane} pane`}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={deliveryBusy}
                      aria-label={`Approve once: ${plan.summary}`}
                      onClick={() =>
                        void deliverySession.execute(
                          repository.root,
                          repository.selectedWorktree,
                          onRefresh,
                        )
                      }
                    >
                      Approve once
                    </Button>
                  </footer>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
