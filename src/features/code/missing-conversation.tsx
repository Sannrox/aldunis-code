import React, { FormEvent, useEffect, useRef, useState } from "react";
import type { ConversationSummary } from "../../types";

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
          {conversations.map((conversation) => (
            <option value={conversation.id} key={conversation.id}>{conversation.title}</option>
          ))}
        </select>
      </label>
      {onClose && <button onClick={onClose}>Close pane</button>}
    </section>
  );
}


