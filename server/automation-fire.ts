/**
 * Host-owned automation fire path: resolve an existing thread and start a full
 * provider turn (checkpoint + events + approvals) without an HTTP NDJSON client.
 *
 * Intentionally mirrors `/api/provider/runs` so scheduled turns land in local
 * history the same way as interactive sends. A later refactor can fold both
 * onto one shared starter; v1 keeps the interactive route untouched.
 */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Automation } from "./automations.ts";
import type { AutomationFireResult } from "./automations-scheduler.ts";
import { AcpProviderAdapter } from "./acp-provider.ts";
import type { CodexCliAdapter } from "./codex-provider.ts";
import type { PermissionBroker } from "./permission.ts";
import type { ProviderAdapterStore } from "./provider-adapters.ts";
import {
  CLAUDE_MODEL_ALIASES,
  type ClaudeProfileStore,
} from "./profiles.ts";
import {
  ClaudeCodeAdapter,
  type InteractionMode,
  type ProviderId,
  ProviderProtocolError,
} from "./provider.ts";
import {
  captureCheckpoint,
  checkpointGitDirectory,
  checkpointReference,
  deleteCheckpointReferences,
  discoverWorktrees,
  canonicalizeRepositoryRoot,
  RepositoryError,
} from "./repository.ts";
import {
  LocalStateError,
  LocalStateStore,
  projectThreadStatus,
  type ThreadStatus,
} from "./state.ts";
import type { WakeBroker } from "./wake.ts";

const BUSY_STATUSES = new Set<ThreadStatus>([
  "running",
  "pending_approval",
  "awaiting_input",
]);

export type AutomationFireDeps = {
  state: LocalStateStore;
  profiles: ClaudeProfileStore;
  provider: ClaudeCodeAdapter;
  codex: CodexCliAdapter;
  adapters: ProviderAdapterStore;
  permissions: PermissionBroker;
  activeAcp: Map<string, AcpProviderAdapter>;
  wake: WakeBroker;
  /** Resolves to the loopback permission broker URL. */
  approvalUrl: () => Promise<string>;
  /** Shared checkpoint worktree lock set from host.ts */
  activeCheckpointWorktrees: Set<string>;
  activeCheckpointProjects: Set<string>;
  checkpointWorktreeKey: (projectId: string, worktree: string) => string;
  publishThreadStatusTransition: (
    wake: WakeBroker,
    state: LocalStateStore,
    threadId: string,
    previous: ThreadStatus | null,
  ) => Promise<void>;
};

async function selectedWorktree(
  rootInput: string,
  worktreeInput: string,
): Promise<{ root: string; worktree: string }> {
  const root = await canonicalizeRepositoryRoot(rootInput);
  const selected = await realpath(worktreeInput);
  const worktrees = await discoverWorktrees(root);
  const allowed = await Promise.all(worktrees.map(async (worktree) => {
    try {
      return await realpath(worktree.path);
    } catch {
      return null;
    }
  }));
  if (!allowed.includes(selected)) {
    throw new RepositoryError("Select a discovered worktree from the opened repository.", 403);
  }
  return { root, worktree: selected };
}

export async function fireAutomationTurn(
  automation: Automation,
  deps: AutomationFireDeps,
): Promise<AutomationFireResult> {
  const projection = await deps.state.load();
  const thread = projection.threads.find((item) => item.id === automation.threadId);
  if (!thread) {
    return { status: "error", message: "The target conversation is no longer available." };
  }
  const project = projection.projects.find((item) => item.id === thread.projectId);
  if (!project) {
    return { status: "error", message: "The target project is no longer available." };
  }

  const threadStatus = projectThreadStatus(projection, thread.id).status;
  if (BUSY_STATUSES.has(threadStatus)) {
    return { status: "skipped_busy", message: "Conversation is busy." };
  }

  const providerId = (thread.provider ?? "claude-code") as ProviderId;
  const isDeclarativeAdapter = typeof providerId === "string" && providerId.startsWith("adapter:");
  const session = projection.providerSessions.find(
    (item) => item.threadId === thread.id && item.provider === providerId,
  );
  const turns = projection.turns
    .filter((turn) => turn.threadId === thread.id)
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const lastTurn = turns.at(-1);
  const mode = (lastTurn?.mode ?? "build") as InteractionMode;

  let model = thread.model ?? session?.model ?? "default";
  if (providerId === "claude-code") {
    if (!model || !CLAUDE_MODEL_ALIASES.includes(model)) {
      model = CLAUDE_MODEL_ALIASES[0] ?? "default";
    }
  } else if (!model) {
    model = "default";
  }

  const profileId = providerId === "claude-code"
    ? (thread.profileId ?? session?.profileId)
    : undefined;
  if (providerId === "claude-code" && typeof profileId !== "string") {
    return {
      status: "error",
      message: "This Claude conversation has no profile to resume. Open it once interactively.",
    };
  }

  let context: { root: string; worktree: string };
  try {
    context = await selectedWorktree(project.root, thread.worktree);
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Worktree is unavailable.",
    };
  }

  const activeWorktreeKey = deps.checkpointWorktreeKey(project.id, context.worktree);
  if (
    deps.activeCheckpointProjects.has(project.id)
    || deps.activeCheckpointWorktrees.has(activeWorktreeKey)
  ) {
    return { status: "skipped_busy", message: "This worktree already has an active checkpoint capture." };
  }

  deps.activeCheckpointWorktrees.add(activeWorktreeKey);
  try {
    let profile = null;
    try {
      profile = providerId === "claude-code"
        ? await deps.profiles.runtime(profileId as string)
        : null;
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Claude profile is unavailable.",
      };
    }

    const installedAdapter = isDeclarativeAdapter
      ? await deps.adapters.version(providerId)
      : null;
    if (isDeclarativeAdapter && !installedAdapter) {
      return {
        status: "error",
        message: "This thread requires an adapter version that is unavailable.",
      };
    }
    if (installedAdapter && !installedAdapter.enabled) {
      return { status: "error", message: "The selected adapter is disabled." };
    }
    if (
      profile
      && session?.continuationKey
      && session.continuationKey !== profile.continuationKey
    ) {
      return {
        status: "error",
        message: "This thread can only continue with a Claude profile using the same Claude home.",
      };
    }

    const prompt = automation.prompt.trim();
    const persisted = await deps.state.startTurn({
      projectId: project.id,
      worktree: context.worktree,
      prompt,
      mode,
      provider: providerId,
      threadId: thread.id,
    });

    const forkPrompt = await deps.state.pendingForkPrompt(persisted.thread.id);
    const effectiveProviderPrompt = forkPrompt
      ? `${forkPrompt}\n\nNew request:\n${prompt}`
      : prompt;

    const checkpointId = randomUUID();
    const checkpointCreatedAt = new Date().toISOString();
    let baselineIdentity: string | null = null;
    let commonGitDirectory: string | null = null;
    try {
      commonGitDirectory = await checkpointGitDirectory(context.worktree);
    } catch {
      // Capture below records a visible unavailable state without creating refs.
    }
    const checkpointIntent = await deps.state.saveCheckpoint({
      id: checkpointId,
      turnId: persisted.turn.id,
      threadId: persisted.thread.id,
      worktree: context.worktree,
      gitDirectory: commonGitDirectory,
      baselineHead: null,
      baselineIdentity: null,
      baselineIndexIdentity: null,
      completedIdentity: null,
      completedIndexIdentity: null,
      completedHead: null,
      state: "unavailable",
      message: "Baseline capture did not complete.",
      createdAt: checkpointCreatedAt,
    });
    try {
      const baseline = await captureCheckpoint(
        context.worktree,
        false,
        checkpointReference(checkpointId, "baseline"),
      );
      baselineIdentity = baseline.identity;
      await deps.state.saveCheckpoint({
        ...checkpointIntent,
        gitDirectory: baseline.gitDirectory,
        baselineHead: baseline.head,
        baselineIdentity,
        baselineIndexIdentity: baseline.indexIdentity,
        state: "baseline",
        message: null,
      });
    } catch (error) {
      await deps.state.saveCheckpoint({
        ...checkpointIntent,
        state: "unavailable",
        message: error instanceof RepositoryError ? error.message : "Baseline capture failed.",
      });
    }

    let approvalUrl: string;
    try {
      approvalUrl = await deps.approvalUrl();
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Permission broker unavailable.",
      };
    }

    let run;
    try {
      run = providerId === "codex-cli"
        ? await deps.codex.start({
          repository: context.root,
          worktree: context.worktree,
          conversationId: persisted.thread.id,
          prompt: effectiveProviderPrompt,
          approvalUrl,
          mode,
          resumeSessionId: session?.sessionId,
          model: model === "default" ? undefined : model,
        })
        : installedAdapter
        ? await (async () => {
            const executable = await deps.adapters.resolveExecutable(installedAdapter);
            const adapter = new AcpProviderAdapter(installedAdapter, executable, deps.permissions);
            const started = await adapter.start({
              repository: context.root,
              worktree: context.worktree,
              conversationId: persisted.thread.id,
              prompt: effectiveProviderPrompt,
              approvalUrl,
              mode,
              resumeSessionId: session?.sessionId,
            });
            deps.activeAcp.set(started.id, adapter);
            return started;
          })()
        : await deps.provider.start(
          context.root,
          context.worktree,
          persisted.thread.id,
          effectiveProviderPrompt,
          approvalUrl,
          mode,
          session?.sessionId,
          {
            executable: profile!.executable,
            environment: profile!.environment,
            model,
          },
        );
    } catch (error) {
      await deps.state.recordProviderEvent(
        persisted.thread.id,
        persisted.turn.id,
        providerId,
        {
          kind: "failed",
          message: error instanceof ProviderProtocolError
            ? error.message
            : "The provider could not be started.",
        },
        profile
          ? { profileId: profile.profile.id, continuationKey: profile.continuationKey }
          : undefined,
      );
      await deps.publishThreadStatusTransition(
        deps.wake,
        deps.state,
        persisted.thread.id,
        null,
      );
      const checkpoint = (await deps.state.load()).checkpoints.find((item) => item.id === checkpointId);
      if (checkpoint && checkpoint.state === "baseline") {
        await deps.state.saveCheckpoint({
          ...checkpoint,
          state: "failed",
          message: "Provider startup failed before checkpoint completion.",
        });
      }
      return {
        status: "error",
        message: error instanceof Error ? error.message : "The provider could not be started.",
        turnId: persisted.turn.id,
      };
    }

    try {
      await deps.state.bindProviderRun(persisted.turn.id, run.id);
      await deps.state.markForkStarted(persisted.thread.id);
    } catch (error) {
      if (providerId === "codex-cli") deps.codex.cancel(run.id);
      else if (isDeclarativeAdapter) {
        deps.activeAcp.get(run.id)?.cancel(run.id);
        deps.activeAcp.delete(run.id);
      } else deps.provider.cancel(run.id);
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Could not bind provider run.",
        turnId: persisted.turn.id,
      };
    }

    let completed = false;
    let historyFailed = false;
    let previousStatus = projectThreadStatus(await deps.state.load(), persisted.thread.id).status;
    await deps.publishThreadStatusTransition(deps.wake, deps.state, persisted.thread.id, null);
    previousStatus = projectThreadStatus(await deps.state.load(), persisted.thread.id).status;

    for await (const event of run.events) {
      try {
        await deps.state.recordProviderEvent(
          persisted.thread.id,
          persisted.turn.id,
          providerId,
          event,
          profile
            ? { profileId: profile.profile.id, continuationKey: profile.continuationKey }
            : undefined,
        );
        await deps.publishThreadStatusTransition(
          deps.wake,
          deps.state,
          persisted.thread.id,
          previousStatus,
        );
        previousStatus = projectThreadStatus(await deps.state.load(), persisted.thread.id).status;
      } catch {
        if (providerId === "codex-cli") deps.codex.cancel(run.id);
        else if (isDeclarativeAdapter) deps.activeAcp.get(run.id)?.cancel(run.id);
        else deps.provider.cancel(run.id);
        historyFailed = true;
        break;
      }
      if (event.kind === "turn_completed") completed = true;
    }

    const checkpoint = (await deps.state.load()).checkpoints.find((item) => item.id === checkpointId);
    if (checkpoint?.state === "baseline" && baselineIdentity) {
      if (historyFailed) {
        await deps.state.saveCheckpoint({
          ...checkpoint,
          state: "failed",
          message: "Local history failed and the provider turn was stopped.",
        });
      } else if (completed) {
        try {
          const captured = await captureCheckpoint(
            context.worktree,
            true,
            checkpointReference(checkpointId, "completed"),
          );
          if (captured.head !== checkpoint.baselineHead) {
            await deleteCheckpointReferences(captured.gitDirectory, checkpointId);
            await deps.state.saveCheckpoint({
              ...checkpoint,
              state: "unavailable",
              message: "HEAD changed during the turn; rewind does not rewrite Git history.",
            });
          } else {
            const saved = await deps.state.saveCheckpoint({
              ...checkpoint,
              completedIdentity: captured.identity,
              completedIndexIdentity: captured.indexIdentity,
              completedHead: captured.head,
              state: "completed",
              message: null,
            });
            await deps.state.supersedeCompletedCheckpoints(
              persisted.thread.id,
              context.worktree,
              saved.id,
            );
          }
        } catch (error) {
          await deps.state.saveCheckpoint({
            ...checkpoint,
            state: "unavailable",
            message: error instanceof RepositoryError
              ? error.message
              : "Completed checkpoint capture failed.",
          });
        }
      } else {
        await deps.state.saveCheckpoint({
          ...checkpoint,
          state: "failed",
          message: "The turn did not complete; its baseline remains inspectable.",
        });
      }
    }

    deps.activeAcp.delete(run.id);

    if (historyFailed) {
      return {
        status: "error",
        message: "Local history could not be updated. The provider run was stopped.",
        turnId: persisted.turn.id,
      };
    }
    return { status: "ok", turnId: persisted.turn.id };
  } catch (error) {
    if (error instanceof LocalStateError || error instanceof RepositoryError) {
      if (error.status === 409) {
        return { status: "skipped_busy", message: error.message };
      }
      return { status: "error", message: error.message };
    }
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Automation fire failed.",
    };
  } finally {
    deps.activeCheckpointWorktrees.delete(activeWorktreeKey);
  }
}
