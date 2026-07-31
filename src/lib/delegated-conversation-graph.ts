export interface DelegatedConversationEdge {
  parentThreadId: string;
  childThreadId: string;
}

export function delegatedConversationAncestorIds(
  relationships: DelegatedConversationEdge[],
  threadId: string,
): Set<string> {
  const parentsByChild = new Map<string, string[]>();
  for (const relationship of relationships) {
    const parents = parentsByChild.get(relationship.childThreadId) ?? [];
    parents.push(relationship.parentThreadId);
    parentsByChild.set(relationship.childThreadId, parents);
  }
  const ancestors = new Set<string>();
  const pending = [...(parentsByChild.get(threadId) ?? [])];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    if (ancestors.has(parent)) continue;
    ancestors.add(parent);
    pending.push(...(parentsByChild.get(parent) ?? []));
  }
  return ancestors;
}

export function wouldCreateDelegatedConversationCycle(
  relationships: DelegatedConversationEdge[],
  parentThreadId: string,
  childThreadId: string,
): boolean {
  return parentThreadId === childThreadId
    || delegatedConversationAncestorIds(relationships, parentThreadId).has(childThreadId);
}
