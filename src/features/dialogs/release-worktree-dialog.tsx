import React, { useState } from "react";
import { Button, WorkbenchDialog } from "../../components/ui";

export function ReleaseWorktreeDialog({
  title,
  provider,
  worktree,
  settle,
  onClose,
  onConfirm,
}: {
  title: string;
  provider: string;
  worktree?: string | null;
  settle?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <WorkbenchDialog
      open
      onClose={onClose}
      dismissible={!busy}
      title={settle ? "Settle and release worktree?" : "Release managed worktree?"}
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
        {worktree && <code title={worktree}>{worktree}</code>}
        <dl className="release-worktree-impact">
          <div><dt>Removed</dt><dd>Managed worktree checkout</dd></div>
          <div><dt>Kept</dt><dd>Conversation and Git branch</dd></div>
        </dl>
        {settle && <p>The conversation will also move to Settled.</p>}
        {error && <p className="repository-error" role="alert">{error}</p>}
        <footer>
          <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="danger" onClick={confirm} disabled={busy}>
            {busy ? "Releasing…" : settle ? "Settle and release" : "Release worktree"}
          </Button>
        </footer>
      </div>
    </WorkbenchDialog>
  );
}
