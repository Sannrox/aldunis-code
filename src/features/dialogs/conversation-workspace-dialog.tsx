import React, { useEffect, useState } from "react";
import type { RepositoryMetadata, WorktreeCreationPlan } from "../../types";
import { Button } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

function responseError(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

export function ConversationWorkspaceDialog({
  repository,
  conversationId,
  onClose,
  onCreated,
}: {
  repository: RepositoryMetadata;
  conversationId: string;
  onClose: () => void;
  onCreated: (repository: RepositoryMetadata) => void;
}) {
  const selectedWorktree = repository.worktrees.find((worktree) => worktree.path === repository.selectedWorktree);
  const rootWorktree = repository.worktrees.find((worktree) => worktree.path === repository.root);
  const initialBase = selectedWorktree?.head ?? rootWorktree?.head ?? "HEAD";
  const [base, setBase] = useState(initialBase);
  const [branch, setBranch] = useState(() => `aldunis/chat-${conversationId.slice(0, 8)}`);
  const [plan, setPlan] = useState<WorktreeCreationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const current = repository.worktrees.find((worktree) => worktree.path === repository.selectedWorktree);
    const root = repository.worktrees.find((worktree) => worktree.path === repository.root);
    setBase(current?.head ?? root?.head ?? "HEAD");
    setBranch(`aldunis/chat-${conversationId.slice(0, 8)}`);
    setPlan(null);
    setError(null);
  }, [conversationId, repository.root, repository.selectedWorktree]);

  const preview = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/worktrees/create/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, base, branch }),
      });
      const body = await response.json() as WorktreeCreationPlan | { error?: string };
      if (!response.ok || !("action" in body) || body.action !== "create") {
        throw new Error(responseError(body, "The conversation worktree could not be prepared."));
      }
      setPlan(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation worktree could not be prepared.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/worktrees/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, confirm: true }),
      });
      const body = await response.json() as RepositoryMetadata | { error?: string };
      if (
        !response.ok
        || !("worktrees" in body)
        || typeof body.selectedWorktree !== "string"
      ) {
        throw new Error(responseError(body, "The conversation worktree could not be created."));
      }
      onCreated(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The conversation worktree could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayDialog
      title="Create Aldunis worktree"
      onClose={busy ? () => undefined : onClose}
    >
      <div className="conversation-workspace-dialog">
        <p>
          This conversation will get its own Git worktree and branch. The
          conversation will be bound to the approved canonical path.
        </p>
        {!plan ? (
          <form onSubmit={(event) => void preview(event)}>
            <label htmlFor="conversation-workspace-base">Base revision</label>
            <input
              id="conversation-workspace-base"
              value={base}
              onChange={(event) => {
                setBase(event.target.value);
                setPlan(null);
              }}
              disabled={busy}
              data-dialog-initial-focus
            />
            <label htmlFor="conversation-workspace-branch">New branch</label>
            <input
              id="conversation-workspace-branch"
              value={branch}
              onChange={(event) => {
                setBranch(event.target.value);
                setPlan(null);
              }}
              disabled={busy}
            />
            <footer>
              <Button type="button" onClick={onClose} disabled={busy}>Use another workspace</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !base.trim() || !branch.trim()}
              >
                {busy ? "Validating…" : "Preview creation"}
              </Button>
            </footer>
          </form>
        ) : (
          <section className="conversation-workspace-approval" aria-label="Approve conversation worktree">
            <strong>Create this dedicated worktree once?</strong>
            <dl>
              <div><dt>Repository</dt><dd title={plan.repository}>{plan.repository}</dd></div>
              <div><dt>Base</dt><dd title={`${plan.base} · ${plan.baseRevision}`}>{plan.base} · {plan.baseRevision}</dd></div>
              <div><dt>Branch</dt><dd title={plan.branch}>{plan.branch}</dd></div>
              <div><dt>Path</dt><dd title={plan.path}>{plan.path}</dd></div>
            </dl>
            <p>Approval is single-use. No provider process runs until this exact plan is approved.</p>
            <footer>
              <Button type="button" onClick={() => setPlan(null)} disabled={busy}>Back</Button>
              <Button type="button" variant="primary" onClick={() => void approve()} disabled={busy}>
                {busy ? "Revalidating…" : "Approve and start"}
              </Button>
            </footer>
          </section>
        )}
        {error && <div className="context-error" role="alert">{error}</div>}
      </div>
    </OverlayDialog>
  );
}
