import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ClaudeCodeAdapter,
  type InteractionMode,
  type ProviderId,
  ProviderProtocolError,
  type ReasoningEffort,
} from "./provider.ts";
import { CodexCliAdapter } from "./codex-provider.ts";
import { AcpProviderAdapter } from "./acp-provider.ts";
import { ShikigamiAdapter, type ShikigamiProfileRuntime } from "./shikigami-provider.ts";
import { beginProviderEventStream } from "./provider-stream.ts";
import { validateProviderModel } from "./provider-models.ts";
import { ProviderAdapterError, ProviderAdapterStore } from "./provider-adapters.ts";
import { PermissionBroker } from "./permission.ts";
import {
  captureCheckpoint,
  checkpointGitDirectory,
  checkpointReference,
  checkpointDiff,
  deleteCheckpointReferences,
  RepositoryError,
} from "./repository.ts";
import {
  LocalStateError,
  LocalStateStore,
  projectThreadStatus,
  type ThreadStatus,
} from "./state.ts";
import { ClaudeProfileStore, ProfileError } from "./profiles.ts";
import { assembleContextPackage, composePrompt, type ContextPin } from "./context.ts";
import { PreferencesStore } from "./preferences.ts";
import { AutonomyEngine } from "./autonomy-engine.ts";
import { WorktreeManager } from "./worktrees.ts";
import { ManagedHost } from "./managed-host.ts";
import { SharedBrowserBroker } from "./browser.ts";
import { WakeBroker } from "./wake.ts";
import type { WorkspaceMode } from "../src/types.ts";

type SelectedWorktree = { root: string; worktree: string };
type DelegatedControlLock = <T>(operation: () => Promise<T>) => Promise<T>;
type ProviderInputExpiryTimer = { unref(): void };

export const MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS = 32;

export class ProviderInputExpiryTimers {
  readonly #runs = new Map<string, Map<string, ProviderInputExpiryTimer>>();

  constructor(
    private readonly timers: {
      setTimeout(callback: () => void, delayMs: number): ProviderInputExpiryTimer;
      clearTimeout(handle: ProviderInputExpiryTimer): void;
    } = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  ) {}

  schedule(runId: string, requestId: string, expiresAt: string, expire: () => void): void {
    this.clear(runId, requestId);
    if (this.retainedTimerCount >= MAX_ACTIVE_PROVIDER_INPUT_EXPIRY_TIMERS) {
      throw new ProviderProtocolError("Too many provider input requests are awaiting expiry.");
    }
    const run = this.#runs.get(runId) ?? new Map<string, ProviderInputExpiryTimer>();
    const timer = this.timers.setTimeout(
      () => {
        if (this.#forget(runId, requestId, timer)) expire();
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    timer.unref();
    run.set(requestId, timer);
    this.#runs.set(runId, run);
  }

  clear(runId: string, requestId: string): boolean {
    const run = this.#runs.get(runId);
    const timer = run?.get(requestId);
    if (!run || !timer) return false;
    this.timers.clearTimeout(timer);
    this.#forget(runId, requestId, timer);
    return true;
  }

  clearRun(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#runs.delete(runId);
    for (const timer of run.values()) this.timers.clearTimeout(timer);
  }

  get retainedTimerCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) count += run.size;
    return count;
  }

  #forget(runId: string, requestId: string, timer: ProviderInputExpiryTimer): boolean {
    const run = this.#runs.get(runId);
    if (run?.get(requestId) !== timer) return false;
    run.delete(requestId);
    if (!run.size) this.#runs.delete(runId);
    return true;
  }
}

export interface ProviderRunInput {
  body: unknown;
  localPort?: number;
}

export interface ProviderRunAcceptance {
  runId: string;
  threadId: string;
  turnId: string;
}

export interface ProviderRunExecution {
  accepted: Promise<ProviderRunAcceptance>;
  completed: Promise<boolean>;
}

export type ProviderRunOutput = Pick<
  ServerResponse,
  "destroyed" | "writableEnded" | "setHeader" | "writeHead" | "flushHeaders" | "write" | "end"
>;

export function createProviderRunSink(): ProviderRunOutput {
  let ended = false;
  return {
    get destroyed() {
      return false;
    },
    get writableEnded() {
      return ended;
    },
    setHeader: () => undefined,
    writeHead: () => undefined as never,
    flushHeaders: () => undefined,
    write: () => true,
    end: () => {
      ended = true;
      return undefined as never;
    },
  };
}

/**
 * Starts one provider run through the same typed admission interface used by
 * HTTP, automations, and delegated follow-ups. Transport adapters choose how
 * to present the event stream; admission and completion remain authoritative
 * in this module.
 */
export function admitProviderRun(
  input: ProviderRunInput,
  output: ProviderRunOutput,
  module: ProviderRunModuleContext,
): ProviderRunExecution {
  let resolveAccepted!: (acceptance: ProviderRunAcceptance) => void;
  let rejectAccepted!: (error: unknown) => void;
  let acceptedSettled = false;
  const accepted = new Promise<ProviderRunAcceptance>((resolve, reject) => {
    resolveAccepted = resolve;
    rejectAccepted = reject;
  });
  const admissionOutput: ProviderRunOutput = {
    get destroyed() {
      return output.destroyed;
    },
    get writableEnded() {
      return output.writableEnded;
    },
    setHeader: output.setHeader.bind(output),
    writeHead(statusCode, headers) {
      const result = output.writeHead(statusCode, headers);
      if (!acceptedSettled && statusCode >= 200 && statusCode < 300) {
        const values = headers as Record<string, number | string | readonly string[] | undefined>;
        const runId = values["x-provider-run-id"];
        const threadId = values["x-thread-id"];
        const turnId = values["x-turn-id"];
        if (
          typeof runId === "string" &&
          typeof threadId === "string" &&
          typeof turnId === "string"
        ) {
          acceptedSettled = true;
          resolveAccepted({ runId, threadId, turnId });
        }
      }
      return result;
    },
    flushHeaders: output.flushHeaders.bind(output),
    write: output.write.bind(output),
    end: output.end.bind(output),
  };
  const completed = handleProviderRun(input, admissionOutput, module).catch((error) => {
    if (!acceptedSettled) {
      acceptedSettled = true;
      rejectAccepted(error);
    }
    throw error;
  });
  return { accepted, completed };
}

export interface ProviderRunModuleContext {
  provider: ClaudeCodeAdapter;
  codex: CodexCliAdapter;
  shikigami: ShikigamiAdapter;
  permissions: PermissionBroker;
  state: LocalStateStore;
  profiles: ClaudeProfileStore;
  preferences: PreferencesStore;
  autonomy: AutonomyEngine;
  worktrees: WorktreeManager;
  adapters: ProviderAdapterStore;
  activeAcp: Map<string, AcpProviderAdapter>;
  inputExpiryTimers: ProviderInputExpiryTimers;
  wake: WakeBroker;
  withDelegatedControlLock: DelegatedControlLock;
  internalApprovalUrl?: Promise<string>;
  managedHost?: ManagedHost;
  browser?: SharedBrowserBroker | null;
  browserMcpPath?: string;
  remoteRequest: boolean;
  internalRequest: boolean;
  selectedWorktree: (root: string, worktree: string) => Promise<SelectedWorktree>;
  publishThreadStatusTransition: (
    wake: WakeBroker,
    state: LocalStateStore,
    threadId: string,
    previousStatus?: ThreadStatus | null,
    force?: boolean,
  ) => Promise<void>;
  activeCheckpointProjects: Set<string>;
  activeCheckpointWorktrees: Set<string>;
  checkpointWorktreeKey: (projectId: string, worktree: string) => string;
}

export function shouldReleaseBrowserProviderToken(
  providerId: ProviderId,
  codexOwnsToken: boolean,
): boolean {
  return providerId !== "codex-cli" || !codexOwnsToken;
}

export async function handleProviderRun(
  input: ProviderRunInput,
  output: ProviderRunOutput,
  module: ProviderRunModuleContext,
): Promise<boolean> {
  const {
    provider,
    codex,
    shikigami,
    permissions,
    state,
    profiles,
    preferences,
    autonomy,
    worktrees,
    adapters,
    activeAcp,
    inputExpiryTimers,
    wake,
    withDelegatedControlLock,
    internalApprovalUrl,
    managedHost,
    browser,
    browserMcpPath,
    remoteRequest,
    internalRequest,
    selectedWorktree,
    publishThreadStatusTransition,
    activeCheckpointProjects,
    activeCheckpointWorktrees,
    checkpointWorktreeKey,
  } = module;
  const body = input.body as {
    root?: unknown;
    worktree?: unknown;
    prompt?: unknown;
    conversationId?: unknown;
    resumeSessionId?: unknown;
    resumeAnswer?: unknown;
    projectId?: unknown;
    threadId?: unknown;
    parentThreadId?: unknown;
    mode?: unknown;
    attachments?: unknown;
    contextPins?: unknown;
    profileId?: unknown;
    model?: unknown;
    elementReferences?: unknown;
    provider?: unknown;
    reasoningEffort?: unknown;
    inputRequestId?: unknown;
    automationFireId?: unknown;
    workspaceMode?: unknown;
  };
  if (managedHost) {
    const forbiddenManagedOverrides = [
      "adapter",
      "adapterId",
      "baseUrl",
      "credential",
      "endpoint",
      "executable",
      "governanceAdapter",
      "modelAdapter",
      "modelId",
      "providerId",
      "providerProfile",
      "rootPath",
      "tokenEnv",
      "worktreePath",
    ];
    if (forbiddenManagedOverrides.some((key) => Object.hasOwn(body, key))) {
      throw new RepositoryError(
        "Managed runs cannot override provider, model, executable, endpoint, credential, or path configuration.",
        403,
      );
    }
    if (body.provider !== undefined && body.provider !== "shikigami") {
      throw new RepositoryError("Managed hosted mode runs only Shikigami.", 403);
    }
    if (body.mode !== undefined && body.mode !== "build") {
      throw new RepositoryError("Managed hosted mode runs only Build mode.", 403);
    }
    if (body.model !== undefined && body.model !== managedHost.shikigami.model) {
      throw new RepositoryError("The managed model is selected by the host configuration.", 403);
    }
    if (body.profileId !== undefined && body.profileId !== null) {
      throw new RepositoryError("Managed hosted mode does not accept provider profiles.", 403);
    }
    if (body.reasoningEffort !== undefined) {
      throw new RepositoryError("Managed hosted mode does not accept model tuning overrides.", 403);
    }
    body.provider = "shikigami";
    body.mode = "build";
    body.model = managedHost.shikigami.model;
    body.profileId = null;
  }
  const providerId = (body.provider ?? "claude-code") as ProviderId;
  const isDeclarativeAdapter = typeof providerId === "string" && providerId.startsWith("adapter:");
  const nativeResumePayload =
    internalRequest &&
    providerId === "shikigami" &&
    typeof body.inputRequestId === "string" &&
    typeof body.resumeSessionId === "string" &&
    typeof body.resumeAnswer === "string";
  const reasoningEfforts = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh"]);
  if (
    typeof body.root !== "string" ||
    typeof body.worktree !== "string" ||
    typeof body.prompt !== "string" ||
    (!body.prompt.trim() && !nativeResumePayload) ||
    typeof body.conversationId !== "string" ||
    !body.conversationId ||
    (body.resumeSessionId !== undefined && typeof body.resumeSessionId !== "string") ||
    (body.resumeAnswer !== undefined && typeof body.resumeAnswer !== "string") ||
    (body.projectId !== undefined && typeof body.projectId !== "string") ||
    (body.threadId !== undefined && typeof body.threadId !== "string") ||
    (body.parentThreadId !== undefined &&
      (typeof body.parentThreadId !== "string" || !body.parentThreadId)) ||
    (body.inputRequestId !== undefined && typeof body.inputRequestId !== "string") ||
    (body.automationFireId !== undefined &&
      (!internalRequest ||
        typeof body.automationFireId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(body.automationFireId))) ||
    !["ask", "plan", "build"].includes(body.mode as string) ||
    (body.attachments !== undefined &&
      (!Array.isArray(body.attachments) ||
        body.attachments.length > 100 ||
        body.attachments.some((path) => typeof path !== "string"))) ||
    (body.contextPins !== undefined &&
      (!Array.isArray(body.contextPins) ||
        body.contextPins.length > 100 ||
        body.contextPins.some(
          (pin) =>
            typeof pin !== "object" ||
            pin === null ||
            typeof (pin as { path?: unknown }).path !== "string" ||
            !["file", "folder"].includes(String((pin as { kind?: unknown }).kind)),
        ))) ||
    (providerId !== "claude-code" &&
      providerId !== "codex-cli" &&
      providerId !== "shikigami" &&
      !isDeclarativeAdapter) ||
    (providerId === "claude-code" && typeof body.profileId !== "string") ||
    (providerId === "shikigami" &&
      body.profileId !== undefined &&
      body.profileId !== null &&
      typeof body.profileId !== "string") ||
    typeof body.model !== "string" ||
    (body.reasoningEffort !== undefined &&
      !reasoningEfforts.has(body.reasoningEffort as ReasoningEffort)) ||
    (body.workspaceMode !== undefined &&
      !["shared", "aldunis-managed", "provider-native"].includes(body.workspaceMode as string)) ||
    (body.elementReferences !== undefined &&
      (!Array.isArray(body.elementReferences) ||
        body.elementReferences.length > 3 ||
        body.elementReferences.some(
          (value) =>
            typeof value !== "object" ||
            value === null ||
            typeof (value as { selector?: unknown }).selector !== "string" ||
            typeof (value as { tag?: unknown }).tag !== "string",
        )))
  ) {
    throw new RepositoryError(
      "A repository, worktree, prompt, interaction mode, provider, and model are required.",
    );
  }
  const mode = body.mode as InteractionMode;
  const context = await selectedWorktree(body.root, body.worktree);
  const delegatedParentThreadId =
    typeof body.parentThreadId === "string" ? body.parentThreadId : null;
  const contextPins =
    body.contextPins !== undefined
      ? (body.contextPins as ContextPin[])
      : ((body.attachments ?? []) as string[]).map((path) => ({
          path,
          kind: "file" as const,
        }));
  if (remoteRequest && contextPins.some((pin) => pin.kind === "folder")) {
    throw new RepositoryError(
      "Remote folder pinning requires an authenticated repository grant and is unavailable.",
      403,
    );
  }
  const assembledContext = await assembleContextPackage(context.worktree, contextPins, {
    includeProviderInstructions: !remoteRequest && !managedHost,
  });
  const providerPrompt = composePrompt(
    nativeResumePayload ? "" : body.prompt.trim(),
    assembledContext.attachments,
    (body.elementReferences ?? []) as Array<{
      selector: string;
      tag: string;
      role?: string | null;
      name?: string | null;
      text?: string | null;
    }>,
  );
  const projection = await state.inspect();
  const project =
    typeof body.projectId === "string"
      ? projection.projects.find((item) => item.id === body.projectId && item.root === context.root)
      : projection.projects.find((item) => item.root === context.root);
  if (!project)
    throw new LocalStateError("Open the repository before starting a conversation.", 404);
  const existingThread =
    typeof body.threadId === "string"
      ? projection.threads.find((thread) => thread.id === body.threadId)
      : undefined;
  if (body.threadId !== undefined && !existingThread) {
    throw new LocalStateError("The selected conversation is not available.", 404);
  }
  if (existingThread && existingThread.projectId !== project.id) {
    throw new LocalStateError("The selected conversation is not available.", 404);
  }
  const workspaceMode = (body.workspaceMode ??
    existingThread?.workspaceMode ??
    "shared") as WorkspaceMode;
  if (managedHost && workspaceMode !== "shared") {
    throw new LocalStateError(
      "Managed hosted mode supplies the workspace and only supports the shared workspace mode.",
      409,
    );
  }
  if (workspaceMode === "provider-native") {
    throw new LocalStateError(
      "Provider-native worktrees are not supported by the selected Aldunis adapter yet. Use an Aldunis worktree or a shared checkout.",
      409,
    );
  }
  if (workspaceMode === "aldunis-managed") {
    const selected = (await worktrees.list(context.root)).find(
      (candidate) => candidate.path === context.worktree,
    );
    if (!selected || selected.ownership !== "aldunis" || selected.recovery !== "available") {
      throw new LocalStateError(
        "An Aldunis-managed conversation must use an available Aldunis-owned worktree.",
        409,
      );
    }
    if (
      !body.threadId &&
      projection.threads.some((thread) => thread.worktree === context.worktree)
    ) {
      throw new LocalStateError(
        "Each Aldunis-managed conversation needs its own worktree. Create a new one before starting this chat.",
        409,
      );
    }
  }
  if (existingThread) {
    const providerSession = projection.providerSessions.find(
      (session) => session.threadId === existingThread.id,
    );
    const existingProvider = existingThread.provider ?? providerSession?.provider ?? "claude-code";
    if (existingProvider !== providerId) {
      throw new LocalStateError(
        `This conversation belongs to ${existingProvider} and cannot switch providers.`,
        409,
      );
    }
    if (existingThread.worktree !== context.worktree) {
      throw new LocalStateError(
        "This conversation is bound to a different canonical worktree and cannot be silently moved.",
        409,
      );
    }
  }
  if (delegatedParentThreadId) {
    if (body.threadId !== undefined) {
      throw new LocalStateError("A delegated child must start as a new conversation.", 400);
    }
    const { preferences: currentPreferences } = await preferences.load();
    if (!currentPreferences.orchestrationThreadsBeta) {
      throw new LocalStateError("Orchestration threads beta is disabled.", 403);
    }
    const parent = projection.threads.find((item) => item.id === delegatedParentThreadId);
    if (!parent || parent.projectId !== project.id) {
      throw new LocalStateError("The parent conversation is unavailable for delegation.", 404);
    }
    if (providerId !== parent.provider) {
      throw new LocalStateError(
        "A delegated child must use the parent conversation's provider.",
        409,
      );
    }
    if (mode === "build") {
      if (parent.worktree === context.worktree) {
        throw new LocalStateError(
          "A Build child requires an isolated worktree. Start it from a managed child worktree or use Ask/Plan for the parent worktree.",
          409,
        );
      }
      const selectedChildWorktree = (await worktrees.list(context.root)).find(
        (worktree) => worktree.path === context.worktree,
      );
      if (
        !selectedChildWorktree ||
        selectedChildWorktree.ownership !== "aldunis" ||
        selectedChildWorktree.recovery !== "available"
      ) {
        throw new LocalStateError(
          "A Build child requires an available Aldunis-managed worktree. Create one through the worktree approval flow.",
          409,
        );
      }
      if (projection.threads.some((thread) => thread.worktree === context.worktree)) {
        throw new LocalStateError(
          "The selected Build child worktree is already bound to another conversation.",
          409,
        );
      }
    }
  }
  const shikigamiProfile =
    providerId === "shikigami" && typeof body.profileId === "string"
      ? await profiles.runtime(body.profileId)
      : null;
  if (shikigamiProfile && shikigamiProfile.profile.provider !== "shikigami") {
    throw new ProfileError("The selected profile does not belong to the requested provider.", 400);
  }
  const effectiveModel = managedHost
    ? managedHost.shikigami.model
    : await validateProviderModel(
        providerId,
        body.model,
        {
          codex,
          shikigami,
          shikigamiProfile: shikigamiProfile
            ? {
                executable: shikigamiProfile.executable,
                environment: shikigamiProfile.environment,
                configPath: shikigamiProfile.configPath,
              }
            : undefined,
          adapters,
        },
        context.worktree,
      );
  const previousSession =
    typeof body.threadId === "string"
      ? projection.providerSessions.find(
          (session) => session.threadId === body.threadId && session.provider === providerId,
        )
      : undefined;
  const resumedInput =
    typeof body.inputRequestId === "string"
      ? projection.inputRequests.find(
          (item) =>
            item.id === body.inputRequestId &&
            item.threadId === body.threadId &&
            item.state === "answered" &&
            item.responseMode === "child_follow_up",
        )
      : undefined;
  const nativeResumeInput = nativeResumePayload
    ? projection.inputRequests.find(
        (item) =>
          item.id === body.inputRequestId &&
          item.threadId === body.threadId &&
          item.state === "answered" &&
          item.responseMode === "native_resume" &&
          item.resumeState === "starting" &&
          item.providerRequestId === body.resumeSessionId,
      )
    : undefined;
  if (nativeResumePayload && (!nativeResumeInput || !body.resumeAnswer?.trim())) {
    throw new LocalStateError("The native Shikigami resume request is no longer available.", 409);
  }
  if (
    body.inputRequestId !== undefined &&
    (!internalRequest || (!resumedInput && !nativeResumeInput))
  ) {
    throw new LocalStateError("The provider input request is no longer available.", 409);
  }
  const nativeResumeSourceTurn = nativeResumeInput
    ? projection.turns.find((item) => item.id === nativeResumeInput.turnId)
    : undefined;
  const nativeResumeThread = nativeResumeInput
    ? projection.threads.find((item) => item.id === nativeResumeInput.threadId)
    : undefined;
  if (
    nativeResumeInput &&
    (!nativeResumeSourceTurn ||
      !nativeResumeThread ||
      nativeResumeThread.provider !== "shikigami" ||
      nativeResumeThread.worktree !== context.worktree ||
      nativeResumeSourceTurn.mode !== mode ||
      nativeResumeSourceTurn.providerRunId !== nativeResumeInput.providerRunId ||
      (nativeResumeThread.model && nativeResumeThread.model !== effectiveModel) ||
      (previousSession?.profileId ?? null) !== (body.profileId ?? null) ||
      (nativeResumeThread.workspaceMode ?? "shared") !== workspaceMode ||
      body.conversationId !== nativeResumeThread.id ||
      body.threadId !== nativeResumeThread.id ||
      body.projectId !== project.id ||
      body.parentThreadId !== undefined)
  ) {
    throw new LocalStateError(
      "The native Shikigami resume binding does not match the parked turn.",
      409,
    );
  }
  const resumedCheckpoint =
    (nativeResumeInput ?? resumedInput)
      ? projection.checkpoints.find(
          (item) =>
            item.turnId === (nativeResumeInput ?? resumedInput)!.turnId &&
            item.threadId === body.threadId &&
            item.worktree === context.worktree &&
            item.state === "baseline",
        )
      : undefined;
  if ((resumedInput || nativeResumeInput) && !resumedCheckpoint) {
    throw new LocalStateError("The parked provider turn has no usable baseline checkpoint.", 409);
  }
  const pendingFork =
    typeof body.threadId === "string"
      ? projection.forks.find(
          (fork) => fork.destinationThreadId === body.threadId && fork.status === "pending",
        )
      : undefined;
  if (
    pendingFork &&
    (pendingFork.provider !== providerId ||
      pendingFork.model !== effectiveModel ||
      pendingFork.profileId !==
        (providerId === "claude-code" || providerId === "shikigami"
          ? ((body.profileId ?? null) as string | null)
          : null) ||
      pendingFork.worktree !== context.worktree)
  ) {
    throw new LocalStateError(
      "The destination provider, profile, model, or worktree changed after the fork was reviewed.",
      409,
    );
  }
  const profile =
    providerId === "claude-code"
      ? await profiles.runtime(body.profileId as string)
      : shikigamiProfile;
  if (profile && profile.profile.provider !== providerId) {
    throw new ProfileError("The selected profile does not belong to the requested provider.", 400);
  }
  const installedAdapter = isDeclarativeAdapter ? await adapters.version(providerId) : null;
  if (isDeclarativeAdapter && !installedAdapter) {
    throw new ProviderAdapterError(
      "This thread requires an adapter version that is unavailable. Reinstall that exact version or start a new conversation.",
      409,
    );
  }
  if (installedAdapter && !installedAdapter.enabled) {
    throw new ProviderAdapterError("The selected adapter is disabled.", 409);
  }
  if (
    profile &&
    previousSession?.continuationKey &&
    previousSession.continuationKey !== profile.continuationKey
  ) {
    throw new ProfileError("This thread can only continue with the same provider profile.", 409);
  }
  if (providerId === "shikigami" && body.resumeSessionId !== undefined && !nativeResumeInput) {
    throw new LocalStateError(
      "Shikigami resume is only available through a bound parked-run input request.",
      409,
    );
  }
  if (
    body.resumeSessionId !== undefined &&
    !nativeResumeInput &&
    (!previousSession || body.resumeSessionId !== previousSession.sessionId)
  ) {
    throw new LocalStateError(
      "The provider session does not belong to the selected conversation.",
      409,
    );
  }
  const activeWorktreeKey = checkpointWorktreeKey(project.id, context.worktree);
  if (
    activeCheckpointProjects.has(project.id) ||
    activeCheckpointWorktrees.has(activeWorktreeKey)
  ) {
    throw new LocalStateError("This worktree already has an active checkpoint capture.", 409);
  }
  activeCheckpointWorktrees.add(activeWorktreeKey);
  let browserProviderConversationId: string | null = null;
  let codexOwnsBrowserProviderToken = false;
  try {
    const nativeResumeClaim = nativeResumeInput
      ? await state.claimNativeShikigamiResume(
          nativeResumeInput.id,
          nativeResumeInput.threadId,
          body.resumeSessionId as string,
        )
      : null;
    const persisted = nativeResumeClaim
      ? { thread: nativeResumeClaim.thread, turn: nativeResumeClaim.turn }
      : await state.startTurn({
          projectId: project.id,
          worktree: context.worktree,
          prompt: body.prompt.trim(),
          mode,
          provider: providerId,
          model: effectiveModel,
          reasoningEffort: body.reasoningEffort as ReasoningEffort | undefined,
          threadId: body.threadId,
          contextPins: assembledContext.pins,
          workspaceMode,
        });
    if (!nativeResumeClaim && typeof body.automationFireId === "string") {
      await state.bindAutomationFireTurn(body.automationFireId, persisted.turn.id);
    }
    if (!nativeResumeClaim) {
      await state.saveContextReceipt({
        threadId: persisted.thread.id,
        turnId: persisted.turn.id,
        pins: assembledContext.pins,
        entries: assembledContext.entries,
        totalBytes: assembledContext.totalBytes,
        estimatedTokens: assembledContext.estimatedTokens,
        digest: assembledContext.digest,
      });
    }
    if (!nativeResumeClaim && delegatedParentThreadId) {
      await withDelegatedControlLock(() =>
        state.linkDelegatedConversation(delegatedParentThreadId, persisted.thread.id),
      );
    }
    const forkPrompt = nativeResumeClaim
      ? null
      : await state.pendingForkPrompt(persisted.thread.id);
    const effectiveProviderPrompt = nativeResumeClaim
      ? ""
      : forkPrompt
        ? `${forkPrompt}\n\nNew request:\n${providerPrompt}`
        : providerPrompt;
    const checkpointId = resumedCheckpoint?.id ?? randomUUID();
    const checkpointCreatedAt = new Date().toISOString();
    let baselineIdentity: string | null = resumedCheckpoint?.baselineIdentity ?? null;
    let commonGitDirectory: string | null = resumedCheckpoint?.gitDirectory ?? null;
    try {
      commonGitDirectory = await checkpointGitDirectory(context.worktree);
    } catch {
      // Capture below records a visible unavailable state without creating refs.
    }
    const checkpointIntent =
      resumedCheckpoint ??
      (await state.saveCheckpoint({
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
      }));
    if (!resumedCheckpoint)
      try {
        const baseline = await captureCheckpoint(
          context.worktree,
          false,
          checkpointReference(checkpointId, "baseline"),
        );
        baselineIdentity = baseline.identity;
        await state.saveCheckpoint({
          ...checkpointIntent,
          gitDirectory: baseline.gitDirectory,
          baselineHead: baseline.head,
          baselineIdentity,
          baselineIndexIdentity: baseline.indexIdentity,
          state: "baseline",
          message: null,
        });
      } catch (error) {
        await state.saveCheckpoint({
          ...checkpointIntent,
          state: "unavailable",
          message: error instanceof RepositoryError ? error.message : "Baseline capture failed.",
        });
      }
    const port = input.localPort;
    const approvalUrl =
      internalApprovalUrl ??
      (port
        ? Promise.resolve(`http://127.0.0.1:${port}/api/provider/permissions/request`)
        : Promise.reject(new RepositoryError("The local permission broker is unavailable.", 503)));
    const browserAutomationAllowed =
      providerId === "codex-cli" ||
      installedAdapter?.manifest.capabilities.browserAutomation === true;
    const browserMcp =
      browserAutomationAllowed && browser && browserMcpPath && port
        ? browser.providerMcpConfiguration({
            conversationId: persisted.thread.id,
            endpoint: `http://127.0.0.1:${port}/api/browser/tools`,
            command: process.execPath,
            script: browserMcpPath,
          })
        : undefined;
    if (browserMcp) browserProviderConversationId = persisted.thread.id;
    const effectiveProviderPromptWithBrowser = browserMcp
      ? `${effectiveProviderPrompt}\n\nAldunis shared browser tools are available for the local loopback preview. Use browser_snapshot before acting. Browser control is disabled until the operator explicitly enables it; if a browser action is refused, explain that and continue without repeatedly retrying.`
      : effectiveProviderPrompt;
    let run;
    try {
      run =
        providerId === "codex-cli"
          ? await codex.start({
              repository: context.root,
              worktree: context.worktree,
              conversationId: persisted.thread.id,
              prompt: effectiveProviderPromptWithBrowser,
              approvalUrl: await approvalUrl,
              mode,
              resumeSessionId: body.resumeSessionId,
              model: effectiveModel,
              reasoningEffort: body.reasoningEffort as ReasoningEffort | undefined,
              browserMcp,
            })
          : providerId === "shikigami"
            ? await (nativeResumeClaim
                ? shikigami.resumeParked(
                    {
                      repository: context.root,
                      worktree: context.worktree,
                      conversationId: persisted.thread.id,
                      prompt: "",
                      approvalUrl: await approvalUrl,
                      mode,
                      resumeSessionId: body.resumeSessionId as string,
                      model: effectiveModel,
                    },
                    body.resumeAnswer as string,
                    process.env,
                    managedHost
                      ? {
                          ...managedHost.shikigami,
                          stateRoot: join(state.directory, "managed-shikigami"),
                        }
                      : undefined,
                    profile
                      ? ({
                          executable: profile.executable,
                          environment: profile.environment,
                          configPath: profile.configPath,
                        } satisfies ShikigamiProfileRuntime)
                      : undefined,
                  )
                : shikigami.start(
                    {
                      repository: context.root,
                      worktree: context.worktree,
                      conversationId: persisted.thread.id,
                      prompt: effectiveProviderPrompt,
                      approvalUrl: await approvalUrl,
                      mode,
                      resumeSessionId: undefined,
                      model: effectiveModel,
                    },
                    process.env,
                    managedHost
                      ? {
                          ...managedHost.shikigami,
                          stateRoot: join(state.directory, "managed-shikigami"),
                        }
                      : undefined,
                    profile
                      ? ({
                          executable: profile.executable,
                          environment: profile.environment,
                          configPath: profile.configPath,
                        } satisfies ShikigamiProfileRuntime)
                      : undefined,
                  ))
            : installedAdapter
              ? await (async () => {
                  const executable = await adapters.resolveExecutable(installedAdapter);
                  const adapter = new AcpProviderAdapter(installedAdapter, executable, permissions);
                  const started = await adapter.start({
                    repository: context.root,
                    worktree: context.worktree,
                    conversationId: persisted.thread.id,
                    prompt: effectiveProviderPromptWithBrowser,
                    approvalUrl: await approvalUrl,
                    mode,
                    resumeSessionId: body.resumeSessionId,
                    model: effectiveModel,
                    reasoningEffort: body.reasoningEffort as ReasoningEffort | undefined,
                    browserMcp,
                  });
                  activeAcp.set(started.id, adapter);
                  return started;
                })()
              : await provider.start(
                  context.root,
                  context.worktree,
                  persisted.thread.id,
                  effectiveProviderPrompt,
                  await approvalUrl,
                  mode,
                  body.resumeSessionId,
                  {
                    executable: profile!.executable,
                    environment: profile!.environment,
                    model: effectiveModel,
                  },
                );
      if (providerId === "codex-cli" && browserMcp) codexOwnsBrowserProviderToken = true;
    } catch (error) {
      if (nativeResumeClaim) {
        await state.markNativeShikigamiResumeUnavailable(nativeResumeClaim.request.id);
      }
      await state.recordProviderEvent(
        persisted.thread.id,
        persisted.turn.id,
        providerId,
        {
          kind: "failed",
          message:
            error instanceof ProviderProtocolError
              ? error.message
              : "The provider could not be started.",
        },
        profile
          ? { profileId: profile.profile.id, continuationKey: profile.continuationKey }
          : undefined,
      );
      await publishThreadStatusTransition(wake, state, persisted.thread.id, null);
      const checkpoint = (await state.inspect()).checkpoints.find(
        (item) => item.id === checkpointId,
      );
      if (!resumedCheckpoint && checkpoint && checkpoint.state === "baseline") {
        await state.saveCheckpoint({
          ...checkpoint,
          state: "failed",
          message: "Provider startup failed before checkpoint completion.",
        });
      }
      output.setHeader("x-thread-id", persisted.thread.id);
      output.setHeader("x-turn-id", persisted.turn.id);
      throw error;
    }
    output.setHeader("x-thread-id", persisted.thread.id);
    output.setHeader("x-turn-id", persisted.turn.id);
    try {
      if (resumedCheckpoint) {
        await state.saveCheckpoint({ ...resumedCheckpoint, turnId: persisted.turn.id });
      }
      await state.bindProviderRun(persisted.turn.id, run.id);
      if (nativeResumeClaim) {
        await state.markNativeShikigamiResumeStarted(nativeResumeClaim.request.id);
      }
      await state.markForkStarted(persisted.thread.id);
    } catch (error) {
      if (nativeResumeClaim) {
        await state.markNativeShikigamiResumeUnavailable(nativeResumeClaim.request.id);
      }
      if (providerId === "codex-cli") codex.cancel(run.id);
      else if (providerId === "shikigami") shikigami.cancel(run.id);
      else if (isDeclarativeAdapter) {
        activeAcp.get(run.id)?.cancel(run.id);
        activeAcp.delete(run.id);
      } else provider.cancel(run.id);
      throw error;
    }
    beginProviderEventStream(output, {
      runId: run.id,
      threadId: persisted.thread.id,
      turnId: persisted.turn.id,
    });
    let completed = false;
    let historyFailed = false;
    let previousStatus = projectThreadStatus(await state.inspect(), persisted.thread.id).status;
    // Starting a turn moves the thread to running before the first event.
    await publishThreadStatusTransition(wake, state, persisted.thread.id, null);
    previousStatus = projectThreadStatus(await state.inspect(), persisted.thread.id).status;
    for await (const event of run.events) {
      let outgoingEvent = event;
      try {
        await state.recordProviderEvent(
          persisted.thread.id,
          persisted.turn.id,
          providerId,
          event,
          profile
            ? { profileId: profile.profile.id, continuationKey: profile.continuationKey }
            : undefined,
        );
        if (nativeResumeClaim && (event.kind === "failed" || event.kind === "cancelled")) {
          await state.markNativeShikigamiResumeUnavailable(nativeResumeClaim.request.id);
        }
        if (event.kind === "approval_resolved") {
          const sibling = permissions
            .approvalsFor(run.id)
            .find((approval) => approval.state === "pending");
          if (sibling) {
            await state.recordProviderEvent(persisted.thread.id, persisted.turn.id, providerId, {
              kind: "approval_pending",
              ...sibling,
            });
          }
        }
        if (event.kind === "input_requested" && event.expiresAt) {
          inputExpiryTimers.schedule(run.id, event.id, event.expiresAt, () => {
            if (!codex.expireInput(run.id, event.id)) return;
            void state
              .recordProviderEvent(persisted.thread.id, persisted.turn.id, providerId, {
                kind: "input_resolved",
                id: event.id,
                state: "cancelled",
              })
              .then(async () => {
                if (!output.destroyed && !output.writableEnded) {
                  output.write(
                    `${JSON.stringify({
                      kind: "input_resolved",
                      id: event.id,
                      state: "cancelled",
                    })}\n`,
                  );
                }
                await publishThreadStatusTransition(wake, state, persisted.thread.id, null, true);
              })
              .catch(() => undefined);
          });
        }
        await publishThreadStatusTransition(
          wake,
          state,
          persisted.thread.id,
          previousStatus,
          event.kind === "approval_pending" ||
            event.kind === "approval_resolved" ||
            event.kind === "input_requested" ||
            event.kind === "input_resolved",
        );
        previousStatus = projectThreadStatus(await state.inspect(), persisted.thread.id).status;
        if (event.kind === "governance_correlation") {
          const correlation = (await state.inspect()).governanceCorrelations.find(
            (item) => item.turnId === persisted.turn.id,
          );
          if (correlation) outgoingEvent = { ...event, correlationId: correlation.id };
        }
      } catch {
        if (nativeResumeClaim) {
          await state.markNativeShikigamiResumeUnavailable(nativeResumeClaim.request.id);
        }
        if (providerId === "codex-cli") codex.cancel(run.id);
        else if (providerId === "shikigami") shikigami.cancel(run.id);
        else if (isDeclarativeAdapter) activeAcp.get(run.id)?.cancel(run.id);
        else provider.cancel(run.id);
        output.write(
          `${JSON.stringify({
            kind: "failed",
            message: "Local history could not be updated. The provider run was stopped.",
          })}\n`,
        );
        historyFailed = true;
        break;
      }
      if (event.kind === "turn_completed") completed = true;
      output.write(`${JSON.stringify(outgoingEvent)}\n`);
    }
    const checkpoint = (await state.inspect()).checkpoints.find((item) => item.id === checkpointId);
    if (checkpoint?.state === "baseline" && baselineIdentity) {
      if (historyFailed) {
        await state.saveCheckpoint({
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
            await state.saveCheckpoint({
              ...checkpoint,
              state: "unavailable",
              message: "HEAD changed during the turn; rewind does not rewrite Git history.",
            });
          } else {
            let files: Awaited<ReturnType<typeof checkpointDiff>> = [];
            try {
              files = await checkpointDiff(context.worktree, baselineIdentity, captured.identity);
            } catch {
              // The tree identities remain authoritative even if the
              // optional inline summary cannot be computed.
            }
            const saved = await state.saveCheckpoint({
              ...checkpoint,
              completedIdentity: captured.identity,
              completedIndexIdentity: captured.indexIdentity,
              completedHead: captured.head,
              state: "completed",
              message: null,
              files,
            });
            await state.supersedeCompletedCheckpoints(
              persisted.thread.id,
              context.worktree,
              saved.id,
            );
          }
        } catch (error) {
          await state.saveCheckpoint({
            ...checkpoint,
            state: "unavailable",
            message:
              error instanceof RepositoryError
                ? error.message
                : "Completed checkpoint capture failed.",
          });
        }
      } else if (
        (await state.inspect()).inputRequests.some(
          (item) =>
            item.turnId === persisted.turn.id &&
            item.state === "pending" &&
            (item.responseMode === "child_follow_up" || item.responseMode === "native_resume"),
        )
      ) {
        // Preserve the original baseline while a parked run awaits an
        // explicit answer; that answer rebinds and finalizes this checkpoint.
      } else {
        await state.saveCheckpoint({
          ...checkpoint,
          state: "failed",
          message: "The turn did not complete; its baseline remains inspectable.",
        });
      }
    }
    void autonomy
      .dispatch(completed ? "turn_completed" : "turn_failed", persisted.thread.projectId)
      .catch(() => undefined);
    output.end();
    activeAcp.delete(run.id);
    return true;
  } finally {
    if (run?.id) inputExpiryTimers.clearRun(run.id);
    if (
      browserProviderConversationId &&
      shouldReleaseBrowserProviderToken(providerId, codexOwnsBrowserProviderToken)
    ) {
      browser?.releaseProviderToken(browserProviderConversationId);
    }
    activeCheckpointWorktrees.delete(activeWorktreeKey);
  }
}
