import React from "react";
import type { ConversationSummary } from "../../types";
import { Button } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";

export function MissingConversation({
  pane,
  conversations,
  onReplace,
  onClose,
}: {
  pane: "primary" | "secondary";
  conversations: ConversationSummary[];
  onReplace: (id: string | null) => void;
  onClose?: () => void;
}) {
  return (
    <section className="missing-conversation" role="region" aria-label={`${pane} conversation unavailable`}>
      <span>{pane} pane</span>
      <h2>Conversation unavailable</h2>
      <p>It may have been deleted, archived, or created by an incompatible local state version. Choose a replacement; no provider session was ended.</p>
      <label htmlFor={`${pane}-replacement-conversation`}>
        Replacement conversation
        <select
          id={`${pane}-replacement-conversation`}
          name={`${pane}-replacement-conversation`}
          defaultValue=""
          onChange={(event) => { if (event.target.value) onReplace(event.target.value); }}
        >
          <option value="" disabled>Choose a conversation…</option>
          {conversations.map((conversation) => {
            const title = conversation.title.trim() || "Conversation";
            const provider = conversation.provider
              ? providerListLabel(conversation.provider)
              : null;
            return (
              <option value={conversation.id} key={conversation.id}>
                {provider ? `${title} · ${provider}` : title}
              </option>
            );
          })}
        </select>
      </label>
      {onClose && (
        <Button type="button" size="sm" onClick={onClose} aria-label={`Close ${pane} pane`}>
          Close pane
        </Button>
      )}
    </section>
  );
}


