import type {
  ConversationSummary,
  DelegatedApprovalProjection,
  DelegatedConversationRelationship,
  DelegatedInputProjection,
  ThreadStatus,
} from "../types";
import { delegatedConversationAncestorIds } from "./delegated-conversation-graph";
import { hostFetch } from "./host-fetch";

export interface DelegatedHumanControlSessionSnapshot {
  selectedChildId: string;
  busy: boolean;
  approvalBusyId: string | null;
  inputBusyId: string | null;
  inputAnswers: Record<string, string>;
  resolvedApprovalIds: ReadonlySet<string>;
  error: string | null;
}

export type DelegatedHumanControlSessionCommand =
  | { kind: "link"; childThreadId: string }
  | { kind: "unlink"; childThreadId: string }
  | {
      kind: "decide_approval";
      delegated: DelegatedApprovalProjection;
      decision: "allow_once" | "deny";
    }
  | { kind: "answer_input"; delegated: DelegatedInputProjection };

export interface DelegatedHumanControlSessionAdapters {
  request?: typeof fetch;
  refresh: () => Promise<void>;
}

const initialSnapshot = (): DelegatedHumanControlSessionSnapshot => ({
  selectedChildId: "",
  busy: false,
  approvalBusyId: null,
  inputBusyId: null,
  inputAnswers: {},
  resolvedApprovalIds: new Set(),
  error: null,
});

/**
 * Owns parent-routed delegated human-control transport and coordination state
 * while the host retains relationship, permission, and provider authority and
 * DelegatedChildrenPanel retains projection and dialog wiring.
 */
export class DelegatedHumanControlSessionModule {
  private snapshot: DelegatedHumanControlSessionSnapshot = initialSnapshot();
  private listeners = new Set<() => void>();
  private readonly request: typeof fetch;
  private readonly refresh: () => Promise<void>;

  constructor(
    private readonly parentThreadId: string,
    adapters: DelegatedHumanControlSessionAdapters,
  ) {
    this.request = adapters.request ?? hostFetch;
    this.refresh = adapters.refresh;
  }

  getSnapshot = (): DelegatedHumanControlSessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSelectedChildId(childThreadId: string): void {
    this.update({ selectedChildId: childThreadId });
  }

  setInputAnswer(requestId: string, answer: string): void {
    this.update({
      inputAnswers: { ...this.snapshot.inputAnswers, [requestId]: answer },
    });
  }

  linkCandidates(
    conversations: readonly ConversationSummary[],
    relationships: readonly DelegatedConversationRelationship[],
  ): ConversationSummary[] {
    const unavailableChildIds = new Set(relationships.map((item) => item.childThreadId));
    const ancestorIds = delegatedConversationAncestorIds([...relationships], this.parentThreadId);
    return conversations.filter(
      (item) =>
        item.id !== this.parentThreadId &&
        !item.archivedAt &&
        !unavailableChildIds.has(item.id) &&
        !ancestorIds.has(item.id),
    );
  }

  pendingApprovalsForChild(
    approvals: readonly DelegatedApprovalProjection[],
    childThreadId: string,
  ): DelegatedApprovalProjection[] {
    return approvals.filter(
      (item) =>
        item.parentThreadId === this.parentThreadId &&
        item.childThreadId === childThreadId &&
        !this.snapshot.resolvedApprovalIds.has(item.approval.id),
    );
  }

  inputsForChild(
    inputs: readonly DelegatedInputProjection[],
    childThreadId: string,
  ): DelegatedInputProjection[] {
    return inputs.filter(
      (item) => item.parentThreadId === this.parentThreadId && item.childThreadId === childThreadId,
    );
  }

  childStatus(
    child: ConversationSummary,
    approvals: readonly DelegatedApprovalProjection[],
    inputs: readonly DelegatedInputProjection[],
  ): ThreadStatus {
    const childApprovals = this.pendingApprovalsForChild(approvals, child.id);
    if (childApprovals.length > 0) return "pending_approval";
    const childInputs = this.inputsForChild(inputs, child.id);
    if (childInputs.length > 0) return "awaiting_input";
    return child.status ?? "idle";
  }

  async execute(command: DelegatedHumanControlSessionCommand): Promise<void> {
    if (command.kind === "link" || command.kind === "unlink") {
      await this.mutate(
        command.kind === "link"
          ? "/api/state/delegated-conversations/link"
          : "/api/state/delegated-conversations/unlink",
        command.childThreadId,
      );
      return;
    }
    if (command.kind === "decide_approval") {
      await this.decideApproval(command.delegated, command.decision);
      return;
    }
    await this.answerInput(command.delegated);
  }

  private async mutate(route: string, childThreadId: string): Promise<void> {
    this.update({ busy: true, error: null });
    try {
      const response = await this.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentThreadId: this.parentThreadId, childThreadId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Delegated conversation update failed.");
      this.update({ selectedChildId: "" });
      await this.refresh();
    } catch (cause) {
      this.update({
        error: cause instanceof Error ? cause.message : "Delegated conversation update failed.",
      });
    } finally {
      this.update({ busy: false });
    }
  }

  private async decideApproval(
    delegated: DelegatedApprovalProjection,
    decision: "allow_once" | "deny",
  ): Promise<void> {
    this.update({ approvalBusyId: delegated.approval.id, error: null });
    try {
      const response = await this.request(
        `/api/provider/approvals/${delegated.approval.id}/decide`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            runId: delegated.approval.runId,
            conversationId: delegated.approval.conversationId,
            repository: delegated.approval.repository,
            worktree: delegated.approval.worktree,
            toolCallId: delegated.approval.toolCallId,
            decision,
            parentThreadId: this.parentThreadId,
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Approval decision failed.");
      const resolvedApprovalIds = new Set(this.snapshot.resolvedApprovalIds);
      resolvedApprovalIds.add(delegated.approval.id);
      this.update({ resolvedApprovalIds });
      try {
        await this.refresh();
      } catch {
        this.update({
          error: "Approval resolved. Status refresh failed; reconnect to confirm child state.",
        });
      }
    } catch (cause) {
      this.update({
        error: cause instanceof Error ? cause.message : "Approval decision failed.",
      });
    } finally {
      this.update({ approvalBusyId: null });
    }
  }

  private async answerInput(delegated: DelegatedInputProjection): Promise<void> {
    const answer = (this.snapshot.inputAnswers[delegated.request.id] ?? "").trim();
    if (!answer) return;
    this.update({ inputBusyId: delegated.request.id, error: null });
    try {
      const response = await this.request(
        `/api/provider/input-requests/${delegated.request.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            childThreadId: delegated.childThreadId,
            parentThreadId: this.parentThreadId,
            answer,
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Child input response failed.");
      await this.refresh();
    } catch (cause) {
      this.update({
        error: cause instanceof Error ? cause.message : "Child input response failed.",
      });
    } finally {
      this.update({ inputBusyId: null });
    }
  }

  private update(patch: Partial<DelegatedHumanControlSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
