import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderDiscovery } from "./provider-discovery.ts";
import {
  adapterReference,
  type InstalledProviderAdapter,
  type ProviderAdapterStore,
} from "./provider-adapters.ts";
import {
  ProfileError,
  type AdapterProfileSeed,
  type ClaudeProfileStore,
  type ProfileProbeKind,
} from "./profiles.ts";
import { RepositoryError } from "./repository.ts";

interface ProviderProfileRouteContext {
  profiles: Pick<ClaudeProfileStore, "list" | "save" | "delete" | "refresh">;
  adapters: Pick<ProviderAdapterStore, "list">;
  providerDiscovery: Pick<ProviderDiscovery, "discover">;
  remote: boolean;
  managed: boolean;
  defaultDiscoveryCwd: string;
  selectWorktree: (root: string, worktree: string) => Promise<{ worktree: string }>;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  readOptionalJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const ROUTES = new Set([
  "/api/providers/discover",
  "/api/provider/profiles/list",
  "/api/provider/profiles/save",
  "/api/provider/profiles/delete",
  "/api/provider/profiles/refresh",
]);
const PROBE_KINDS: readonly ProfileProbeKind[] = [
  "availability",
  "version",
  "authentication",
  "models",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterProfileSeed(adapter: InstalledProviderAdapter): AdapterProfileSeed {
  return {
    provider: adapterReference(adapter.manifest),
    name: adapter.manifest.presentation.name,
    binaryPath: adapter.manifest.executable.names[0] ?? "",
    environment: adapter.manifest.environment
      .filter((entry) => entry.required || entry.sensitive)
      .map((entry) => ({ name: entry.name, sensitive: entry.sensitive, value: "" })),
  };
}

function assertAdministrationAvailable(remote: boolean, managed: boolean): void {
  if (remote || managed) {
    throw new ProfileError(
      "Provider profile administration is unavailable in the active host mode.",
      403,
    );
  }
}

/**
 * Dispatch provider discovery and ProviderProfile administration behind one
 * interface. The module owns host-mode admission, request normalization,
 * adapter seeding, canonical discovery worktree selection, and response mapping.
 */
export async function handleProviderProfileRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ProviderProfileRouteContext,
): Promise<boolean> {
  if (!ROUTES.has(route)) return false;
  const {
    profiles,
    adapters,
    providerDiscovery,
    remote,
    managed,
    defaultDiscoveryCwd,
    selectWorktree,
    readJson,
    readOptionalJson,
    sendJson,
  } = context;

  if (route === "/api/providers/discover") {
    const body = await readOptionalJson(request);
    if (!isRecord(body)) {
      throw new RepositoryError("Provider discovery context must be an object.");
    }
    const hasRoot = body.root !== undefined;
    const hasWorktree = body.worktree !== undefined;
    if (
      hasRoot !== hasWorktree ||
      (hasRoot && (typeof body.root !== "string" || typeof body.worktree !== "string"))
    ) {
      throw new RepositoryError("Provider discovery requires both a repository root and worktree.");
    }
    const cwd = hasRoot
      ? (await selectWorktree(body.root as string, body.worktree as string)).worktree
      : defaultDiscoveryCwd;
    sendJson(response, 200, await providerDiscovery.discover({ cwd }));
    return true;
  }

  if (route === "/api/provider/profiles/list") {
    if (managed) {
      sendJson(response, 200, { profiles: [], administrationAvailable: false });
      return true;
    }
    const installedAdapters = await adapters.list();
    sendJson(response, 200, {
      profiles: await profiles.list({ adapters: installedAdapters.map(adapterProfileSeed) }),
    });
    return true;
  }

  assertAdministrationAvailable(remote, managed);
  if (route === "/api/provider/profiles/save") {
    const body = (await readJson(request)) as Record<string, unknown>;
    const environment = Array.isArray(body.environment)
      ? body.environment.map((value) => {
          if (
            !isRecord(value) ||
            typeof value.name !== "string" ||
            typeof value.sensitive !== "boolean" ||
            (value.value !== undefined && typeof value.value !== "string") ||
            (value.valueSet !== undefined && typeof value.valueSet !== "boolean")
          ) {
            throw new ProfileError("Profile environment variables must be valid.");
          }
          return {
            name: value.name,
            sensitive: value.sensitive,
            ...(typeof value.value === "string" ? { value: value.value } : {}),
            ...(typeof value.valueSet === "boolean" ? { valueSet: value.valueSet } : {}),
          };
        })
      : undefined;
    if (
      (body.id !== undefined && typeof body.id !== "string") ||
      typeof body.name !== "string" ||
      (body.provider !== undefined && typeof body.provider !== "string") ||
      (body.binaryPath !== undefined && typeof body.binaryPath !== "string") ||
      (body.homePath !== undefined && typeof body.homePath !== "string") ||
      (body.configPath !== undefined && typeof body.configPath !== "string") ||
      (body.environment !== undefined && !Array.isArray(body.environment))
    ) {
      throw new ProfileError("A valid provider profile is required.");
    }
    sendJson(
      response,
      200,
      await profiles.save({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
        name: body.name,
        ...(typeof body.binaryPath === "string" ? { binaryPath: body.binaryPath } : {}),
        ...(typeof body.homePath === "string" ? { homePath: body.homePath } : {}),
        ...(typeof body.configPath === "string" ? { configPath: body.configPath } : {}),
        ...(environment ? { environment } : {}),
      }),
    );
    return true;
  }

  const body = (await readJson(request)) as { id?: unknown; kind?: unknown };
  if (route === "/api/provider/profiles/delete") {
    if (typeof body.id !== "string") throw new ProfileError("A provider profile is required.");
    await profiles.delete(body.id);
    sendJson(response, 200, { status: "deleted" });
    return true;
  }
  if (
    typeof body.id !== "string" ||
    typeof body.kind !== "string" ||
    !PROBE_KINDS.includes(body.kind as ProfileProbeKind)
  ) {
    throw new ProfileError("A profile and refresh kind are required.");
  }
  sendJson(response, 200, await profiles.refresh(body.id, body.kind as ProfileProbeKind));
  return true;
}
