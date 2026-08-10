import React, { useEffect, useState } from "react";
import type { RepositoryMetadata, WorktreeCreationPlan } from "../../types";
import { Button } from "../../components/ui";
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
  const [dirtyRepository, setDirtyRepository] = useState(false);
  const canUseCurrentWorkspaceOption = canUseCurrentWorkspace(
    selectedWorktree,
    onUseCurrentWorkspace,
    dirtyRepository,
  );
  const [base, setBase] = useState(repository.defaultBranch ?? "");
  const [branch, setBranch] = useState(() => `aldunis/chat-${conversationId.slice(0, 8)}`);
  const [plan, setPlan] = useState<WorktreeCreationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBase(repository.defaultBranch ?? "");
    setBranch(`aldunis/chat-${conversationId.slice(0, 8)}`);
    setPlan(null);
    setError(null);
    setDirtyRepository(false);
  }, [conversationId, repository.defaultBranch, repository.root, repository.selectedWorktree]);

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

  return (
    <OverlayDialog title="Create Aldunis worktree" onClose={busy ? () => undefined : onClose}>
      <div className="conversation-workspace-dialog">
        <p>
          This conversation will get its own Git worktree and branch. The conversation will be bound
          to the approved canonical path.
          {canUseCurrentWorkspaceOption && <> {CURRENT_WORKSPACE_RECOVERY_COPY.detail}</>}
        </p>
        {!plan ? (
          <form onSubmit={(event) => void preview(event)}>
            <label htmlFor="conversation-workspace-base">Default branch</label>
            <input
              id="conversation-workspace-base"
              value={base}
              readOnly
              aria-readonly="true"
              disabled={busy}
            />
            {!repository.defaultBranch && (
              <p role="alert">
                The default branch could not be determined. Configure one remote HEAD or a
                conventional local default branch before creating a worktree.
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
              data-dialog-initial-focus
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
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !repository.defaultBranch || !branch.trim()}
              >
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
                <dt>Repository</dt>
                <dd title={plan.repository}>{plan.repository}</dd>
              </div>
              <div>
                <dt>Base</dt>
                <dd title={`${plan.base} · ${plan.baseRevision}`}>
                  {plan.base} · {plan.baseRevision}
                </dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd title={plan.branch}>{plan.branch}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd title={plan.path}>{plan.path}</dd>
              </div>
            </dl>
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
