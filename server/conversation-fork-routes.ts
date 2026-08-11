import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkspaceMode } from "../src/types.ts";
import type { CodexCliAdapter } from "./codex-provider.ts";
import type { ProviderAdapterStore } from "./provider-adapters.ts";
import { isAdapterProviderId, validateProviderModel } from "./provider-models.ts";
import { ProfileError, type ClaudeProfileStore } from "./profiles.ts";
import { ProviderProtocolError, type ProviderId } from "./provider.ts";
import type { ShikigamiAdapter } from "./shikigami-provider.ts";
import { LocalStateError, type LocalStateStore } from "./state.ts";
import type { WorktreeManager } from "./worktrees.ts";

interface SelectedWorktree {
  root: string;
  worktree: string;
}

export interface ConversationForkRouteContext {
  state: Pick<LocalStateStore, "inspect" | "previewFork" | "createFork">;
  worktrees: Pick<WorktreeManager, "list">;
  profiles: Pick<ClaudeProfileStore, "runtime">;
  codex: Pick<CodexCliAdapter, "readiness" | "models">;
  shikigami: Pick<ShikigamiAdapter, "readiness" | "models">;
  adapters: Pick<ProviderAdapterStore, "get">;
  managed: boolean;
  selectWorktree: (root: string, worktree: string) => Promise<SelectedWorktree>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const ROUTES = new Set(["/api/forks/preview", "/api/forks/create"]);
const WORKSPACE_MODES: WorkspaceMode[] = ["shared", "aldunis-managed", "provider-native"];

/**
 * Dispatches LocalConversation fork routes behind one interface. The module
 * owns fork validation, workspace invariants, provider readiness, model
 * validation, digest confirmation, and persistence ordering.
 */
export async function handleConversationForkRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ConversationForkRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const { state, worktrees, profiles, codex, shikigami, adapters, managed, selectWorktree } =
    context;

  if (managed) {
    throw new LocalStateError("Conversation forks are unavailable in managed hosted mode.", 403);
  }

  if (route === "/api/forks/preview") {
    const body = (await context.readJson(request)) as { sourceThreadId?: unknown };
    if (typeof body.sourceThreadId !== "string") {
      throw new LocalStateError("A source conversation is required.", 400);
    }
    const preview = await state.previewFork(body.sourceThreadId);
    if (preview.byteCount > 64 * 1024) {
      throw new LocalStateError("The source context exceeds the 64 KiB fork limit.", 413);
    }
    context.sendJson(response, 200, preview);
    return true;
  }

  const body = (await context.readJson(request)) as {
    sourceThreadId?: unknown;
    provider?: unknown;
    profileId?: unknown;
    model?: unknown;
    expectedDigest?: unknown;
    worktree?: unknown;
    workspaceMode?: unknown;
  };
  const providerValue = typeof body.provider === "string" ? body.provider : null;
  const supportedProvider =
    providerValue === "claude-code" ||
    providerValue === "codex-cli" ||
    providerValue === "shikigami" ||
    (providerValue !== null && isAdapterProviderId(providerValue));
  if (
    typeof body.sourceThreadId !== "string" ||
    !supportedProvider ||
    typeof body.model !== "string" ||
    !body.model ||
    typeof body.expectedDigest !== "string" ||
    (body.worktree !== undefined && typeof body.worktree !== "string") ||
    (body.workspaceMode !== undefined &&
      !WORKSPACE_MODES.includes(body.workspaceMode as WorkspaceMode)) ||
    (providerValue === "claude-code" && typeof body.profileId !== "string") ||
    (providerValue === "codex-cli" && body.profileId !== null) ||
    (providerValue !== "claude-code" &&
      providerValue !== "shikigami" &&
      providerValue !== "codex-cli" &&
      body.profileId !== null) ||
    (providerValue === "shikigami" &&
      body.profileId !== undefined &&
      body.profileId !== null &&
      typeof body.profileId !== "string")
  ) {
    throw new LocalStateError(
      "A source conversation, destination provider, profile, model, and reviewed context size are required.",
      400,
    );
  }

  const projection = await state.inspect();
  const source = projection.threads.find((thread) => thread.id === body.sourceThreadId);
  const project = source
    ? projection.projects.find((candidate) => candidate.id === source.projectId)
    : undefined;
  if (!source || !project) {
    throw new LocalStateError("The source conversation is unavailable.", 404);
  }
  await selectWorktree(project.root, source.worktree);
  const sourceWorkspaceMode = source.workspaceMode ?? "shared";
  const requestedWorkspaceMode = body.workspaceMode as WorkspaceMode | undefined;
  const destinationWorkspaceMode =
    requestedWorkspaceMode ??
    (sourceWorkspaceMode === "aldunis-managed" ? "aldunis-managed" : "shared");
  let destinationWorktree = source.worktree;

  if (sourceWorkspaceMode === "aldunis-managed") {
    if (destinationWorkspaceMode !== "aldunis-managed" || typeof body.worktree !== "string") {
      throw new LocalStateError(
        "A fork from an Aldunis-managed conversation requires a separately approved Aldunis worktree.",
        409,
      );
    }
    destinationWorktree = (await selectWorktree(project.root, body.worktree)).worktree;
    if (destinationWorktree === source.worktree) {
      throw new LocalStateError(
        "A fork from an Aldunis-managed conversation cannot reuse its source worktree.",
        409,
      );
    }
    const selected = (await worktrees.list(project.root)).find(
      (candidate) => candidate.path === destinationWorktree,
    );
    if (!selected || selected.ownership !== "aldunis" || selected.recovery !== "available") {
      throw new LocalStateError(
        "The fork destination must be an available Aldunis-owned worktree.",
        409,
      );
    }
    if (projection.threads.some((thread) => thread.worktree === destinationWorktree)) {
      throw new LocalStateError(
        "The fork destination worktree is already bound to another conversation.",
        409,
      );
    }
  } else if (destinationWorkspaceMode !== "shared") {
    throw new LocalStateError(
      "Only the shared workspace mode is available for forks from this conversation.",
      409,
    );
  }

  const provider = providerValue as ProviderId;
  const shikigamiProfile =
    provider === "shikigami" && typeof body.profileId === "string"
      ? await profiles.runtime(body.profileId)
      : null;
  if (shikigamiProfile && shikigamiProfile.profile.provider !== "shikigami") {
    throw new ProfileError("The selected profile does not belong to Shikigami.", 400);
  }
  const effectiveModel = await validateProviderModel(
    provider,
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
    destinationWorktree,
  );
  if (provider === "claude-code") {
    await profiles.runtime(body.profileId as string);
  } else if (provider === "shikigami") {
    const readiness = await shikigami.readiness(shikigamiProfile?.environment ?? process.env, {
      executable: shikigamiProfile?.executable,
      configPath: shikigamiProfile?.configPath,
      cwd: destinationWorktree,
    });
    if (!readiness.installed || !readiness.authenticated) {
      throw new ProviderProtocolError("Shikigami is unavailable or not authenticated.");
    }
  } else if (provider === "codex-cli") {
    const readiness = await codex.readiness();
    if (!readiness.installed || !readiness.authenticated) {
      throw new ProviderProtocolError("Codex CLI is unavailable or not authenticated.");
    }
  }

  const created = await state.createFork({
    sourceThreadId: source.id,
    provider,
    profileId: typeof body.profileId === "string" ? body.profileId : null,
    model: effectiveModel,
    worktree: source.worktree,
    destinationWorktree,
    workspaceMode: destinationWorkspaceMode,
    expectedDigest: body.expectedDigest,
  });
  context.sendJson(response, 201, created);
  return true;
}
