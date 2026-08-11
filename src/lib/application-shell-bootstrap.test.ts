import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationShellBootstrapModule,
  type ApplicationShellBootstrapProjection,
} from "./application-shell-bootstrap";
import type { HostCapabilities, RepositoryMetadata } from "../types";
import type { SavedProject } from "../features/dialogs/repository-dialog";

const localCapabilities: HostCapabilities = {
  mode: "local",
  managed: false,
  tenantScoped: false,
  capabilities: {
    providerSelection: true,
    profileAdministration: true,
    adapterAdministration: true,
    modelSelection: true,
    modeSelection: true,
    arbitraryRepositorySelection: true,
    directoryBrowsing: true,
  },
};

function project(id: string, root: string, managedRepositoryId?: string): SavedProject {
  return { id, name: id, root, openedAt: "2026-08-11T00:00:00.000Z", managedRepositoryId };
}

function repository(root: string): RepositoryMetadata {
  return {
    projectId: root,
    name: root,
    root,
    defaultBranch: "main",
    selectedWorktree: root,
    worktrees: [],
  };
}

function projection(events: string[]): ApplicationShellBootstrapProjection {
  return {
    capabilities: (value) => events.push(`capabilities:${value.mode}`),
    capabilitiesError: (message) => events.push(`capabilities-error:${message}`),
    profiles: () => events.push("profiles"),
    projects: (projects) => events.push(`projects:${projects.map((item) => item.id).join(",")}`),
    threads: () => events.push("threads"),
    preferences: () => events.push("preferences"),
    productAvailability: () => events.push("products"),
    repository: (value) => events.push(`repository:${value.root}`),
    repositoryBusy: (busy) => events.push(`busy:${busy}`),
    repositoryError: (message) => events.push(`error:${message ?? "clear"}`),
    repositoryDialogClosed: () => events.push("dialog-closed"),
    repositoryRestoring: (restoring) => events.push(`restoring:${restoring}`),
  };
}

function response(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("boot and restore share one project request", async () => {
  const events: string[] = [];
  let projectRequests = 0;
  const module = new ApplicationShellBootstrapModule({
    request: async (path) => {
      if (path === "/api/host/capabilities") return response(localCapabilities);
      if (path === "/api/projects/list") {
        projectRequests += 1;
        return response({ projects: [] });
      }
      return response({});
    },
    locationSearch: () => "",
    readLastRepositoryRoot: () => null,
    writeLastRepositoryRoot: () => undefined,
    projection: projection(events),
  });

  module.start();
  await settle();

  assert.equal(projectRequests, 1);
  assert.ok(events.includes("restoring:false"));
});

test("a newer project refresh owns the projection when an older request finishes last", async () => {
  const events: string[] = [];
  const completions: Array<(value: ReturnType<typeof response>) => void> = [];
  let deferProjects = false;
  const module = new ApplicationShellBootstrapModule({
    request: async (path) => {
      if (path === "/api/host/capabilities") return response(localCapabilities);
      if (path === "/api/projects/list") {
        if (!deferProjects) return response({ projects: [] });
        return new Promise((resolve) => completions.push(resolve));
      }
      return response({});
    },
    locationSearch: () => "",
    readLastRepositoryRoot: () => null,
    writeLastRepositoryRoot: () => undefined,
    projection: projection(events),
  });
  module.start();
  await settle();
  events.length = 0;
  deferProjects = true;

  const older = module.refresh("projects");
  const newer = module.refresh("projects");
  completions[1]!(response({ projects: [project("new", "/new")] }));
  await newer;
  completions[0]!(response({ projects: [project("old", "/old")] }));
  await older;

  assert.deepEqual(
    events.filter((event) => event.startsWith("projects:")),
    ["projects:new"],
  );
});

test("restoration tries URL, last root, then saved projects without duplicates", async () => {
  const events: string[] = [];
  const opened: string[] = [];
  let projectRequests = 0;
  const projects = [project("url", "/url"), project("fallback", "/fallback")];
  const module = new ApplicationShellBootstrapModule({
    request: async (path, init) => {
      if (path === "/api/host/capabilities") return response(localCapabilities);
      if (path === "/api/projects/list") {
        projectRequests += 1;
        return response({ projects });
      }
      if (path === "/api/repositories/open") {
        const target = (JSON.parse(String(init.body)) as { path: string }).path;
        opened.push(target);
        return target === "/fallback"
          ? response(repository(target))
          : response({ error: "missing" }, false);
      }
      return response({ threads: [] });
    },
    locationSearch: () => "?project=url",
    readLastRepositoryRoot: () => "/url",
    writeLastRepositoryRoot: () => undefined,
    projection: projection(events),
  });

  module.start();
  await settle();

  assert.deepEqual(opened, ["/url", "/fallback"]);
  assert.equal(projectRequests, 2);
  assert.ok(events.includes("repository:/fallback"));
});

test("managed restoration uses repository identifiers and never local-root storage", async () => {
  const events: string[] = [];
  const bodies: unknown[] = [];
  let readLast = 0;
  let writeLast = 0;
  const managed = { ...localCapabilities, mode: "managed", managed: true } as HostCapabilities;
  const module = new ApplicationShellBootstrapModule({
    request: async (path, init) => {
      if (path === "/api/host/capabilities") return response(managed);
      if (path === "/api/projects/list") {
        return response({ projects: [project("project", "/private", "repository-1")] });
      }
      if (path === "/api/repositories/open") {
        bodies.push(JSON.parse(String(init.body)));
        return response(repository("/canonical"));
      }
      return response({ threads: [] });
    },
    locationSearch: () => "",
    readLastRepositoryRoot: () => {
      readLast += 1;
      return "/private";
    },
    writeLastRepositoryRoot: () => {
      writeLast += 1;
    },
    projection: projection(events),
  });

  module.start();
  await settle();

  assert.deepEqual(bodies, [{ repositoryId: "repository-1" }]);
  assert.equal(readLast, 0);
  assert.equal(writeLast, 0);
});
