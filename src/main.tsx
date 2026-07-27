import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, readPreferencesResponse, resolveTheme, type Preferences } from "./preferences";
import { initializeRemoteAuthentication } from "./remote-auth";
import "./styles.css";
import "./mock-shell.css";
import type { ClaudeProfile, Product, RepositoryMetadata, ThreadMetadata } from "./types";
import { CodeWorkbench } from "./features/code/workbench";
import { RepositoryDialog, type SavedProject } from "./features/dialogs/repository-dialog";
import { WorktreeDialog } from "./features/dialogs/worktree-dialog";
import { ProfileSettingsDialog } from "./features/dialogs/profile-settings-dialog";
import { AdapterSettingsDialog } from "./features/dialogs/adapter-settings-dialog";
import { ThreadSearchDialog } from "./features/dialogs/thread-search-dialog";
import { CommandPalette } from "./features/dialogs/command-palette";
import { AutomationsDialog } from "./features/dialogs/automations-dialog";
import { PreferencesDialog } from "./features/dialogs/preferences-dialog";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  readProductAvailabilityResponse,
  type ProductAvailability,
} from "./lib/product-availability";

const LAST_REPOSITORY_ROOT_KEY = "aldunis.lastRepositoryRoot";

function isDesignMockQuery(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1" || params.get("design") === "1";
}

function readLastRepositoryRoot(): string | null {
  try {
    return window.localStorage.getItem(LAST_REPOSITORY_ROOT_KEY);
  } catch {
    return null;
  }
}

function writeLastRepositoryRoot(root: string): void {
  try {
    window.localStorage.setItem(LAST_REPOSITORY_ROOT_KEY, root);
  } catch {
    /* ignore quota / private mode */
  }
}

function App() {
  const [product, setProduct] = useState<Product>("code");
  const [repository, setRepository] = useState<RepositoryMetadata | null>(null);
  const [repositoryDialog, setRepositoryDialog] = useState(false);
  const [worktreeDialog, setWorktreeDialog] = useState(false);
  const [managedWorktreePath, setManagedWorktreePath] = useState<string | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [repositoryRestoring, setRepositoryRestoring] = useState(() => !isDesignMockQuery());
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [profileDialog, setProfileDialog] = useState(false);
  const [adapterDialog, setAdapterDialog] = useState(false);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesRecovered, setPreferencesRecovered] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [productAvailability, setProductAvailability] = useState<ProductAvailability>(
    DEFAULT_PRODUCT_AVAILABILITY,
  );
  const loadProfiles = async () => {
    const response = await fetch("/api/provider/profiles/list", { method: "POST" });
    const body = await response.json() as { profiles?: ClaudeProfile[] };
    if (response.ok) setProfiles(body.profiles ?? []);
  };
  useEffect(() => { void loadProfiles(); }, []);
  const loadSavedProjects = async () => {
    try {
      // Collapsed by git common-dir so worktree checkouts do not spawn duplicate chips.
      const response = await fetch("/api/projects/list", { method: "POST" });
      if (!response.ok) return;
      const body = await response.json() as { projects?: SavedProject[] };
      setSavedProjects(body.projects ?? []);
    } catch {
      /* leave existing list */
    }
  };
  const loadThreads = async () => {
    const response = await fetch("/api/state/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "" }) });
    const body = await response.json() as { threads?: ThreadMetadata[] };
    if (response.ok) setThreads(body.threads ?? []);
  };
  useEffect(() => {
    void loadThreads();
    void loadSavedProjects();
    void fetch("/api/preferences/load", { method: "POST" })
      .then(async (response) => response.ok ? readPreferencesResponse(await response.json()) : null)
      .then((result) => {
        if (!result) return;
        setPreferences(result.preferences);
        setPreferencesRecovered(result.recovered);
      })
      .catch(() => undefined);
    void fetch("/api/products/availability", { method: "POST" })
      .then(async (response) => response.ok ? readProductAvailabilityResponse(await response.json()) : null)
      .then((availability) => {
        if (availability) setProductAvailability(availability);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!isProductAvailable(product, productAvailability)) {
      setProduct("code");
    }
  }, [product, productAvailability]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const designMock = isDesignMockQuery();
    const applyTheme = () => {
      // Design mock is always dark (workbench-mock.html).
      document.documentElement.dataset.theme = designMock
        ? "dark"
        : resolveTheme(preferences.theme, media.matches);
    };
    applyTheme();
    document.documentElement.dataset.density = preferences.density;
    document.documentElement.dataset.motion = preferences.reducedMotion;
    document.documentElement.style.fontSize = `${preferences.zoom * 100}%`;
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [preferences]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const matches = preferences.commandPaletteShortcut === "mod+k"
        ? modifier && !event.shiftKey && event.key.toLocaleLowerCase() === "k"
        : modifier && event.shiftKey && event.key.toLocaleLowerCase() === "p";
      if (matches) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [preferences.commandPaletteShortcut]);
  const showRepositoryDialog = () => {
    setRepositoryError(null);
    setRepositoryDialog(true);
  };
  const openRepository = async (path: string, options?: { quiet?: boolean }) => {
    setRepositoryBusy(true);
    if (!options?.quiet) setRepositoryError(null);
    try {
      const response = await fetch("/api/repositories/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await response.json() as RepositoryMetadata | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Repository discovery failed.");
      const next = body as RepositoryMetadata;
      setRepository(next);
      writeLastRepositoryRoot(next.root);
      // Quiet opens (chat select / restore) must not reshuffle project chips.
      if (options?.quiet) {
        await loadThreads();
      } else {
        await Promise.all([loadThreads(), loadSavedProjects()]);
        setRepositoryDialog(false);
      }
      return next;
    } catch (error) {
      if (!options?.quiet) {
        setRepositoryError(error instanceof Error ? error.message : "Repository discovery failed.");
      }
      return null;
    } finally {
      setRepositoryBusy(false);
    }
  };
  // Restore the last selected project after refresh/restart (not in design-mock mode).
  useEffect(() => {
    if (isDesignMockQuery()) {
      setRepositoryRestoring(false);
      return;
    }
    let active = true;
    const restore = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlProjectId = params.get("project");
        const lastRoot = readLastRepositoryRoot();
        let projects: SavedProject[] = [];
        try {
          const response = await fetch("/api/projects/list", { method: "POST" });
          if (response.ok) {
            const body = await response.json() as { projects?: SavedProject[] };
            projects = body.projects ?? [];
            if (active) setSavedProjects(projects);
          }
        } catch {
          /* still try lastRoot below */
        }
        if (!active) return;

        // Prefer URL project, then last root, then newest collapsed project (main checkout).
        const rootCandidates: string[] = [];
        if (urlProjectId) {
          for (const project of projects) {
            if (
              project.id === urlProjectId
              || project.memberIds?.includes(urlProjectId)
            ) {
              rootCandidates.push(project.root);
            }
          }
        }
        if (lastRoot) rootCandidates.push(lastRoot);
        for (const project of projects) rootCandidates.push(project.root);

        const seen = new Set<string>();
        for (const root of rootCandidates) {
          if (!root || seen.has(root)) continue;
          seen.add(root);
          const opened = await openRepository(root, { quiet: true });
          if (!active) return;
          if (opened) return;
        }
      } catch {
        /* leave empty shell if history cannot be restored */
      } finally {
        if (active) setRepositoryRestoring(false);
      }
    };
    void restore();
    return () => {
      active = false;
    };
    // Run once on mount — openRepository is intentionally stable for restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="app">
      <CodeWorkbench
        product={product}
        onProductChange={setProduct}
        productAvailability={productAvailability}
        repository={repository}
        repositoryRestoring={repositoryRestoring && !repository}
        projects={savedProjects}
        onAddProject={showRepositoryDialog}
        onSelectProject={(projectId) => {
          const project = savedProjects.find((item) =>
            item.id === projectId || item.memberIds?.includes(projectId),
          );
          if (!project) return;
          // Already on this logical project — do not re-open (bumps openedAt / reorders chips).
          if (
            repository
            && (repository.projectId === project.id
              || project.memberIds?.includes(repository.projectId)
              || repository.root === project.root)
          ) {
            return;
          }
          void openRepository(project.root, { quiet: true });
        }}
        profiles={profiles}
        onOpenProfiles={() => setProfileDialog(true)}
        onSearch={() => setSearchOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectWorktree={(path) => setRepository((current) => current ? { ...current, selectedWorktree: path } : current)}
        onManageWorktrees={(path) => {
          setManagedWorktreePath(path ?? null);
          setWorktreeDialog(true);
        }}
        onSettings={() => setPreferencesOpen(true)}
      />
      <RepositoryDialog
        open={repositoryDialog}
        busy={repositoryBusy}
        error={repositoryError}
        projects={savedProjects}
        currentRoot={repository?.root ?? null}
        onClose={() => setRepositoryDialog(false)}
        onSubmit={(path) => { void openRepository(path); }}
      />
      {worktreeDialog && (
        <WorktreeDialog
          repository={repository}
          selectedPath={managedWorktreePath}
          onClose={() => setWorktreeDialog(false)}
          onChanged={(next) => {
            setRepository(next);
            void loadThreads();
          }}
        />
      )}
      <ProfileSettingsDialog
        open={profileDialog}
        profiles={profiles}
        onClose={() => setProfileDialog(false)}
        onChanged={loadProfiles}
      />
      <AdapterSettingsDialog open={adapterDialog} onClose={() => setAdapterDialog(false)} />
      <ThreadSearchDialog open={searchOpen} threads={threads} onClose={() => setSearchOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenRepository={showRepositoryDialog}
        onSearch={() => setSearchOpen(true)}
        onPreferences={() => setPreferencesOpen(true)}
        onProviderSettings={() => setProfileDialog(true)}
        onAdapterSettings={() => setAdapterDialog(true)}
        onAutomations={() => setAutomationsOpen(true)}
        onManageWorktrees={() => {
          setManagedWorktreePath(null);
          setWorktreeDialog(true);
        }}
        hasRepository={repository != null}
      />
      <AutomationsDialog
        open={automationsOpen}
        threads={threads.map((thread) => ({ id: thread.id, title: thread.title }))}
        onClose={() => setAutomationsOpen(false)}
      />
      <PreferencesDialog
        open={preferencesOpen}
        preferences={preferences}
        recovered={preferencesRecovered}
        onClose={() => setPreferencesOpen(false)}
        onSave={async (value) => {
          const response = await fetch("/api/preferences/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
          if (!response.ok) return;
          setPreferences(await response.json() as Preferences);
          setPreferencesRecovered(false);
          setPreferencesOpen(false);
        }}
      />
    </div>
  );
}

void initializeRemoteAuthentication()
  .then(() => createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>))
  .catch((error: unknown) => {
    const root = document.getElementById("root")!;
    root.innerHTML = "";
    const main = document.createElement("main");
    main.className = "remote-pairing-error";
    main.setAttribute("role", "alert");
    const heading = document.createElement("h1");
    heading.textContent = "Remote pairing failed";
    const detail = document.createElement("p");
    detail.textContent = error instanceof Error ? error.message : "The pairing link is invalid or expired.";
    main.append(heading, detail);
    root.append(main);
  });
