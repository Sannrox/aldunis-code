import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { RepositoryMetadata, WorktreeCreationPlan, WorktreeRemovalPlan } from "../../types";
import { Button, ModalSurface } from "../../components/ui";

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
  const [base, setBase] = useState("main");
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
    setBase(repository?.worktrees.find((worktree) => worktree.path === repository.root)?.branch ?? "main");
  }, [repository?.root, selectedPath]);
  if (!repository) return null;

  const request = async (route: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as RepositoryMetadata | WorktreeCreationPlan | WorktreeRemovalPlan | { error?: string };
      if (!response.ok) throw new Error("error" in result ? result.error : "The worktree operation failed.");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The worktree operation failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const previewCreate = async (event: FormEvent) => {
    event.preventDefault();
    const result = await request("/api/worktrees/create/preview", {
      root: repository.root,
      base,
      branch,
      ...(!managedMode && path.trim() ? { path } : {}),
    });
    if (result && "action" in result && result.action === "create") setPlan(result);
  };
  const previewRemove = async () => {
    if (!selected) return;
    const result = await request("/api/worktrees/remove/preview", {
      root: repository.root,
      path: selected.path,
    });
    if (result && "action" in result && result.action === "remove") setPlan(result);
  };
  const confirm = async () => {
    if (!plan) return;
    if (plan.action === "create") {
      const result = await request("/api/worktrees/create", { planId: plan.id, confirm: true });
      if (result && "worktrees" in result) {
        onChanged(result);
        onClose();
      }
      return;
    }
    const result = await request("/api/worktrees/remove", { planId: plan.id, confirm: true });
    if (!result) return;
    const refreshed = await request(
      "/api/repositories/open",
      managedMode
        ? { repositoryId: repository.managedRepositoryId }
        : { path: repository.root },
    );
    if (refreshed && "worktrees" in refreshed) onChanged(refreshed);
    onClose();
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
              <div><dt>Repository</dt><dd title={repository.root}>{repository.root}</dd></div>
              <div><dt>Worktree</dt><dd title={selected.path}>{selected.path}</dd></div>
              <div><dt>Branch</dt><dd title={selected.branch ?? "Detached HEAD"}>{selected.branch ?? "Detached HEAD"}</dd></div>
              <div><dt>Ownership</dt><dd>{selected.ownership === "aldunis" ? `Aldunis · ${selected.recovery}` : "User-created"}</dd></div>
            </dl>
            {selected.ownership === "user" && <p>This worktree remains selectable, but Aldunis Code does not claim or remove it.</p>}
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
            <label htmlFor="worktree-base">Base revision</label>
            <input
              id="worktree-base"
              name="worktree-base"
              data-dialog-initial-focus
              value={base}
              onChange={(event) => { setBase(event.target.value); setPlan(null); }}
              disabled={busy}
            />
            <label htmlFor="worktree-branch">New branch</label>
            <input
              id="worktree-branch"
              name="worktree-branch"
              value={branch}
              onChange={(event) => { setBranch(event.target.value); setPlan(null); }}
              placeholder="codex/26-isolated-worktree"
              disabled={busy}
            />
            {!managedMode && <>
              <label htmlFor="worktree-path">Worktree path <span>(optional)</span></label>
              <input
                id="worktree-path"
                name="worktree-path"
                value={path}
                onChange={(event) => { setPath(event.target.value); setPlan(null); }}
                placeholder="Managed application path"
                disabled={busy}
              />
            </>}
            {managedMode && <p>Code will choose a same-filesystem worktree path for this managed repository.</p>}
            {!plan && (
              <footer>
                <Button type="button" onClick={onClose} aria-label="Cancel worktree changes">Cancel</Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !base.trim() || !branch.trim()}
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
            <strong>{plan.action === "create" ? "Create this isolated worktree once?" : "Remove this worktree checkout once?"}</strong>
            <dl>
              <div><dt>Repository</dt><dd title={plan.repository}>{plan.repository}</dd></div>
              {plan.action === "create" && (
                <div><dt>Base</dt><dd title={`${plan.base} · ${plan.baseRevision}`}>{plan.base} · {plan.baseRevision}</dd></div>
              )}
              <div><dt>Branch</dt><dd title={plan.branch}>{plan.branch}</dd></div>
              <div><dt>Path</dt><dd title={plan.path}>{plan.path}</dd></div>
            </dl>
            <p>{plan.action === "create"
              ? "Approval is single-use. The conversation will be bound to the canonical result."
              : "Only the clean checkout is removed. The branch, commits, remotes, and conversation history remain."}</p>
            <footer>
              <Button onClick={() => setPlan(null)} disabled={busy} aria-label="Back to worktree form">Back</Button>
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
        {error && <div className="repository-error" role="alert">{error}</div>}
        {selected && !plan && (
          <footer>
            <Button onClick={onClose} aria-label="Close worktree manager">Close</Button>
          </footer>
        )}
    </ModalSurface>
  );
}

