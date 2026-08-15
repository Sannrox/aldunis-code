import React, { FormEvent, useEffect, useMemo, useState } from "react";
import type { RepositoryMetadata, WorktreeCreationPlan, WorktreeRemovalPlan } from "../../types";
import { Button, ModalSurface } from "../../components/ui";
import { defaultWorktreeBase, worktreeBaseBranchOptions } from "../../lib/worktree-base";
import { worktreeLifecycle } from "../../lib/worktree-lifecycle";
import { BranchSuggestionInput } from "./branch-suggestion-input";

export function WorktreeDialog({
  repository,
  selectedPath,
  managedMode = false,
  onClose,
  onChanged,
}: {
  repository: RepositoryMetadata | null;
  selectedPath: string | null;
  managedMode?: boolean;
  onClose: () => void;
  onChanged: (repository: RepositoryMetadata) => void;
}) {
  const selected = repository?.worktrees.find((worktree) => worktree.path === selectedPath) ?? null;
  const baseOptions = useMemo(
    () => (repository ? worktreeBaseBranchOptions(repository) : []),
    [repository],
  );
  const [base, setBase] = useState(() => (repository ? defaultWorktreeBase(repository) : ""));
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<WorktreeCreationPlan | WorktreeRemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = repository !== null && selectedPath !== undefined;
  useEffect(() => {
    setPlan(null);
    setError(null);
    setBranch("");
    setPath("");
    setBase(repository ? defaultWorktreeBase(repository) : "");
  }, [repository, selectedPath]);
  if (!repository) return null;

  const canCreate = Boolean(base.trim() && branch.trim());

  const previewCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await worktreeLifecycle.previewCreation(
          {
            root: repository.root,
            base,
            branch,
            ...(!managedMode && path.trim() ? { path } : {}),
          },
          "The worktree operation failed.",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The worktree operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const previewRemove = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await worktreeLifecycle.previewRemoval(
          { root: repository.root, path: selected.path },
          "The worktree operation failed.",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The worktree operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      if (plan.action === "create") {
        const result = await worktreeLifecycle.approveCreation(
          plan.id,
          repository.projectId,
          "The worktree operation failed.",
        );
        onChanged(result);
        onClose();
        return;
      }
      await worktreeLifecycle.approveRemoval(plan.id, "The worktree operation failed.");
      try {
        const refreshed = await worktreeLifecycle.refreshRepository(
          managedMode
            ? { repositoryId: repository.managedRepositoryId ?? "" }
            : { path: repository.root },
          "The worktree operation failed.",
        );
        onChanged(refreshed);
      } catch {
        // Removal is already complete and its approval is consumed. The shell
        // will rediscover the repository on its next ordinary refresh.
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The worktree operation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalSurface
      open={open}
      onClose={onClose}
      dismissible={!busy}
      className="repository-dialog worktree-dialog"
      ariaLabelledBy="worktree-dialog-title"
    >
      <p className="eyebrow">Isolated conversation workspace</p>
      <h2 id="worktree-dialog-title">{selected ? "Manage worktree" : "Create worktree"}</h2>
      {selected ? (
        <>
          <dl className="worktree-details">
            <div>
              <dt>Repository</dt>
              <dd title={repository.root}>{repository.root}</dd>
            </div>
            <div>
              <dt>Worktree</dt>
              <dd title={selected.path}>{selected.path}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd title={selected.branch ?? "Detached HEAD"}>
                {selected.branch ?? "Detached HEAD"}
              </dd>
            </div>
            <div>
              <dt>Ownership</dt>
              <dd>
                {selected.ownership === "aldunis"
                  ? `Aldunis · ${selected.recovery}`
                  : "User-created"}
              </dd>
            </div>
          </dl>
          {selected.ownership === "user" && (
            <p>This worktree remains selectable, but Aldunis Code does not claim or remove it.</p>
          )}
          {selected.ownership === "aldunis" && !plan && (
            <Button
              variant="danger"
              size="sm"
              className="worktree-remove"
              onClick={() => void previewRemove()}
              disabled={busy || selected.recovery !== "available"}
              aria-label={
                busy
                  ? `Inspecting removal of worktree ${selected.branch ?? selected.path}`
                  : `Preview removal of worktree ${selected.branch ?? selected.path}`
              }
            >
              {busy ? "Inspecting…" : "Preview worktree removal"}
            </Button>
          )}
        </>
      ) : (
        <form onSubmit={previewCreate}>
          <label htmlFor="worktree-base">Start from</label>
          <BranchSuggestionInput
            id="worktree-base"
            name="worktree-base"
            value={base}
            options={baseOptions}
            defaultBranch={repository.defaultBranch}
            branchCount={repository.localBranchCount}
            truncated={repository.localBranchesTruncated}
            onChange={(value) => {
              setBase(value);
              setPlan(null);
            }}
            disabled={busy}
          />
          {!canCreate && !branch.trim() ? null : !base.trim() ? (
            <p role="alert">Choose a starting branch before creating a worktree.</p>
          ) : null}
          <label htmlFor="worktree-branch">New branch</label>
          <input
            id="worktree-branch"
            name="worktree-branch"
            data-dialog-initial-focus
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value);
              setPlan(null);
            }}
            placeholder="codex/26-isolated-worktree"
            disabled={busy}
          />
          {!managedMode && (
            <>
              <label htmlFor="worktree-path">
                Worktree path <span>(optional)</span>
              </label>
              <input
                id="worktree-path"
                name="worktree-path"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setPlan(null);
                }}
                placeholder="Managed application path"
                disabled={busy}
              />
            </>
          )}
          {managedMode && (
            <p>Code will choose a same-filesystem worktree path for this managed repository.</p>
          )}
          {!plan && (
            <footer>
              <Button type="button" onClick={onClose} aria-label="Cancel worktree changes">
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !canCreate}
                aria-label={busy ? "Validating worktree creation" : "Preview worktree creation"}
              >
                {busy ? "Validating…" : "Preview creation"}
              </Button>
            </footer>
          )}
        </form>
      )}
      {plan && (
        <section className="worktree-approval" aria-label={`Approve worktree ${plan.action}`}>
          <strong>
            {plan.action === "create"
              ? "Create this isolated worktree once?"
              : "Remove this worktree checkout once?"}
          </strong>
          {plan.action === "create" ? (
            <>
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
            </>
          ) : (
            <dl>
              <div>
                <dt>Branch</dt>
                <dd title={plan.branch}>{plan.branch}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd title={plan.path}>{plan.path}</dd>
              </div>
            </dl>
          )}
          <p>
            {plan.action === "create"
              ? "Approval is single-use. The conversation will be bound to the canonical result."
              : "Only the clean checkout is removed. The branch, commits, remotes, and conversation history remain."}
          </p>
          <footer>
            <Button
              onClick={() => setPlan(null)}
              disabled={busy}
              aria-label="Back to worktree form"
            >
              Back
            </Button>
            <Button
              variant={plan.action === "remove" ? "danger" : "primary"}
              size="sm"
              onClick={() => void confirm()}
              disabled={busy}
              aria-label={
                busy
                  ? "Revalidating worktree plan"
                  : plan.action === "remove"
                    ? `Approve once: remove worktree ${plan.branch}`
                    : `Approve once: create worktree ${plan.branch}`
              }
            >
              {busy ? "Revalidating…" : "Approve once"}
            </Button>
          </footer>
        </section>
      )}
      {error && (
        <div className="repository-error" role="alert">
          {error}
        </div>
      )}
      {selected && !plan && (
        <footer>
          <Button onClick={onClose} aria-label="Close worktree manager">
            Close
          </Button>
        </footer>
      )}
    </ModalSurface>
  );
}
