import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexCliAdapter } from "./codex-provider.ts";
import { assertParentRoutedApproval } from "./delegated-approvals.ts";
import { assertParentRoutedInput } from "./delegated-inputs.ts";
import { PermissionError, type PermissionBroker } from "./permission.ts";
import type { PreferencesStore } from "./preferences.ts";
import {
  LocalStateError,
  projectThreadStatus,
  type LocalStateStore,
  type StateProjection,
  type ThreadStatus,
} from "./state.ts";

type DelegatedControlLock = <T>(action: () => Promise<T>) => Promise<T>;

interface DelegatedControlRouteContext {
  state: LocalStateStore;
  preferences: PreferencesStore;
  permissions: PermissionBroker;
  codex: Pick<CodexCliAdapter, "answerInput">;
  managed: boolean;
  assertManagedThread: (projection: StateProjection, threadId: string) => unknown;
  withLock: DelegatedControlLock;
  runChildFollowUp: (body: Record<string, unknown>) => Promise<void>;
  publishThreadStatusTransition: (
    threadId: string,
    previous: ThreadStatus | null,
    force?: boolean,
  ) => Promise<void>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const APPROVAL_DECISION_ROUTE = /^\/api\/provider\/approvals\/([0-9a-f-]+)\/decide$/;
const INPUT_RESPONSE_ROUTE = /^\/api\/provider\/input-requests\/([0-9a-f-]+)\/respond$/;

async function retryChildFollowUp(
  action: () => Promise<void>,
  onFailure: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      if (!(error instanceof LocalStateError) || error.status !== 409 || attempt >= 24) {
        await onFailure();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Dispatch delegated human-control decisions through one internal interface.
 * This module owns parent/child authority validation, single-use coordination,
 * provider response routing, recovery, and child status publication.
 */
export async function handleDelegatedControlRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: DelegatedControlRouteContext,
): Promise<boolean> {
  const approvalMatch = route.match(APPROVAL_DECISION_ROUTE);
  if (approvalMatch) {
    const body = (await context.readJson(request)) as {
      runId?: unknown;
      conversationId?: unknown;
      repository?: unknown;
      worktree?: unknown;
      toolCallId?: unknown;
      decision?: unknown;
      parentThreadId?: unknown;
    };
    if (
      typeof body.runId !== "string" ||
      typeof body.conversationId !== "string" ||
      typeof body.repository !== "string" ||
      typeof body.worktree !== "string" ||
      typeof body.toolCallId !== "string" ||
      (body.parentThreadId !== undefined && typeof body.parentThreadId !== "string") ||
      (body.decision !== "allow_once" && body.decision !== "deny")
    ) {
      throw new PermissionError("A complete scoped approval decision is required.");
    }
    const resolveApproval = async () => {
      if (typeof body.parentThreadId === "string") {
        const { preferences } = await context.preferences.load();
        if (!preferences.orchestrationThreadsBeta) {
          throw new PermissionError("Parent-routed approvals require beta orchestration.", 403);
        }
        assertParentRoutedApproval(await context.state.inspect(), context.permissions.approvals(), {
          parentThreadId: body.parentThreadId,
          childThreadId: body.conversationId as string,
          approvalId: approvalMatch[1],
        });
      }
      const previousStatus = projectThreadStatus(
        await context.state.inspect(),
        body.conversationId as string,
      ).status;
      const decided = await context.permissions.decideAfter(
        approvalMatch[1],
        {
          runId: body.runId as string,
          conversationId: body.conversationId as string,
          repository: body.repository as string,
          worktree: body.worktree as string,
          toolCallId: body.toolCallId as string,
        },
        body.decision,
        async (resolution) => {
          const projection = await context.state.inspect();
          const turn = projection.turns.find((item) => item.providerRunId === body.runId);
          const thread = turn
            ? projection.threads.find((item) => item.id === turn.threadId)
            : undefined;
          if (!turn || !thread) {
            throw new LocalStateError("The provider turn is missing from local history.", 404);
          }
          await context.state.recordProviderEvent(
            thread.id,
            turn.id,
            thread.provider ?? "claude-code",
            { kind: "approval_resolved", id: resolution.id, state: resolution.state },
          );
          const sibling = context.permissions
            .approvalsFor(body.runId as string)
            .find((approval) => approval.state === "pending");
          if (sibling) {
            await context.state.recordProviderEvent(
              thread.id,
              turn.id,
              thread.provider ?? "claude-code",
              { kind: "approval_pending", ...sibling },
            );
          }
        },
      );
      await context.publishThreadStatusTransition(
        body.conversationId as string,
        previousStatus,
        true,
      );
      return decided;
    };
    const decided =
      typeof body.parentThreadId === "string"
        ? await context.withLock(resolveApproval)
        : await resolveApproval();
    context.sendJson(response, 200, decided);
    return true;
  }

  const inputMatch = route.match(INPUT_RESPONSE_ROUTE);
  if (!inputMatch) return false;
  const body = (await context.readJson(request)) as {
    childThreadId?: unknown;
    parentThreadId?: unknown;
    answer?: unknown;
  };
  if (
    typeof body.childThreadId !== "string" ||
    typeof body.answer !== "string" ||
    (body.parentThreadId !== undefined && typeof body.parentThreadId !== "string")
  ) {
    throw new LocalStateError("A complete child-bound input response is required.", 400);
  }

  const respond = async () => {
    let selectedRequest;
    if (typeof body.parentThreadId === "string") {
      const { preferences } = await context.preferences.load();
      if (!preferences.orchestrationThreadsBeta) {
        throw new LocalStateError("Parent-routed input requires beta orchestration.", 403);
      }
      const inputProjection = await context.state.inspect();
      if (context.managed) {
        context.assertManagedThread(inputProjection, body.parentThreadId);
        context.assertManagedThread(inputProjection, body.childThreadId as string);
      }
      selectedRequest = assertParentRoutedInput(
        inputProjection,
        body.parentThreadId,
        body.childThreadId as string,
        inputMatch[1],
      );
      if (selectedRequest.state !== "pending") {
        throw new LocalStateError("The input request has already been resolved.", 409);
      }
    } else {
      const inputProjection = await context.state.inspect();
      if (context.managed) context.assertManagedThread(inputProjection, body.childThreadId);
      selectedRequest = inputProjection.inputRequests.find(
        (item) =>
          item.id === inputMatch[1] &&
          item.threadId === body.childThreadId &&
          item.state === "pending",
      );
      if (!selectedRequest) {
        throw new LocalStateError("The input request is not pending for this child.", 403);
      }
    }
    await context.state.validateInputResponse(selectedRequest.id, body.answer as string);

    if (selectedRequest.responseMode === "child_follow_up") {
      const projection = await context.state.inspect();
      const child = projection.threads.find((item) => item.id === body.childThreadId);
      const childSession = projection.providerSessions.find(
        (item) => item.threadId === body.childThreadId && item.provider === child?.provider,
      );
      const sourceTurn = projection.turns.find((item) => item.id === selectedRequest.turnId);
      const project = child
        ? projection.projects.find((item) => item.id === child.projectId)
        : undefined;
      if (!child || !project || !sourceTurn) {
        throw new LocalStateError("The child follow-up route is unavailable.", 503);
      }
      const result = await context.state.resolveInputRequest(
        inputMatch[1],
        body.answer as string,
        typeof body.parentThreadId === "string" ? body.parentThreadId : null,
      );
      await retryChildFollowUp(
        () =>
          context.runChildFollowUp({
            root: project.root,
            worktree: child.worktree,
            prompt: [
              `Operator response to child input request ${selectedRequest.id}:`,
              selectedRequest.question,
              "",
              (body.answer as string).trim(),
            ].join("\n"),
            mode: sourceTurn.mode ?? "ask",
            conversationId: child.id,
            projectId: child.projectId,
            threadId: child.id,
            contextPins: child.contextPins ?? [],
            profileId: child.profileId ?? null,
            model: child.model ?? childSession?.model ?? "default",
            provider: child.provider,
            reasoningEffort: child.reasoningEffort,
            inputRequestId: selectedRequest.id,
          }),
        () => context.state.failInputResolution(selectedRequest.id),
      );
      await context.publishThreadStatusTransition(body.childThreadId as string, null, true);
      return result;
    }

    if (selectedRequest.responseMode === "native_resume") {
      const projection = await context.state.inspect();
      const child = projection.threads.find((item) => item.id === body.childThreadId);
      const childSession = projection.providerSessions.find(
        (item) => item.threadId === body.childThreadId && item.provider === child?.provider,
      );
      const sourceTurn = projection.turns.find((item) => item.id === selectedRequest.turnId);
      const project = child
        ? projection.projects.find((item) => item.id === child.projectId)
        : undefined;
      if (
        !child ||
        child.provider !== "shikigami" ||
        !project ||
        !sourceTurn ||
        !selectedRequest.providerRequestId
      ) {
        throw new LocalStateError("The native Shikigami resume route is unavailable.", 409);
      }
      const result = await context.state.resolveInputRequest(
        inputMatch[1],
        body.answer as string,
        typeof body.parentThreadId === "string" ? body.parentThreadId : null,
      );
      await retryChildFollowUp(
        () =>
          context.runChildFollowUp({
            root: project.root,
            worktree: child.worktree,
            prompt: "",
            mode: sourceTurn.mode ?? "ask",
            conversationId: child.id,
            projectId: child.projectId,
            threadId: child.id,
            resumeSessionId: selectedRequest.providerRequestId,
            resumeAnswer: (body.answer as string).trim(),
            profileId: childSession?.profileId ?? child.profileId ?? null,
            model: child.model ?? childSession?.model ?? "default",
            provider: "shikigami",
            reasoningEffort: child.reasoningEffort,
            inputRequestId: selectedRequest.id,
            workspaceMode: child.workspaceMode,
          }),
        () => context.state.markNativeShikigamiResumeUnavailable(selectedRequest.id),
      );
      await context.publishThreadStatusTransition(body.childThreadId as string, null, true);
      return result;
    }

    const result = await context.state.resolveInputRequest(
      inputMatch[1],
      body.answer as string,
      typeof body.parentThreadId === "string" ? body.parentThreadId : null,
    );
    if (
      !context.codex.answerInput(
        selectedRequest.providerRunId,
        selectedRequest.id,
        (body.answer as string).trim(),
      )
    ) {
      await context.state.failInputResolution(selectedRequest.id);
      throw new LocalStateError("The native input request is no longer resumable.", 409);
    }
    await context.publishThreadStatusTransition(body.childThreadId as string, null, true);
    return result;
  };
  const result = await context.withLock(respond);
  context.sendJson(response, 200, result);
  return true;
}
