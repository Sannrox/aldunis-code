import React, { useEffect, useMemo, useState } from "react";
import type { RepositoryMetadata, WorktreeCreationPlan } from "../../types";
import { Button } from "../../components/ui";
import { defaultWorktreeBase, worktreeBaseBranchOptions } from "../../lib/worktree-base";
import { worktreeLifecycle } from "../../lib/worktree-lifecycle";
import { OverlayDialog } from "./overlay-dialog";

export const CURRENT_WORKSPACE_RECOVERY_COPY = {
  label: "Use current workspace",
  detail:
    "Managed worktrees require a clean index; use the current workspace below to keep staged local changes.",
} as const;

export const CLEAN_REPOSITORY_ERROR =
  "Stage or discard indexed changes before creating an isolated worktree.";

export function isDirtyRepositoryError(message: string): boolean {
  return message === CLEAN_REPOSITORY_ERROR;
}

export function canUseCurrentWorkspace(
  selectedWorktree: RepositoryMetadata["worktrees"][number] | undefined,
  onUseCurrentWorkspace?: () => void,
  dirtyRepository = false,
): boolean {
  return Boolean(
    dirtyRepository && onUseCurrentWorkspace && selectedWorktree?.ownership === "user",
  );
}

export function ConversationWorkspaceDialog({
  repository,
  conversationId,
  onClose,
  onCreated,
  onUseCurrentWorkspace,
}: {
  repository: RepositoryMetadata;
  conversationId: string;
  onClose: () => void;
  onCreated: (repository: RepositoryMetadata) => void;
  onUseCurrentWorkspace?: () => void;
}) {
  const selectedWorktree = repository.worktrees.find(
    (worktree) => worktree.path === repository.selectedWorktree,
  );
  const baseOptions = useMemo(() => worktreeBaseBranchOptions(repository), [repository]);
  const [dirtyRepository, setDirtyRepository] = useState(false);
  const canUseCurrentWorkspaceOption = canUseCurrentWorkspace(
    selectedWorktree,
    onUseCurrentWorkspace,
    dirtyRepository,
  );
  const [base, setBase] = useState(() => defaultWorktreeBase(repository));
  const [branch, setBranch] = useState(() => `aldunis/chat-${conversationId.slice(0, 8)}`);
  const [plan, setPlan] = useState<WorktreeCreationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBase(defaultWorktreeBase(repository));
    setBranch(`aldunis/chat-${conversationId.slice(0, 8)}`);
    setPlan(null);
    setError(null);
    setDirtyRepository(false);
  }, [conversationId, repository]);

  const preview = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDirtyRepository(false);
    try {
      setPlan(
        await worktreeLifecycle.previewCreation(
          { root: repository.root, base, branch },
          "The conversation worktree could not be prepared.",
        ),
      );
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The conversation worktree could not be prepared.";
      setError(message);
      setDirtyRepository(isDirtyRepositoryError(message));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setDirtyRepository(false);
    try {
      onCreated(
        await worktreeLifecycle.approveCreation(
          plan.id,
          repository.projectId,
          "The conversation worktree could not be created.",
        ),
      );
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The conversation worktree could not be created.";
      setError(message);
      setDirtyRepository(isDirtyRepositoryError(message));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = Boolean(base.trim() && branch.trim());

  return (
    <OverlayDialog title="Create Aldunis worktree" onClose={onClose} dismissible={!busy}>
      <div className="conversation-workspace-dialog">
        <p>
          This conversation gets its own Git worktree and branch after one approval.
          {canUseCurrentWorkspaceOption && <> {CURRENT_WORKSPACE_RECOVERY_COPY.detail}</>}
        </p>
        {!plan ? (
          <form onSubmit={(event) => void preview(event)}>
            <label htmlFor="conversation-workspace-base">Start from</label>
            {baseOptions.length > 0 ? (
              <select
                id="conversation-workspace-base"
                value={baseOptions.includes(base) ? base : baseOptions[0]}
                onChange={(event) => {
                  setBase(event.target.value);
                  setPlan(null);
                  setDirtyRepository(false);
                }}
                disabled={busy}
                data-dialog-initial-focus
              >
                {baseOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                    {option === repository.defaultBranch ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="conversation-workspace-base"
                value={base}
                onChange={(event) => {
                  setBase(event.target.value);
                  setPlan(null);
                  setDirtyRepository(false);
                }}
                placeholder="main"
                disabled={busy}
                data-dialog-initial-focus
              />
            )}
            {!canCreate && (
              <p role="alert">
                Choose a starting branch. Open a repository with at least one local branch, or type
                a base branch name.
              </p>
            )}
            <label htmlFor="conversation-workspace-branch">New branch</label>
            <input
              id="conversation-workspace-branch"
              value={branch}
              onChange={(event) => {
                setBranch(event.target.value);
                setPlan(null);
                setDirtyRepository(false);
              }}
              disabled={busy}
            />
            <footer>
              <Button type="button" onClick={onClose} disabled={busy}>
                Use another workspace
              </Button>
              {canUseCurrentWorkspaceOption && (
                <Button type="button" onClick={onUseCurrentWorkspace} disabled={busy}>
                  {CURRENT_WORKSPACE_RECOVERY_COPY.label}
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={busy || !canCreate}>
                {busy ? "Validating…" : "Preview creation"}
              </Button>
            </footer>
          </form>
        ) : (
          <section
            className="conversation-workspace-approval"
            aria-label="Approve conversation worktree"
          >
            <strong>Create this dedicated worktree once?</strong>
            <dl>
              <div>
                <dt>Start from</dt>
                <dd title={plan.base}>{plan.base}</dd>
              </div>
              <div>
                <dt>New branch</dt>
                <dd title={plan.branch}>{plan.branch}</dd>
              </div>
            </dl>
            <details className="worktree-plan-details">
              <summary>Details</summary>
              <dl>
                <div>
                  <dt>Repository</dt>
                  <dd title={plan.repository}>{plan.repository}</dd>
                </div>
                <div>
                  <dt>Base commit</dt>
                  <dd title={plan.baseRevision}>{plan.baseRevision}</dd>
                </div>
                <div>
                  <dt>Path</dt>
                  <dd title={plan.path}>{plan.path}</dd>
                </div>
              </dl>
            </details>
            <p>
              Approval is single-use. No provider process runs until this exact plan is approved.
            </p>
            <footer>
              <Button type="button" onClick={() => setPlan(null)} disabled={busy}>
                Back
              </Button>
              {canUseCurrentWorkspaceOption && (
                <Button type="button" onClick={onUseCurrentWorkspace} disabled={busy}>
                  {CURRENT_WORKSPACE_RECOVERY_COPY.label}
                </Button>
              )}
              <Button
                type="button"
                variant="primary"
                onClick={() => void approve()}
                disabled={busy}
              >
                {busy ? "Revalidating…" : "Approve and start"}
              </Button>
            </footer>
          </section>
        )}
        {error && (
          <div className="context-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </OverlayDialog>
  );
}
