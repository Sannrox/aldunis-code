import React, { useEffect, useMemo, useState } from "react";
import type { ConversationSummary, InteractionMode } from "../../types";
import { Button } from "../../components/ui";
import {
  ConversationMailboxSessionModule,
  MAILBOX_TEXT_MAX_CHARS,
  clampMailboxText,
  mailboxTextLength,
} from "../../lib/mailbox-session";
import { OverlayDialog } from "./overlay-dialog";

export const MAILBOX_DIALOG_COPY = {
  title: "Send to another conversation",
  help: "The destination receives this text as a normal turn. The source keeps an inspectable copy that is not added to this provider session.",
  reviewHelp:
    "Confirm the exact payload. Canceling creates no destination turn and writes no mailbox record.",
  emptyDestinations: "No other conversations are available in this project.",
} as const;

const mailboxSession = new ConversationMailboxSessionModule();

export function mailboxReviewLines(input: {
  sourceTitle: string;
  destinationTitle: string;
  mode: InteractionMode;
  text: string;
}): string[] {
  return [`From ${input.sourceTitle}`, `To ${input.destinationTitle}`, `Mode ${input.mode}`, input.text.trim()];
}

export function SendMailboxMessageDialog({
  source,
  destinations,
  onClose,
  onSent,
}: {
  source: ConversationSummary;
  destinations: ConversationSummary[];
  onClose: () => void;
  onSent: (destinationThreadId: string) => void;
}) {
  const [destinationId, setDestinationId] = useState(destinations[0]?.id ?? "");
  const [text, setText] = useState("");
  const [mode, setMode] = useState<InteractionMode>("ask");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [destinationId, text, mode]);
  const destination = destinations.find((item) => item.id === destinationId) ?? null;
  const trimmedLength = mailboxTextLength(text);
  const canReview = Boolean(destination) && trimmedLength > 0 && trimmedLength <= MAILBOX_TEXT_MAX_CHARS;
  const destinationIdField = `mailbox-destination-${source.id}`;
  const textId = `mailbox-text-${source.id}`;
  const modeId = `mailbox-mode-${source.id}`;

  const reviewLines = useMemo(
    () =>
      mailboxReviewLines({
        sourceTitle: source.title,
        destinationTitle: destination?.title ?? "another conversation",
        mode,
        text,
      }),
    [destination?.title, mode, source.title, text],
  );

  const submitReview = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canReview) return;
    setError(null);
    setIdempotencyKey((current) => current || crypto.randomUUID());
    setReviewing(true);
  };

  const confirm = async () => {
    if (!destination || busy) return;
    setBusy(true);
    setError(null);
    try {
      await mailboxSession.send({
        sourceThreadId: source.id,
        destinationThreadId: destination.id,
        text: text.trim(),
        mode,
        idempotencyKey,
      });
      onSent(destination.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The mailbox message could not be sent.");
      setBusy(false);
    }
  };

  return (
    <OverlayDialog
      title={MAILBOX_DIALOG_COPY.title}
      onClose={busy ? () => undefined : onClose}
    >
      {reviewing ? (
        <div className="mailbox-send-dialog">
          <p className="mailbox-send-help">
            {MAILBOX_DIALOG_COPY.reviewHelp}
          </p>
          <pre className="mailbox-send-review">{reviewLines.join("\n\n")}</pre>
          {error ? <p className="mailbox-send-error">{error}</p> : null}
          <footer>
            <Button type="button" variant="ghost" onClick={() => setReviewing(false)} disabled={busy}>
              Back
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </footer>
        </div>
      ) : (
        <form className="mailbox-send-dialog" onSubmit={submitReview}>
          <p className="mailbox-send-help">
            {MAILBOX_DIALOG_COPY.help}
          </p>
          {destinations.length === 0 ? (
            <p className="mailbox-send-error">{MAILBOX_DIALOG_COPY.emptyDestinations}</p>
          ) : (
            <>
              <label htmlFor={destinationIdField}>Destination</label>
              <select
                id={destinationIdField}
                value={destinationId}
                onChange={(event) => setDestinationId(event.target.value)}
                data-dialog-initial-focus
              >
                {destinations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <label htmlFor={textId}>Message</label>
              <textarea
                id={textId}
                value={text}
                onChange={(event) => setText(clampMailboxText(event.target.value))}
                rows={6}
                placeholder="Write the exact message the destination conversation should receive…"
              />
              <p className="mailbox-send-note">
                {trimmedLength}/{MAILBOX_TEXT_MAX_CHARS} characters
              </p>
              <label htmlFor={modeId}>Destination mode</label>
              <select
                id={modeId}
                value={mode}
                onChange={(event) => setMode(event.target.value as InteractionMode)}
              >
                <option value="ask">Ask · read-only</option>
                <option value="plan">Plan · mutations blocked</option>
                <option value="build">Build · approvals still required</option>
              </select>
            </>
          )}
          {error ? <p className="mailbox-send-error">{error}</p> : null}
          <footer>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canReview}>
              Review
            </Button>
          </footer>
        </form>
      )}
    </OverlayDialog>
  );
}
