import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adapterReference,
  ProviderAdapterError,
  type InstalledProviderAdapter,
  type ProviderAdapterStore,
} from "./provider-adapters.ts";
import type { AdapterProfileSeed, ClaudeProfileStore } from "./profiles.ts";
import type { ReviewedAdapterCatalogEntry } from "./reviewed-adapters.ts";

interface ProviderAdapterRouteContext {
  adapters: Pick<
    ProviderAdapterStore,
    "list" | "inspect" | "install" | "update" | "setEnabled" | "rollback" | "uninstall"
  >;
  profiles: Pick<ClaudeProfileStore, "ensureProviderDefault">;
  listReviewedAdapters: () => Promise<ReviewedAdapterCatalogEntry[]>;
  prepareReviewedAdapter: (slug: unknown) => Promise<unknown>;
  remote: boolean;
  managed: boolean;
  readJson: (request: IncomingMessage) => Promise<unknown>;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
}

const FIXED_ROUTES = new Set([
  "/api/provider/adapters/list",
  "/api/provider/adapters/catalog",
  "/api/provider/adapters/catalog/prepare",
  "/api/provider/adapters/inspect",
  "/api/provider/adapters/install",
  "/api/provider/adapters/update",
]);
const ACTION_ROUTE =
  /^\/api\/provider\/adapters\/([a-z0-9.-]+)\/(enable|disable|rollback|uninstall)$/;

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
    throw new ProviderAdapterError(
      "This host cannot administer provider adapters in the active mode.",
      403,
    );
  }
}

function assertApproved(body: { approved?: unknown }): void {
  if (body.approved !== true) {
    throw new ProviderAdapterError("Explicit adapter approval is required.", 403);
  }
}

/**
 * Dispatch provider adapter administration behind one interface. This module
 * owns host-mode admission, response redaction, explicit approval, action
 * routing, and the install-to-default-profile ordering invariant.
 */
export async function handleProviderAdapterRoute(
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  context: ProviderAdapterRouteContext,
): Promise<boolean> {
  const actionRoute = route.match(ACTION_ROUTE);
  if (!FIXED_ROUTES.has(route) && !actionRoute) return false;
  const {
    adapters,
    profiles,
    listReviewedAdapters,
    prepareReviewedAdapter,
    remote,
    managed,
    readJson,
    sendJson,
  } = context;

  if (route === "/api/provider/adapters/list") {
    if (managed) {
      sendJson(response, 200, { adapters: [], administrationAvailable: false });
      return true;
    }
    const installed = await adapters.list();
    sendJson(response, 200, {
      adapters: remote
        ? installed.map((adapter) => ({ ...adapter, source: "Source available on host only" }))
        : installed,
      administrationAvailable: !remote,
    });
    return true;
  }

  if (route === "/api/provider/adapters/catalog") {
    if (managed) {
      sendJson(response, 200, { adapters: [], administrationAvailable: false });
      return true;
    }
    const catalog = await listReviewedAdapters();
    sendJson(response, 200, {
      adapters: remote
        ? catalog.map((entry) => ({
            ...entry,
            source: "Reviewed package available on host only",
            package: null,
            executablePath: entry.executableFound ? "available on host" : null,
          }))
        : catalog,
      administrationAvailable: !remote,
    });
    return true;
  }

  if (route === "/api/provider/adapters/catalog/prepare") {
    assertAdministrationAvailable(remote, managed);
    const body = (await readJson(request)) as { slug?: unknown };
    sendJson(response, 200, await prepareReviewedAdapter(body.slug));
    return true;
  }

  if (route === "/api/provider/adapters/inspect") {
    if (managed) {
      throw new ProviderAdapterError(
        "Provider adapter administration is unavailable in managed hosted mode.",
        403,
      );
    }
    const body = (await readJson(request)) as {
      source?: unknown;
      digest?: unknown;
      manifest?: unknown;
    };
    sendJson(response, 200, adapters.inspect(body));
    return true;
  }

  if (route === "/api/provider/adapters/install" || route === "/api/provider/adapters/update") {
    assertAdministrationAvailable(remote, managed);
    const body = (await readJson(request)) as {
      source?: unknown;
      digest?: unknown;
      manifest?: unknown;
      approved?: unknown;
    };
    assertApproved(body);
    const installed = route.endsWith("/install")
      ? await adapters.install(body)
      : await adapters.update(body);
    await profiles.ensureProviderDefault(adapterProfileSeed(installed));
    sendJson(response, 200, installed);
    return true;
  }

  assertAdministrationAvailable(remote, managed);
  const body = (await readJson(request)) as { approved?: unknown };
  assertApproved(body);
  const [, id, action] = actionRoute!;
  if (action === "uninstall") {
    await adapters.uninstall(id);
    sendJson(response, 200, { uninstalled: true });
  } else if (action === "rollback") {
    sendJson(response, 200, await adapters.rollback(id));
  } else {
    sendJson(response, 200, await adapters.setEnabled(id, action === "enable"));
  }
  return true;
}
