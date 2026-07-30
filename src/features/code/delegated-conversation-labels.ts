import type { ConversationSummary } from "../../types";
import { providerListLabel } from "../../lib/provider-readiness";

type DelegatedConversationOption = Pick<
  ConversationSummary,
  "id" | "title" | "projectName" | "provider"
>;

function delegatedConversationBaseLabel(
  conversation: DelegatedConversationOption,
): string {
  return [
    conversation.title.trim() || conversation.id,
    conversation.projectName ?? "Unknown project",
    conversation.provider ? providerListLabel(conversation.provider) : null,
  ].filter(Boolean).join(" · ");
}

export function delegatedConversationLabels(
  conversations: DelegatedConversationOption[],
): Map<string, string> {
  const groups = new Map<string, DelegatedConversationOption[]>();
  for (const conversation of conversations) {
    const label = delegatedConversationBaseLabel(conversation);
    groups.set(label, [...(groups.get(label) ?? []), conversation]);
  }

  const labels = new Map<string, string>();
  for (const [label, group] of groups) {
    for (const conversation of group) {
      labels.set(
        conversation.id,
        group.length > 1 ? `${label} · Task ${conversation.id.slice(0, 8)}` : label,
      );
    }
  }
  return labels;
}
