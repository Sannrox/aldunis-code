import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ChangedFile, FileDiff, DiffAnnotation, DeliveryContext, DeliveryPlan, DeliveryAction, ConversationSummary, RepositoryMetadata } from "../../types";
import { Button, CloseButton, NestedDialogSurface, handleNestedEscape } from "../../components/ui";
import {
  DESIGN_MOCK_DELIVERY,
  designMockAnnotations,
  designMockDiff,
  isDesignMockRepository,
  isDesignMockThread,
} from "../code/design-mock";

export function ChangesPanel({
  repository,
  threadId,
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
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSendRevision: (prompt: string) => void;
  canSendRevision: boolean;
}) {
  const designMock = isDesignMockThread(threadId) || isDesignMockRepository(repository);
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
    if (designMock) {
      setDelivery(DESIGN_MOCK_DELIVERY);
      setRemote(DESIGN_MOCK_DELIVERY.remotes[0]?.name ?? "origin");
      return;
    }
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
  }, [repository.root, repository.selectedWorktree, designMock]);
  const prepareDelivery = async () => {
    if (designMock) {
      setDeliveryError("Design mock is read-only — delivery actions are not available.");
      return;
    }
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
    if (!plan || designMock) return;
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
    if (designMock) {
      setDiff(designMockDiff(selected));
      return;
    }
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
  }, [repository, selected, designMock]);
  const loadAnnotations = async () => {
    if (!threadId) {
      setAnnotations([]);
      return;
    }
    if (designMock) {
      const loaded = designMockAnnotations(threadId);
      setAnnotations(loaded);
      setAnnotationError(null);
      setSelectedAnnotationIds((current) => current.filter(
        (id) => loaded.some((annotation) => annotation.id === id),
      ));
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
  }, [threadId, repository.root, repository.selectedWorktree, designMock]);
  const saveAnnotation = async () => {
    if (!threadId || !selected || !diff || commentLineIndex === undefined || !commentText.trim()) return;
    if (designMock) {
      // Fixture mode is read-only for annotations.
      setCommentLineIndex(undefined);
      setCommentText("");
      return;
    }
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
    <div className="changes-panel rv-panel" aria-label="Changes for active conversation">
      <div className="rv-h">
        <span className="rv-t">Review</span>
        <span className="rv-s">
          {files.length} files
          {(added > 0 || removed > 0) && (
            <> · <b className="ok">+{added}</b> <b className="bad">−{removed}</b></>
          )}
        </span>
        <Button size="sm" className="btn btn-ghost btn-xs" style={{ marginLeft: "auto" }} onClick={() => { onRefresh(); void loadAnnotations(); }}>Refresh</Button>
        <CloseButton data-dialog-initial-focus onClick={onClose} label="Close changed files" />
      </div>
      <div className="changes-body rv-body">
        <nav className="rv-files" aria-label="Changed files">
          {loading && <p className="changes-note">Inspecting worktree…</p>}
          {error && <p className="changes-error" role="alert">{error}</p>}
          {!loading && !error && files.length === 0 && <p className="changes-note">The active worktree is clean.</p>}
          {files.map((file) => (
            <div className={selected === file.path ? "changed-file active" : "changed-file"} key={file.path}>
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
              <button
                type="button"
                className="changed-file-main"
                onClick={() => setSelected(file.path)}
                aria-current={selected === file.path}
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
        <div className="diff-view" tabIndex={0} aria-label={selected ? `Diff for ${selected}` : "File diff"}>
          {diffError && <p className="changes-error" role="alert">{diffError}</p>}
          {selected && !diff && !diffError && <p className="changes-note">Loading structured diff…</p>}
          {diff?.message && <div className={`diff-placeholder ${diff.state}`}><strong>{diff.state}</strong><p>{diff.message}</p></div>}
          {diff && threadId && <button className="file-comment-button" onClick={() => setCommentLineIndex(null)}>Comment on {diff.path}</button>}
          {diff?.patch && <pre>{diff.lines.map((line) => (
            <span className={line.side} key={line.index}>
              {line.side !== "metadata" && threadId
                ? <button
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
            <section className="annotation-composer" aria-label="New local diff comment">
              <strong>{commentLineIndex === null
                ? `Comment on ${diff.path}`
                : `Comment on ${diff.path} line ${diff.lines.find((line) => line.index === commentLineIndex)?.newLine
                  ?? diff.lines.find((line) => line.index === commentLineIndex)?.oldLine}`}
              </strong>
              <textarea
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
                aria-label="Review comment"
              />
              <footer>
                <button onClick={() => { setCommentLineIndex(undefined); setCommentText(""); }}>Cancel</button>
                <button onClick={() => void saveAnnotation()} disabled={annotationBusy || !commentText.trim()}>Save comment</button>
              </footer>
            </section>
          )}
        </div>
        <section className="annotations-panel" aria-label="Local diff comments">
          <header className="review-section-header">
            <strong>Review comments</strong>
            <small>{annotations.filter((item) => item.resolution === "unresolved").length} unresolved</small>
          </header>
          {annotations.length === 0 && <p>No local comments yet.</p>}
          <ul>
            {annotations.map((annotation) => (
              <li className={`${annotation.resolution} ${annotation.stale ? "stale" : ""}`} key={annotation.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedAnnotationIds.includes(annotation.id)}
                    onChange={(event) => setSelectedAnnotationIds((current) => event.target.checked
                      ? [...current, annotation.id]
                      : current.filter((id) => id !== annotation.id))}
                  />
                  <span>
                    <strong>{annotation.path} · {annotation.scope === "file" ? "file" : annotation.side === "deletion" ? `old line ${annotation.oldLine}` : `new line ${annotation.newLine}`}</strong>
                    <small>{annotation.stale ? annotation.staleReason : annotation.checkpointId ? "Checkpoint-bound target" : "Diff-bound target"}</small>
                    <em>{annotation.text}</em>
                  </span>
                </label>
                <button onClick={() => void setResolution(annotation)} disabled={annotationBusy}>
                  {annotation.resolution === "unresolved" ? "Resolve" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
          {annotationError && <p className="changes-error" role="alert">{annotationError}</p>}
          <Button size="sm" onClick={() => void previewRevision()} disabled={annotationBusy || selectedAnnotationIds.length === 0}>Preview revision request</Button>
        </section>
        {revisionPreview && (
          <section
            ref={revisionPreviewRef}
            tabIndex={-1}
            className="revision-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Revision request preview"
            onKeyDown={(event) => {
              handleNestedEscape(event, () => setRevisionPreview(null));
            }}
          >
            <header><strong>Exact provider context</strong><CloseButton onClick={() => setRevisionPreview(null)} label="Close revision preview" /></header>
            <pre>{revisionPreview}</pre>
            <p>Sending starts a normal follow-up turn. It does not resolve comments, edit files, approve tools, or publish a hosted review.</p>
            <footer>
              <button onClick={() => setRevisionPreview(null)}>Cancel</button>
              <Button size="sm" onClick={() => onSendRevision(revisionPreview)} disabled={!canSendRevision}>Send selected comments</Button>
            </footer>
            {!canSendRevision && <p role="alert">Configure an available provider before sending this revision request.</p>}
          </section>
        )}
        <section className="delivery-panel" aria-label="Commit, push, and pull request actions">
          <header className="review-section-header delivery-header">
            <div>
              <strong>Reviewed delivery</strong>
              <small>{delivery?.branch ?? "Detached HEAD"} · {repository.selectedWorktree}</small>
            </div>
            <span>{delivery?.upstream ?? "No upstream"}</span>
          </header>
          <div className="delivery-form">
            <label>Action<select value={deliveryAction} onChange={(event) => { setDeliveryAction(event.target.value as DeliveryAction); setPlan(null); }}>
              <option value="stage">Stage selected files</option><option value="commit">Commit staged files</option><option value="push">Push branch</option><option value="pull_request">Open pull request</option>
            </select></label>
            {deliveryAction === "commit" && <label>Commit message<input value={message} onChange={(event) => setMessage(event.target.value)} /></label>}
            {(deliveryAction === "push" || deliveryAction === "pull_request") && <label>Remote<select value={remote} onChange={(event) => setRemote(event.target.value)}>{delivery?.remotes.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.url}</option>)}</select></label>}
            {deliveryAction === "pull_request" && <><label>Base<input value={base} onChange={(event) => setBase(event.target.value)} /></label><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="delivery-body">Body<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label></>}
            {!plan && <button className="prepare-delivery" onClick={() => void prepareDelivery()} disabled={deliveryBusy || delivery?.detached}>Inspect action</button>}
          </div>
          {delivery?.detached && <p className="delivery-warning" role="alert">Detached HEAD cannot be delivered. Create or select a branch first.</p>}
          {deliveryError && <p className="delivery-warning" role="alert">{deliveryError}</p>}
          {plan && <div className="delivery-approval"><strong>{plan.summary}</strong><small>{plan.repository} · {plan.worktree} · {plan.branch}</small><ul>{plan.details.map((detail) => <li key={detail}>{detail}</li>)}</ul><footer><Button onClick={() => setPlan(null)}>Cancel</Button><Button variant="primary" size="sm" disabled={deliveryBusy} onClick={() => void executeDelivery()}>Approve once</Button></footer></div>}
        </section>
        </div>
      </div>
    </div>
  );
}


