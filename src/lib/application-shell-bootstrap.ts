import { readPreferencesResponse, type Preferences } from "../preferences";
import type { ClaudeProfile, HostCapabilities, RepositoryMetadata, ThreadMetadata } from "../types";
import type { SavedProject } from "../features/dialogs/repository-dialog";
import { readProductAvailabilityResponse, type ProductAvailability } from "./product-availability";

interface JsonResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export interface ApplicationShellBootstrapProjection {
  capabilities(capabilities: HostCapabilities): void;
  capabilitiesError(message: string): void;
  profiles(profiles: ClaudeProfile[]): void;
  projects(projects: SavedProject[], chiseiBindingAdministrationAvailable: boolean): void;
  threads(threads: ThreadMetadata[]): void;
  preferences(preferences: Preferences, recovered: boolean): void;
  productAvailability(availability: ProductAvailability): void;
  repository(repository: RepositoryMetadata): void;
  repositoryBusy(busy: boolean): void;
  repositoryError(message: string | null): void;
  repositoryDialogClosed(): void;
  repositoryRestoring(restoring: boolean): void;
}

export interface ApplicationShellBootstrapAdapters {
  request(path: string, init: RequestInit): Promise<JsonResponse>;
  locationSearch(): string;
  readLastRepositoryRoot(): string | null;
  writeLastRepositoryRoot(root: string): void;
  projection: ApplicationShellBootstrapProjection;
}

export interface OpenRepositoryOptions {
  quiet?: boolean;
}

const LOCAL_CAPABILITIES: HostCapabilities = {
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

/** Owns application-shell boot ordering and repository restoration behind one seam. */
export class ApplicationShellBootstrapModule {
  private active = false;
  private generation = 0;
  private capabilities = LOCAL_CAPABILITIES;
  private projectsListInflight: Promise<SavedProject[]> | null = null;
  private projectsListSequence = 0;

  constructor(private readonly adapters: ApplicationShellBootstrapAdapters) {}

  start(): void {
    this.active = true;
    const generation = ++this.generation;
    void this.loadProfiles(generation);
    void this.loadThreads(generation);
    void this.loadSavedProjects({}, generation);
    void this.loadPreferences(generation);
    void this.loadProductAvailability(generation);
    void this.loadCapabilitiesAndRestore(generation);
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    this.projectsListSequence += 1;
    this.projectsListInflight = null;
  }

  async refresh(target: "profiles" | "projects" | "threads"): Promise<void> {
    if (target === "profiles") await this.loadProfiles();
    else if (target === "projects") await this.loadSavedProjects({ fresh: true });
    else await this.loadThreads();
  }

  async openRepository(
    target: string,
    options: OpenRepositoryOptions = {},
  ): Promise<RepositoryMetadata | null> {
    const generation = this.generation;
    const { projection } = this.adapters;
    projection.repositoryBusy(true);
    if (!options.quiet) projection.repositoryError(null);
    try {
      const response = await this.adapters.request("/api/repositories/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          this.capabilities.managed ? { repositoryId: target } : { path: target },
        ),
      });
      const body = (await response.json()) as RepositoryMetadata | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body ? body.error : "Repository discovery failed.");
      }
      const repository = body as RepositoryMetadata;
      if (!this.isCurrent(generation)) return null;
      projection.repository(repository);
      if (!this.capabilities.managed) this.adapters.writeLastRepositoryRoot(repository.root);
      if (options.quiet) {
        await this.loadThreads();
      } else {
        await Promise.all([this.loadThreads(), this.loadSavedProjects({ fresh: true })]);
        if (this.isCurrent(generation)) projection.repositoryDialogClosed();
      }
      return repository;
    } catch (error) {
      if (!options.quiet && this.isCurrent(generation)) {
        projection.repositoryError(
          error instanceof Error ? error.message : "Repository discovery failed.",
        );
      }
      return null;
    } finally {
      if (this.isCurrent(generation)) projection.repositoryBusy(false);
    }
  }

  private async loadCapabilitiesAndRestore(generation: number): Promise<void> {
    try {
      const response = await this.adapters.request("/api/host/capabilities", { method: "POST" });
      if (!response.ok) throw new Error("The host capability contract is unavailable.");
      const body = (await response.json()) as HostCapabilities;
      if (body.mode !== "local" && body.mode !== "remote" && body.mode !== "managed") {
        throw new Error("The host capability contract is invalid.");
      }
      if (!this.isCurrent(generation)) return;
      this.capabilities = body;
      this.adapters.projection.capabilities(body);
      await this.restoreRepository(generation);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.adapters.projection.capabilitiesError(
          error instanceof Error ? error.message : "The host capability contract is unavailable.",
        );
      }
    }
  }

  private async restoreRepository(generation: number): Promise<void> {
    try {
      const projectId = new URLSearchParams(this.adapters.locationSearch()).get("project");
      const lastRoot = this.capabilities.managed ? null : this.adapters.readLastRepositoryRoot();
      const projects = await this.loadSavedProjects({}, generation);
      if (!this.isCurrent(generation)) return;
      const candidates: string[] = [];
      if (projectId) {
        for (const project of projects) {
          if (project.id === projectId || project.memberIds?.includes(projectId)) {
            candidates.push(this.projectTarget(project));
          }
        }
      }
      if (lastRoot) candidates.push(lastRoot);
      candidates.push(...projects.map((project) => this.projectTarget(project)));
      const seen = new Set<string>();
      for (const target of candidates) {
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const repository = await this.openRepository(target, { quiet: true });
        if (!this.isCurrent(generation)) return;
        if (repository) {
          await this.loadSavedProjects({ fresh: true });
          return;
        }
      }
    } catch {
      // An unavailable history leaves the shell empty and usable.
    } finally {
      if (this.isCurrent(generation)) this.adapters.projection.repositoryRestoring(false);
    }
  }

  private projectTarget(project: SavedProject): string {
    return this.capabilities.managed ? (project.managedRepositoryId ?? "") : project.root;
  }

  private async loadProfiles(generation = this.generation): Promise<void> {
    try {
      const response = await this.adapters.request("/api/provider/profiles/list", {
        method: "POST",
      });
      const body = (await response.json()) as { profiles?: ClaudeProfile[] };
      if (response.ok && this.isCurrent(generation)) {
        this.adapters.projection.profiles(body.profiles ?? []);
      }
    } catch {
      // Keep the last projection.
    }
  }

  private async loadThreads(generation = this.generation): Promise<void> {
    try {
      const response = await this.adapters.request("/api/state/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "" }),
      });
      const body = (await response.json()) as { threads?: ThreadMetadata[] };
      if (response.ok && this.isCurrent(generation)) {
        this.adapters.projection.threads(body.threads ?? []);
      }
    } catch {
      // Keep the last projection.
    }
  }

  private async loadSavedProjects(
    options: { fresh?: boolean } = {},
    generation = this.generation,
  ): Promise<SavedProject[]> {
    if (!options.fresh && this.projectsListInflight) return this.projectsListInflight;
    const sequence = ++this.projectsListSequence;
    const request = async (): Promise<SavedProject[]> => {
      try {
        const response = await this.adapters.request("/api/projects/list", { method: "POST" });
        if (!response.ok) return [];
        const body = (await response.json()) as {
          projects?: SavedProject[];
          chiseiBindingAdministrationAvailable?: boolean;
        };
        const projects = body.projects ?? [];
        if (this.isCurrent(generation) && sequence === this.projectsListSequence) {
          this.adapters.projection.projects(
            projects,
            body.chiseiBindingAdministrationAvailable !== false,
          );
        }
        return projects;
      } catch {
        return [];
      }
    };
    if (options.fresh) return request();
    const pending = request().finally(() => {
      if (this.projectsListInflight === pending) this.projectsListInflight = null;
    });
    this.projectsListInflight = pending;
    return pending;
  }

  private async loadPreferences(generation = this.generation): Promise<void> {
    try {
      const response = await this.adapters.request("/api/preferences/load", { method: "POST" });
      if (!response.ok) return;
      const result = readPreferencesResponse(await response.json());
      if (this.isCurrent(generation) && result) {
        this.adapters.projection.preferences(result.preferences, result.recovered);
      }
    } catch {
      // Keep defaults.
    }
  }

  private async loadProductAvailability(generation = this.generation): Promise<void> {
    try {
      const response = await this.adapters.request("/api/products/availability", {
        method: "POST",
      });
      if (!response.ok) return;
      const availability = readProductAvailabilityResponse(await response.json());
      if (this.isCurrent(generation) && availability) {
        this.adapters.projection.productAvailability(availability);
      }
    } catch {
      // Keep defaults.
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }
}
