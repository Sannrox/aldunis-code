import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ChangedFile, DiffAnnotation, FileDiff, RepositoryMetadata } from "../../types";

export interface ChangedFileReviewState {
  selected: string | null;
  diff: FileDiff | null;
  diffError: string | null;
  diffRequest: number;
  annotations: DiffAnnotation[];
  annotationError: string | null;
  annotationBusy: boolean;
  annotationRequest: number;
  commentLineIndex: number | null | undefined;
  commentText: string;
  selectedAnnotationIds: string[];
  revisionPreview: string | null;
}

export type ChangedFileReviewEvent =
  | { type: "repair_selection"; files: ChangedFile[] }
  | { type: "select_file"; path: string }
  | { type: "diff_loading"; request: number }
  | { type: "diff_loaded"; request: number; diff: FileDiff }
  | { type: "diff_failed"; request: number; error: string }
  | { type: "annotations_loading"; request: number }
  | { type: "annotations_loaded"; request: number; annotations: DiffAnnotation[] }
  | { type: "annotations_failed"; request: number; error: string }
  | { type: "annotation_busy"; busy: boolean }
  | { type: "annotation_error"; error: string | null }
  | { type: "open_comment"; lineIndex: number | null }
  | { type: "set_comment_text"; text: string }
  | { type: "close_comment" }
  | { type: "toggle_annotation"; id: string; selected: boolean }
  | { type: "show_revision"; prompt: string }
  | { type: "close_revision" }
  | { type: "reset_read_only" }
  | { type: "leave_review" }
  | { type: "dismiss_nested" };

export function initialChangedFileReview(files: ChangedFile[]): ChangedFileReviewState {
  return {
    selected: files[0]?.path ?? null,
    diff: null,
    diffError: null,
    diffRequest: 0,
    annotations: [],
    annotationError: null,
    annotationBusy: false,
    annotationRequest: 0,
    commentLineIndex: undefined,
    commentText: "",
    selectedAnnotationIds: [],
    revisionPreview: null,
  };
}

export function transitionChangedFileReview(
  state: ChangedFileReviewState,
  event: ChangedFileReviewEvent,
): ChangedFileReviewState {
  if (event.type === "repair_selection") {
    if (state.selected && event.files.some((file) => file.path === state.selected)) return state;
    return { ...state, selected: event.files[0]?.path ?? null };
  }
  if (event.type === "select_file") return { ...state, selected: event.path };
  if (event.type === "diff_loading") {
    return { ...state, diff: null, diffError: null, diffRequest: event.request };
  }
  if (event.type === "diff_loaded") {
    return event.request === state.diffRequest ? { ...state, diff: event.diff } : state;
  }
  if (event.type === "diff_failed") {
    return event.request === state.diffRequest ? { ...state, diffError: event.error } : state;
  }
  if (event.type === "annotations_loading") {
    return { ...state, annotationError: null, annotationRequest: event.request };
  }
  if (event.type === "annotations_loaded") {
    if (event.request !== state.annotationRequest) return state;
    const ids = new Set(event.annotations.map((annotation) => annotation.id));
    return {
      ...state,
      annotations: event.annotations,
      selectedAnnotationIds: state.selectedAnnotationIds.filter((id) => ids.has(id)),
    };
  }
  if (event.type === "annotations_failed") {
    return event.request === state.annotationRequest
      ? { ...state, annotationError: event.error }
      : state;
  }
  if (event.type === "annotation_busy") return { ...state, annotationBusy: event.busy };
  if (event.type === "annotation_error") return { ...state, annotationError: event.error };
  if (event.type === "open_comment") return { ...state, commentLineIndex: event.lineIndex };
  if (event.type === "set_comment_text") return { ...state, commentText: event.text };
  if (event.type === "close_comment") {
    return { ...state, commentLineIndex: undefined, commentText: "" };
  }
  if (event.type === "toggle_annotation") {
    return {
      ...state,
      selectedAnnotationIds: event.selected
        ? [...new Set([...state.selectedAnnotationIds, event.id])]
        : state.selectedAnnotationIds.filter((id) => id !== event.id),
    };
  }
  if (event.type === "show_revision") return { ...state, revisionPreview: event.prompt };
  if (event.type === "close_revision") return { ...state, revisionPreview: null };
  if (event.type === "reset_read_only") {
    return {
      ...state,
      annotations: [],
      annotationError: null,
      commentLineIndex: undefined,
      commentText: "",
      selectedAnnotationIds: [],
      revisionPreview: null,
    };
  }
  if (event.type === "leave_review") {
    return { ...state, commentLineIndex: undefined, commentText: "", revisionPreview: null };
  }
  if (state.revisionPreview) return { ...state, revisionPreview: null };
  if (state.commentLineIndex !== undefined) {
    return { ...state, commentLineIndex: undefined, commentText: "" };
  }
  return state;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * Keep one expensive diff read active and retain only the newest selection as
 * follow-up work. The host finishes an admitted Git read normally; the pane
 * bounds how many such reads it can admit and never publishes after disposal.
 */
export class LatestReviewDiffCoordinator<Input, Output> {
  private active = false;
  private queued: Input | null = null;
  private disposed = false;

  constructor(
    private readonly load: (input: Input) => Promise<Output>,
    private readonly loaded: (input: Input, output: Output) => void,
    private readonly failed: (input: Input, cause: unknown) => void,
  ) {}

  request(input: Input): void {
    if (this.disposed) return;
    if (this.active) {
      this.queued = input;
      return;
    }
    void this.start(input);
  }

  clearPending(): void {
    this.queued = null;
  }

  dispose(): void {
    this.disposed = true;
    this.queued = null;
  }

  private async start(input: Input): Promise<void> {
    this.active = true;
    try {
      const output = await this.load(input);
      if (!this.disposed) this.loaded(input, output);
    } catch (cause) {
      if (!this.disposed) this.failed(input, cause);
    } finally {
      this.active = false;
      const next = this.queued;
      this.queued = null;
      if (!this.disposed && next !== null) void this.start(next);
    }
  }
}

interface ReviewDiffRequest {
  request: number;
  route: string;
  body: {
    root: string;
    worktree: string;
    path: string;
  };
}

export function useChangedFileReviewSession({
  repository,
  threadId,
  files,
  checkpointId,
  readOnly,
}: {
  repository: RepositoryMetadata;
  threadId: string | null;
  files: ChangedFile[];
  checkpointId: string | null;
  readOnly: boolean;
}) {
  const [state, dispatch] = useReducer(
    transitionChangedFileReview,
    files,
    initialChangedFileReview,
  );
  const diffRequest = useRef(0);
  const annotationRequest = useRef(0);
  const diffCoordinator = useRef<LatestReviewDiffCoordinator<ReviewDiffRequest, FileDiff> | null>(
    null,
  );
  const getDiffCoordinator = useCallback(() => {
    if (!diffCoordinator.current) {
      diffCoordinator.current = new LatestReviewDiffCoordinator(
        async (input) => {
          const response = await fetch(input.route, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input.body),
          });
          const body = (await response.json()) as FileDiff | { error?: string };
          if (!response.ok)
            throw new Error("error" in body ? body.error : "Diff could not be read.");
          return body as FileDiff;
        },
        (input, diff) => dispatch({ type: "diff_loaded", request: input.request, diff }),
        (input, cause) =>
          dispatch({
            type: "diff_failed",
            request: input.request,
            error: errorMessage(cause, "Diff could not be read."),
          }),
      );
    }
    return diffCoordinator.current;
  }, []);

  useEffect(() => dispatch({ type: "repair_selection", files }), [files]);
  useEffect(
    () => () => {
      diffCoordinator.current?.dispose();
      diffCoordinator.current = null;
    },
    [],
  );
  useEffect(() => {
    const request = ++diffRequest.current;
    dispatch({ type: "diff_loading", request });
    const coordinator = getDiffCoordinator();
    coordinator.clearPending();
    if (!state.selected) return;
    coordinator.request({
      request,
      route: checkpointId ? `/api/checkpoints/${checkpointId}/diff` : "/api/changes/diff",
      body: {
        root: repository.root,
        worktree: repository.selectedWorktree,
        path: state.selected,
      },
    });
  }, [
    checkpointId,
    getDiffCoordinator,
    repository.root,
    repository.selectedWorktree,
    state.selected,
  ]);

  const loadAnnotations = useCallback(async () => {
    const request = ++annotationRequest.current;
    dispatch({ type: "annotations_loading", request });
    if (readOnly || !threadId) {
      dispatch({ type: "annotations_loaded", request, annotations: [] });
      return;
    }
    try {
      const response = await fetch("/api/annotations/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
        }),
      });
      const body = (await response.json()) as { annotations?: DiffAnnotation[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Annotations could not be loaded.");
      dispatch({ type: "annotations_loaded", request, annotations: body.annotations ?? [] });
    } catch (cause) {
      dispatch({
        type: "annotations_failed",
        request,
        error: errorMessage(cause, "Annotations could not be loaded."),
      });
    }
  }, [readOnly, repository.root, repository.selectedWorktree, threadId]);

  useEffect(() => void loadAnnotations(), [loadAnnotations]);
  useEffect(() => {
    if (readOnly) dispatch({ type: "reset_read_only" });
  }, [checkpointId, readOnly]);

  const saveAnnotation = useCallback(async () => {
    if (
      readOnly ||
      !threadId ||
      !state.selected ||
      !state.diff ||
      state.commentLineIndex === undefined ||
      !state.commentText.trim()
    )
      return;
    dispatch({ type: "annotation_busy", busy: true });
    dispatch({ type: "annotation_error", error: null });
    try {
      const response = await fetch("/api/annotations/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          path: state.selected,
          diffIdentity: state.diff.identity,
          scope: state.commentLineIndex === null ? "file" : "line",
          lineIndex: state.commentLineIndex,
          text: state.commentText,
        }),
      });
      const body = (await response.json()) as DiffAnnotation | { error?: string };
      if (!response.ok)
        throw new Error("error" in body ? body.error : "The annotation could not be saved.");
      dispatch({ type: "close_comment" });
      await loadAnnotations();
    } catch (cause) {
      dispatch({
        type: "annotation_error",
        error: errorMessage(cause, "The annotation could not be saved."),
      });
    } finally {
      dispatch({ type: "annotation_busy", busy: false });
    }
  }, [loadAnnotations, readOnly, repository.root, repository.selectedWorktree, state, threadId]);

  const setResolution = useCallback(
    async (annotation: DiffAnnotation) => {
      if (readOnly || !threadId) return;
      dispatch({ type: "annotation_busy", busy: true });
      dispatch({ type: "annotation_error", error: null });
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
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "The annotation could not be updated.");
        await loadAnnotations();
      } catch (cause) {
        dispatch({
          type: "annotation_error",
          error: errorMessage(cause, "The annotation could not be updated."),
        });
      } finally {
        dispatch({ type: "annotation_busy", busy: false });
      }
    },
    [loadAnnotations, readOnly, repository.root, repository.selectedWorktree, threadId],
  );

  const previewRevision = useCallback(async () => {
    if (readOnly || !threadId || state.selectedAnnotationIds.length === 0) return;
    dispatch({ type: "annotation_busy", busy: true });
    dispatch({ type: "annotation_error", error: null });
    try {
      const response = await fetch("/api/annotations/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          annotationIds: state.selectedAnnotationIds,
        }),
      });
      const body = (await response.json()) as { prompt?: string; error?: string };
      if (!response.ok || !body.prompt) {
        throw new Error(body.error ?? "The revision request could not be previewed.");
      }
      dispatch({ type: "show_revision", prompt: body.prompt });
    } catch (cause) {
      dispatch({
        type: "annotation_error",
        error: errorMessage(cause, "The revision request could not be previewed."),
      });
    } finally {
      dispatch({ type: "annotation_busy", busy: false });
    }
  }, [
    readOnly,
    repository.root,
    repository.selectedWorktree,
    state.selectedAnnotationIds,
    threadId,
  ]);

  return { state, dispatch, loadAnnotations, saveAnnotation, setResolution, previewRevision };
}
