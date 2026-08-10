import React, { useState } from "react";
import { Button, WorkbenchDialog } from "../../components/ui";

export function ReleaseWorktreeDialog({
  title,
  provider,
  worktree,
  settle,
  bulkCount,
  onClose,
  onConfirm,
}: {
  title: string;
  provider: string;
  worktree?: string | null;
  settle?: boolean;
  /** When set, confirm releasing this many settled managed worktrees. */
  bulkCount?: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bulk = typeof bulkCount === "number" && bulkCount > 0;
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onConfirm()
      .then(onClose)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Managed worktree release failed.");
      })
      .finally(() => setBusy(false));
  };

  const dialogTitle = bulk
    ? bulkCount === 1
      ? "Release 1 settled worktree?"
      : `Release ${bulkCount} settled worktrees?`
    : settle
      ? "Settle and release worktree?"
      : "Release managed worktree?";
  const confirmLabel = bulk
    ? bulkCount === 1
      ? "Release 1 worktree"
      : `Release ${bulkCount} worktrees`
    : settle
      ? "Settle and release"
      : "Release worktree";

  return (
    <WorkbenchDialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={dialogTitle}
      titleId="release-worktree-title"
      className="quick-dialog"
      backdropClassName="dialog-backdrop"
      closeLabel="Close worktree release"
    >
      <div className="release-worktree-dialog">
        <p className="release-worktree-context">
          <strong>{title}</strong>
          <span>{provider}</span>
        </p>
        {!bulk && worktree && <code title={worktree}>{worktree}</code>}
        {bulk && (
          <p>
            Releases only clean Aldunis-managed checkouts still held by settled conversations in
            this shelf. Dirty or busy worktrees are skipped and reported.
          </p>
        )}
        <dl className="release-worktree-impact">
          <div>
            <dt>Removed</dt>
            <dd>{bulk ? "Eligible managed worktree checkouts" : "Managed worktree checkout"}</dd>
          </div>
          <div>
            <dt>Kept</dt>
            <dd>
              Conversation{bulk ? "s" : ""} and Git branch{bulk ? "es" : ""}
            </dd>
          </div>
        </dl>
        {settle && !bulk && <p>The conversation will also move to Settled.</p>}
        {error && (
          <p className="repository-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={confirm} disabled={busy}>
            {busy ? "Releasing…" : confirmLabel}
          </Button>
        </footer>
      </div>
    </WorkbenchDialog>
  );
}
