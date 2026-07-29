import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../types";
import { Button, Field, Input, WorkbenchDialog } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";

export function normalizedConversationTitle(value: string): string | null {
  const title = value.trim();
  return title.length > 0 ? title : null;
}

export function RenameConversationDialog({
  conversation,
  onClose,
  onRename,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
  onRename: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTitle(conversation.title);
    setError(null);
    const focusInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const frame = window.requestAnimationFrame(focusInput);
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.id, conversation.title]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizedConversationTitle(title);
    if (!normalized || busy) return;
    setBusy(true);
    setError(null);
    void onRename(normalized)
      .then(onClose)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Conversation rename failed.");
      })
      .finally(() => setBusy(false));
  };

  const provider = conversation.provider
    ? providerListLabel(conversation.provider)
    : "Unknown provider";

  return (
    <WorkbenchDialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="Rename conversation"
      titleId="rename-conversation-title"
      className="quick-dialog"
      backdropClassName="dialog-backdrop"
      closeLabel="Close rename conversation"
    >
      <form className="rename-conversation-form" onSubmit={submit}>
        <p className="rename-conversation-context">
          {conversation.projectName ?? "Project"} · {provider}
        </p>
        <Field
          label="Conversation title"
          htmlFor="rename-conversation-input"
          error={error}
        >
          <Input
            ref={inputRef}
            id="rename-conversation-input"
            name="rename-conversation-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            disabled={busy}
            aria-describedby="rename-conversation-help"
          />
        </Field>
        <p id="rename-conversation-help" className="rename-conversation-help">
          This changes local conversation metadata only.
        </p>
        <footer>
          <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!normalizedConversationTitle(title) || busy}
          >
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </footer>
      </form>
    </WorkbenchDialog>
  );
}
