import type {
  ContextPin,
  ElementReference,
  InteractionMode,
  ProviderEvent,
  ProviderId,
  ReasoningEffort,
  WorkspaceMode,
} from "../types";
import type { ConversationRunAction } from "./conversation-run";

export type ConversationTurnFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ConversationTurnStartBody {
  root: string;
  worktree: string;
  prompt: string;
  mode: InteractionMode;
  conversationId: string;
  projectId: string;
  threadId?: string;
  resumeSessionId?: string;
  contextPins: readonly ContextPin[];
  profileId: string | null;
  model: string;
  provider: ProviderId;
  workspaceMode: WorkspaceMode;
  reasoningEffort?: ReasoningEffort;
  elementReferences: Array<Omit<ElementReference, "screenshot">>;
}

export interface ConversationTurnAcceptedIds {
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
}

export type ConversationTurnStartResult =
  | ({ status: "completed" } & ConversationTurnAcceptedIds)
  | ({
      status: "failed";
      accepted: boolean;
      message: string;
    } & ConversationTurnAcceptedIds);

export interface ConversationTurnSessionAdapters {
  request?: ConversationTurnFetch;
  now?: () => string;
}

type RunDispatch = (action: ConversationRunAction) => void;

/**
 * Owns conversation turn transport (start/stream/cancel/decide/answer) while
 * ConversationRunModule owns normalized event-state transitions and
 * ConversationComposer retains archive, draft, and workspace UI wiring.
 */
export class ConversationTurnSessionModule {
  private readonly request: ConversationTurnFetch;
  private readonly now: () => string;

  constructor(adapters: ConversationTurnSessionAdapters = {}) {
    this.request = adapters.request ?? fetch;
    this.now = adapters.now ?? (() => new Date().toISOString());
  }

  async start(options: {
    body: ConversationTurnStartBody;
    epoch: number;
    providerName: string;
    dispatch: RunDispatch;
    onAccepted?: (ids: ConversationTurnAcceptedIds) => void | Promise<void>;
  }): Promise<ConversationTurnStartResult> {
    const { body, epoch, providerName, dispatch, onAccepted } = options;
    let accepted = false;
    let runId: string | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    try {
      const response = await this.request("/api/provider/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      threadId = response.headers.get("x-thread-id");
      if (!response.ok) {
        const errorBody = (await response.json()) as { error?: string };
        throw new Error(errorBody.error ?? `${providerName} could not start.`);
      }
      accepted = true;
      runId = response.headers.get("x-provider-run-id");
      turnId = response.headers.get("x-turn-id");
      await onAccepted?.({ runId, threadId, turnId });
      dispatch({ type: "stream_opened", epoch });
      if (!response.body) throw new Error(`${providerName} returned no event stream.`);
      await this.consumeNdjsonStream(response.body, epoch, dispatch);
      return { status: "completed", runId, threadId, turnId };
    } catch (error) {
      const message = error instanceof Error ? error.message : `${providerName} failed.`;
      dispatch({
        type: "transport_failed",
        epoch,
        message,
        occurredAt: this.now(),
      });
      return {
        status: "failed",
        accepted,
        message,
        runId,
        threadId,
        turnId,
      };
    }
  }

  async cancel(runId: string, epoch: number, dispatch: RunDispatch): Promise<void> {
    dispatch({ type: "cancel_requested" });
    try {
      const response = await this.request(`/api/provider/runs/${runId}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("The provider run could not be cancelled.");
    } catch (error) {
      dispatch({
        type: "transport_failed",
        epoch,
        message: error instanceof Error ? error.message : "Cancellation failed.",
        occurredAt: this.now(),
      });
    }
  }

  async decideApproval(
    approval: Extract<ProviderEvent, { kind: "approval_pending" }>,
    decision: "allow_once" | "deny",
    dispatch: RunDispatch,
  ): Promise<void> {
    try {
      const response = await this.request(`/api/provider/approvals/${approval.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: approval.runId,
          conversationId: approval.conversationId,
          repository: approval.repository,
          worktree: approval.worktree,
          toolCallId: approval.toolCallId,
          decision,
        }),
      });
      const body = (await response.json()) as typeof approval | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Approval decision failed.");
      dispatch({
        type: "approval_decided",
        id: approval.id,
        state: (body as typeof approval).state,
      });
    } catch (error) {
      dispatch({
        type: "interaction_failed",
        message: error instanceof Error ? error.message : "Approval decision failed.",
      });
    }
  }

  async answerInput(
    input: Extract<ProviderEvent, { kind: "input_requested" }>,
    answer: string,
    threadId: string,
    dispatch: RunDispatch,
  ): Promise<boolean> {
    const trimmed = answer.trim();
    if (!trimmed) return false;
    try {
      const response = await this.request(`/api/provider/input-requests/${input.id}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childThreadId: threadId, answer: trimmed }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Input response failed.");
      dispatch({ type: "input_answered", id: input.id });
      return true;
    } catch (error) {
      dispatch({
        type: "interaction_failed",
        message: error instanceof Error ? error.message : "Input response failed.",
      });
      return false;
    }
  }

  private async consumeNdjsonStream(
    body: ReadableStream<Uint8Array>,
    epoch: number,
    dispatch: RunDispatch,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const event = JSON.parse(line) as ProviderEvent;
          dispatch({
            type: "provider_event",
            epoch,
            event,
            occurredAt: this.now(),
          });
        }
        newline = buffer.indexOf("\n");
      }
      if (result.done) break;
    }
  }
}
