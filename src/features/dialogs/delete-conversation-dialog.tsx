import React, { useState } from "react";
import type { ConversationSummary } from "../../types";
import { Button, WorkbenchDialog } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";

export type ConversationDeletionPreview = {
  affectedRecords?: Record<string, number>;
  excluded?: string[];
};

export function affectedDeletionRecords(
  preview: ConversationDeletionPreview,
): Array<[string, number]> {
  return Object.entries(preview.affectedRecords ?? {}).filter(([, count]) => count > 0);
}

export function DeleteConversationDialog({
  conversation,
  preview,
  onClose,
  onDelete,
}: {
  conversation: ConversationSummary;
  preview: ConversationDeletionPreview;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const affected = affectedDeletionRecords(preview);
  const provider = conversation.provider
    ? providerListLabel(conversation.provider)
    : "Unknown provider";

  const remove = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onDelete()
      .then(onClose)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Conversation deletion failed.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <WorkbenchDialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Delete conversation?"
      titleId="delete-conversation-title"
      className="quick-dialog"
      backdropClassName="dialog-backdrop"
      closeLabel="Close delete conversation"
    >
      <div className="delete-conversation-dialog">
        <p className="delete-conversation-context">
          <strong>{conversation.title}</strong>
          <span>{conversation.projectName ?? "Project"} · {provider}</span>
        </p>
        <p>This permanently removes the following local data:</p>
        <dl className="delete-conversation-impact">
          {affected.map(([name, count]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
        {(preview.excluded?.length ?? 0) > 0 && (
          <section className="delete-conversation-excluded" aria-labelledby="delete-conversation-excluded-title">
            <h3 id="delete-conversation-excluded-title">Not removed</h3>
            <ul>
              {preview.excluded?.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}
        <p className="delete-conversation-warning">This action cannot be undone.</p>
        {error && <p className="repository-error" role="alert">{error}</p>}
        <footer>
          <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="danger" onClick={remove} disabled={busy}>
            {busy ? "Deleting…" : "Delete conversation"}
          </Button>
        </footer>
      </div>
    </WorkbenchDialog>
  );
}
