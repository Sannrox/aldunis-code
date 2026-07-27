import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ChangedFile, FileDiff, DiffAnnotation, DeliveryContext, DeliveryPlan, DeliveryAction, ConversationSummary, RepositoryMetadata } from "../../types";
import { Button, CloseButton, NestedDialogSurface, handleNestedEscape } from "../../components/ui";

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
}) {
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [commentLineIndex, setCommentLineIndex] = useState<number | null | undefined>(undefined);
  const [commentText, setCommentText] = useState("");
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [revisionPreview, setRevisionPreview] = useState<string | null>(null);
  const revisionPreviewRef = useRef<HTMLElement>(null);
  const [delivery, setDelivery] = useState<DeliveryContext | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [deliveryAction, setDeliveryAction] = useState<DeliveryAction>("stage");
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState("");
  const [base, setBase] = useState("main");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [plan, setPlan] = useState<DeliveryPlan | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const inspectDelivery = async () => {
    const response = await fetch("/api/delivery/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
    });
    const result = await response.json() as DeliveryContext | { error?: string };
    if (!response.ok) throw new Error("error" in result ? result.error : "Delivery state could not be inspected.");
    const context = result as DeliveryContext;
    setDelivery(context);
    setRemote((current) => current || context.remotes[0]?.name || "");
  };
  useEffect(() => {
    setSelectedPaths([]);
    setPlan(null);
    setRemote("");
    setDeliveryError(null);
    void inspectDelivery().catch((cause) => setDeliveryError(cause instanceof Error ? cause.message : "Delivery state could not be inspected."));
  }, [repository.root, repository.selectedWorktree]);
  const prepareDelivery = async () => {
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      const input = deliveryAction === "stage" ? { paths: selectedPaths }
        : deliveryAction === "commit" ? { message }
        : deliveryAction === "push" ? { remote }
        : { remote, base, title, body };
      const response = await fetch("/api/delivery/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          action: deliveryAction,
          input,
        }),
      });
      const result = await response.json() as DeliveryPlan | { error?: string };
      if (!response.ok) throw new Error("error" in result ? result.error : "The action could not be prepared.");
      setPlan(result as DeliveryPlan);
    } catch (cause) {
      setDeliveryError(cause instanceof Error ? cause.message : "The action could not be prepared.");
    } finally {
      setDeliveryBusy(false);
    }
  };
  const executeDelivery = async () => {
    if (!plan) return;
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      const response = await fetch(`/api/delivery/plans/${plan.id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The approved action failed.");
      setPlan(null);
      setSelectedPaths([]);
      await Promise.all([inspectDelivery(), Promise.resolve(onRefresh())]);
    } catch (cause) {
      setDeliveryError(cause instanceof Error ? cause.message : "The approved action failed.");
    } finally {
      setDeliveryBusy(false);
    }
  };
  useEffect(() => {
    if (!selected || !files.some((file) => file.path === selected)) {
      setSelected(files[0]?.path ?? null);
    }
  }, [files, selected]);
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let active = true;
    setDiff(null);
    setDiffError(null);
    void fetch("/api/changes/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        path: selected,
      }),
    }).then(async (response) => {
      const body = await response.json() as FileDiff | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Diff could not be read.");
      if (active) setDiff(body as FileDiff);
    }).catch((cause) => {
      if (active) setDiffError(cause instanceof Error ? cause.message : "Diff could not be read.");
    });
    return () => { active = false; };
  }, [repository, selected]);
  const loadAnnotations = async () => {
    if (!threadId) {
      setAnnotations([]);
      return;
    }
    const response = await fetch("/api/annotations/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        threadId,
      }),
    });
    const body = await response.json() as { annotations?: DiffAnnotation[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Annotations could not be loaded.");
    const loaded = body.annotations ?? [];
    setAnnotations(loaded);
    setSelectedAnnotationIds((current) => current.filter(
      (id) => loaded.some((annotation) => annotation.id === id),
    ));
  };
  useEffect(() => {
    void loadAnnotations().catch((cause) => {
      setAnnotationError(cause instanceof Error ? cause.message : "Annotations could not be loaded.");
    });
  }, [threadId, repository.root, repository.selectedWorktree]);
  const saveAnnotation = async () => {
    if (!threadId || !selected || !diff || commentLineIndex === undefined || !commentText.trim()) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch("/api/annotations/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          path: selected,
          diffIdentity: diff.identity,
          scope: commentLineIndex === null ? "file" : "line",
          lineIndex: commentLineIndex,
          text: commentText,
        }),
      });
      const body = await response.json() as DiffAnnotation | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "The annotation could not be saved.");
      setCommentLineIndex(undefined);
      setCommentText("");
      await loadAnnotations();
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be saved.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  const setResolution = async (annotation: DiffAnnotation) => {
    if (!threadId) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch(`/api/annotations/${annotation.id}/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          resolved: annotation.resolution === "unresolved",
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The annotation could not be updated.");
      await loadAnnotations();
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be updated.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  const previewRevision = async () => {
    if (!threadId || selectedAnnotationIds.length === 0) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch("/api/annotations/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          annotationIds: selectedAnnotationIds,
        }),
      });
      const body = await response.json() as { prompt?: string; error?: string };
      if (!response.ok || !body.prompt) throw new Error(body.error ?? "The revision request could not be previewed.");
      setRevisionPreview(body.prompt);
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The revision request could not be previewed.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  useEffect(() => {
    if (revisionPreview) revisionPreviewRef.current?.focus();
  }, [revisionPreview]);
  const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  // Embedded in the conversation review dock (mock .rv) — not a portal modal.
  return (
    <div className="changes-panel rv-panel" aria-label={`Changes for ${pane} conversation`}>
      <div className="rv-h">
        <span className="rv-t">Review</span>
        <span className="rv-s">
          {files.length} files
          {(added > 0 || removed > 0) && (
            <> · <b className="ok">+{added}</b> <b className="bad">−{removed}</b></>
          )}
        </span>
        <Button
          size="sm"
          className="btn btn-ghost btn-xs"
          style={{ marginLeft: "auto" }}
          aria-label={`Refresh changed files and review comments, ${pane} pane`}
          onClick={() => { onRefresh(); void loadAnnotations(); }}
        >
          Refresh
        </Button>
        <CloseButton data-dialog-initial-focus onClick={onClose} label={`Close changed files, ${pane} pane`} />
      </div>
      <div className="changes-body rv-body">
        <nav className="rv-files" aria-label={`Changed files, ${pane} pane`}>
          {loading && <p className="changes-note">Inspecting worktree…</p>}
          {error && <p className="changes-error" role="alert">{error}</p>}
          {!loading && !error && files.length === 0 && <p className="changes-note">The active worktree is clean.</p>}
          {files.map((file) => (
            <div className={selected === file.path ? "changed-file active" : "changed-file"} key={file.path}>
              <label className="changed-file-select">
                <input
                  type="checkbox"
                  aria-label={`Select ${file.path} for staging`}
                  checked={selectedPaths.includes(file.path)}
                  onChange={(event) => {
                    const stagedPaths = file.previousPath ? [file.path, file.previousPath] : [file.path];
                    setSelectedPaths((paths) => event.target.checked
                      ? [...new Set([...paths, ...stagedPaths])]
                      : paths.filter((path) => !stagedPaths.includes(path)));
                  }}
                />
              </label>
              <button
                type="button"
                className="changed-file-main"
                onClick={() => setSelected(file.path)}
                aria-current={selected === file.path ? "true" : undefined}
                aria-label={[
                  file.state,
                  file.path,
                  file.previousPath ? `from ${file.previousPath}` : null,
                  file.additions === null && file.deletions === null
                    ? null
                    : `${file.additions === null ? "—" : `+${file.additions}`} ${file.deletions === null ? "—" : `−${file.deletions}`}`,
                ].filter(Boolean).join(", ")}
              >
                <span className={`change-state ${file.state}`}>{file.state}</span>
                <span className="changed-file-path">
                  <strong>{file.path}</strong>
                  {file.previousPath && <small> from {file.previousPath}</small>}
                </span>
                <small className="change-lines">
                  {file.additions === null ? "—" : `+${file.additions}`}
                  {" "}
                  {file.deletions === null ? "—" : `−${file.deletions}`}
                </small>
              </button>
            </div>
          ))}
        </nav>
        <div className="review-workspace">
        <div className="diff-view" tabIndex={0} aria-label={selected ? `Diff for ${selected}, ${pane} pane` : `File diff, ${pane} pane`}>
          {diffError && <p className="changes-error" role="alert">{diffError}</p>}
          {selected && !diff && !diffError && <p className="changes-note">Loading structured diff…</p>}
          {diff?.message && <div className={`diff-placeholder ${diff.state}`}><strong>{diff.state}</strong><p>{diff.message}</p></div>}
          {diff && threadId && (
            <button
              type="button"
              className="file-comment-button"
              onClick={() => setCommentLineIndex(null)}
            >
              Comment on {diff.path}
            </button>
          )}
          {diff?.patch && <pre>{diff.lines.map((line) => (
            <span className={line.side} key={line.index}>
              {line.side !== "metadata" && threadId
                ? <button
                    type="button"
                    className="diff-comment-button"
                    onClick={() => setCommentLineIndex(line.index)}
                    aria-label={`Comment on ${diff.path} ${line.side} line ${line.newLine ?? line.oldLine}`}
                  >+</button>
                : <i aria-hidden="true" />}
              <code>{line.content || " "}</code>
            </span>
          ))}</pre>}
          {!threadId && <p className="changes-note">Send the first conversation turn before saving review comments.</p>}
          {commentLineIndex !== undefined && diff && (
            <section className="annotation-composer" aria-label={`New local diff comment, ${pane} pane`}>
              <strong>{commentLineIndex === null
                ? `Comment on ${diff.path}`
                : `Comment on ${diff.path} line ${diff.lines.find((line) => line.index === commentLineIndex)?.newLine
                  ?? diff.lines.find((line) => line.index === commentLineIndex)?.oldLine}`}
              </strong>
              <textarea
                id="review-comment-text"
                name="review-comment-text"
                autoFocus
                maxLength={2000}
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void saveAnnotation();
                  if (handleNestedEscape(event, () => {
                    setCommentLineIndex(undefined);
                    setCommentText("");
                  })) return;
                }}
                aria-label={`Review comment, ${pane} pane`}
              />
              <footer>
                <Button
                  type="button"
                  size="sm"
                  aria-label={`Cancel review comment, ${pane} pane`}
                  onClick={() => { setCommentLineIndex(undefined); setCommentText(""); }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  aria-label={`Save review comment, ${pane} pane`}
                  onClick={() => void saveAnnotation()}
                  disabled={annotationBusy || !commentText.trim()}
                >
                  Save comment
                </Button>
              </footer>
            </section>
          )}
        </div>
        <section className="annotations-panel" aria-label={`Local diff comments, ${pane} pane`}>
          <header className="review-section-header">
            <strong>Review comments</strong>
            <small>{annotations.filter((item) => item.resolution === "unresolved").length} unresolved</small>
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
              const resolveLabel = annotation.resolution === "unresolved" ? "Resolve" : "Reopen";
              return (
              <li className={`annotation-item ${annotation.resolution} ${annotation.stale ? "stale" : ""}`} key={annotation.id}>
                <label className="annotation-select">
                  <input
                    type="checkbox"
                    checked={selectedAnnotationIds.includes(annotation.id)}
                    aria-label={`Select comment on ${target}`}
                    onChange={(event) => setSelectedAnnotationIds((current) => event.target.checked
                      ? [...current, annotation.id]
                      : current.filter((id) => id !== annotation.id))}
                  />
                  <span className="annotation-body">
                    <strong className="annotation-target">
                      {annotation.path}
                      <span className="annotation-scope">
                        {" "}· {annotation.scope === "file" ? "file" : annotation.side === "deletion" ? `old line ${annotation.oldLine}` : `new line ${annotation.newLine}`}
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
                  onClick={() => void setResolution(annotation)}
                  disabled={annotationBusy}
                >
                  {resolveLabel}
                </button>
              </li>
              );
            })}
          </ul>
          {annotationError && <p className="changes-error" role="alert">{annotationError}</p>}
          <Button
            size="sm"
            onClick={() => void previewRevision()}
            disabled={annotationBusy || selectedAnnotationIds.length === 0}
            aria-label={`Preview revision request, ${pane} pane`}
          >
            Preview revision request
          </Button>
        </section>
        {revisionPreview && (
          <section
            ref={revisionPreviewRef}
            tabIndex={-1}
            className="revision-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`Revision request preview, ${pane} pane`}
            onKeyDown={(event) => {
              handleNestedEscape(event, () => setRevisionPreview(null));
            }}
          >
            <header><strong>Exact provider context</strong><CloseButton onClick={() => setRevisionPreview(null)} label={`Close revision preview, ${pane} pane`} /></header>
            <pre>{revisionPreview}</pre>
            <p>Sending starts a normal follow-up turn. It does not resolve comments, edit files, approve tools, or publish a hosted review.</p>
            <footer>
              <Button type="button" size="sm" onClick={() => setRevisionPreview(null)} aria-label={`Cancel revision request, ${pane} pane`}>
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
            {!canSendRevision && <p role="alert">Configure an available provider before sending this revision request.</p>}
          </section>
        )}
        <section className="delivery-panel" aria-label={`Commit, push, and pull request actions, ${pane} pane`}>
          <header className="review-section-header delivery-header">
            <div>
              <strong>Reviewed delivery</strong>
              <small>{delivery?.branch ?? "Detached HEAD"} · {repository.selectedWorktree}</small>
            </div>
            <span>{delivery?.upstream ?? "No upstream"}</span>
          </header>
          <div className="delivery-form">
            <label htmlFor="delivery-action">Action
              <select
                id="delivery-action"
                name="delivery-action"
                value={deliveryAction}
                onChange={(event) => {
                  setDeliveryAction(event.target.value as DeliveryAction);
                  setPlan(null);
                }}
              >
                <option value="stage">Stage selected files</option>
                <option value="commit">Commit staged files</option>
                <option value="push">Push branch</option>
                <option value="pull_request">Open pull request</option>
              </select>
            </label>
            {deliveryAction === "commit" && (
              <label htmlFor="delivery-commit-message">Commit message
                <input
                  id="delivery-commit-message"
                  name="delivery-commit-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
            )}
            {(deliveryAction === "push" || deliveryAction === "pull_request") && (
              <label htmlFor="delivery-remote">Remote
                <select
                  id="delivery-remote"
                  name="delivery-remote"
                  value={remote}
                  onChange={(event) => setRemote(event.target.value)}
                >
                  {delivery?.remotes.map((item) => (
                    <option key={item.name} value={item.name}>{item.name} · {item.url}</option>
                  ))}
                </select>
              </label>
            )}
            {deliveryAction === "pull_request" && (
              <>
                <label htmlFor="delivery-pr-base">Base
                  <input
                    id="delivery-pr-base"
                    name="delivery-pr-base"
                    value={base}
                    onChange={(event) => setBase(event.target.value)}
                  />
                </label>
                <label htmlFor="delivery-pr-title">Title
                  <input
                    id="delivery-pr-title"
                    name="delivery-pr-title"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label className="delivery-body" htmlFor="delivery-pr-body">Body
                  <textarea
                    id="delivery-pr-body"
                    name="delivery-pr-body"
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
              </>
            )}
            {!plan && (
              <Button
                type="button"
                size="sm"
                className="prepare-delivery"
                onClick={() => void prepareDelivery()}
                disabled={deliveryBusy || delivery?.detached}
                aria-label={`Inspect ${deliveryAction} action for delivery`}
              >
                Inspect action
              </Button>
            )}
          </div>
          {delivery?.detached && <p className="delivery-warning" role="alert">Detached HEAD cannot be delivered. Create or select a branch first.</p>}
          {deliveryError && <p className="delivery-warning" role="alert">{deliveryError}</p>}
          {plan && (
            <div className="delivery-approval">
              <strong>{plan.summary}</strong>
              <small>{plan.repository} · {plan.worktree} · {plan.branch}</small>
              <ul>{plan.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
              <footer>
                <Button onClick={() => setPlan(null)} aria-label={`Cancel delivery plan, ${pane} pane`}>Cancel</Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={deliveryBusy}
                  aria-label={`Approve once: ${plan.summary}`}
                  onClick={() => void executeDelivery()}
                >
                  Approve once
                </Button>
              </footer>
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}


