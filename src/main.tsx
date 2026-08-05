import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, readPreferencesResponse, resolveTheme, type Preferences } from "./preferences";
import { initializeRemoteAuthentication } from "./remote-auth";
import "./styles.css";
import "./mock-shell.css";
import type {
  ClaudeProfile,
  HostCapabilities,
  Product,
  ProviderId,
  RepositoryMetadata,
  ThreadMetadata,
} from "./types";
import { CodeWorkbench } from "./features/code/workbench";
import { RepositoryDialog, type SavedProject } from "./features/dialogs/repository-dialog";
import { WorktreeDialog } from "./features/dialogs/worktree-dialog";
import {
  ProviderManagementDialog,
  type ProviderManagementDestination,
} from "./features/dialogs/provider-management-dialog";
import { ThreadSearchDialog } from "./features/dialogs/thread-search-dialog";
import { CommandPalette } from "./features/dialogs/command-palette";
import { AutomationsDialog } from "./features/dialogs/automations-dialog";
import { PreferencesDialog } from "./features/dialogs/preferences-dialog";
import { ActivityDialog, type ActivitySelectionAction } from "./features/dialogs/activity-dialog";
import { ConnectionsDialog } from "./features/dialogs/connections-dialog";
import {
  isKeybindingCaptured,
  matchesModifierShortcut,
} from "./lib/workspace-shortcuts";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  readProductAvailabilityResponse,
  type ProductAvailability,
} from "./lib/product-availability";

const desktopPlatform = window.aldunisDesktop?.platform;
if (desktopPlatform) {
  document.documentElement.dataset.desktopShell = desktopPlatform === "darwin" ? "macos" : "native";
}

const LAST_REPOSITORY_ROOT_KEY = "aldunis.lastRepositoryRoot";

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
  const [repositoryRestoring, setRepositoryRestoring] = useState(true);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [chiseiBindingAdministrationAvailable, setChiseiBindingAdministrationAvailable] = useState(true);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [providerManagement, setProviderManagement] = useState<{
    destination: ProviderManagementDestination;
    provider: ProviderId | null;
  } | null>(null);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [preferencesRecovered, setPreferencesRecovered] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [productAvailability, setProductAvailability] = useState<ProductAvailability>(
    DEFAULT_PRODUCT_AVAILABILITY,
  );
  const [hostCapabilities, setHostCapabilities] = useState<HostCapabilities>({
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
  });
  const [hostCapabilitiesLoaded, setHostCapabilitiesLoaded] = useState(false);
  const [hostCapabilitiesError, setHostCapabilitiesError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/host/capabilities", { method: "POST" });
        if (!response.ok) throw new Error("The host capability contract is unavailable.");
        const body = await response.json() as HostCapabilities;
        if (body.mode !== "local" && body.mode !== "remote" && body.mode !== "managed") {
          throw new Error("The host capability contract is invalid.");
        }
        setHostCapabilities(body);
        setHostCapabilitiesLoaded(true);
      } catch (error) {
        setHostCapabilitiesError(
          error instanceof Error ? error.message : "The host capability contract is unavailable.",
        );
      }
    })();
  }, []);
  const loadProfiles = async () => {
    const response = await fetch("/api/provider/profiles/list", { method: "POST" });
    const body = await response.json() as { profiles?: ClaudeProfile[] };
    if (response.ok) {
      setProfiles(body.profiles ?? []);
      window.dispatchEvent(new Event("aldunis:providers-retry"));
    }
  };
  useEffect(() => { void loadProfiles(); }, []);
  const loadSavedProjects = async () => {
    try {
      // Collapsed by git common-dir so worktree checkouts do not spawn duplicate chips.
      const response = await fetch("/api/projects/list", { method: "POST" });
      if (!response.ok) return;
      const body = await response.json() as {
        projects?: SavedProject[];
        chiseiBindingAdministrationAvailable?: boolean;
      };
      setSavedProjects(body.projects ?? []);
      setChiseiBindingAdministrationAvailable(
        body.chiseiBindingAdministrationAvailable !== false,
      );
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
    const applyTheme = () => {
      const theme = resolveTheme(preferences.theme, media.matches);
      document.documentElement.dataset.theme = theme;
      const icon = document.querySelector<HTMLLinkElement>("#app-icon");
      if (icon) icon.href = `/aldunis-mark-${theme}.png`;
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
      if (event.defaultPrevented || isKeybindingCaptured(event.target)) return;
      if (matchesModifierShortcut(event, preferences.commandPaletteShortcut)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (matchesModifierShortcut(event, preferences.conversationSearchShortcut)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [preferences.commandPaletteShortcut, preferences.conversationSearchShortcut]);
  const showRepositoryDialog = () => {
    setRepositoryError(null);
    setRepositoryDialog(true);
  };
  const openRepository = async (target: string, options?: { quiet?: boolean }) => {
    setRepositoryBusy(true);
    if (!options?.quiet) setRepositoryError(null);
    try {
      const response = await fetch("/api/repositories/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(hostCapabilities.managed
          ? { repositoryId: target }
          : { path: target }),
      });
      const body = await response.json() as RepositoryMetadata | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Repository discovery failed.");
      const next = body as RepositoryMetadata;
      setRepository(next);
      if (!hostCapabilities.managed) writeLastRepositoryRoot(next.root);
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
  // Restore the last selected project after refresh/restart.
  useEffect(() => {
    if (!hostCapabilitiesLoaded) return;
    let active = true;
    const restore = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlProjectId = params.get("project");
        const lastRoot = hostCapabilities.managed ? null : readLastRepositoryRoot();
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
              rootCandidates.push(
                hostCapabilities.managed
                  ? (project.managedRepositoryId ?? "")
                  : project.root,
              );
            }
          }
        }
        if (lastRoot) rootCandidates.push(lastRoot);
        for (const project of projects) {
          rootCandidates.push(
            hostCapabilities.managed
              ? (project.managedRepositoryId ?? "")
              : project.root,
          );
        }

        const seen = new Set<string>();
        for (const root of rootCandidates) {
          if (!root || seen.has(root)) continue;
          seen.add(root);
          const opened = await openRepository(root, { quiet: true });
          if (!active) return;
          if (opened) {
            // Quiet restore registers the repository on the host without
            // refreshing the sidebar project registry. Keep the restored
            // project visible before handing control back to the shell.
            await loadSavedProjects();
            return;
          }
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
  }, [hostCapabilitiesLoaded, hostCapabilities.managed]);
  if (hostCapabilitiesError) {
    return (
      <main className="remote-pairing-error" role="alert">
        <h1>Host configuration unavailable</h1>
        <p>{hostCapabilitiesError} Reload this page after the configured host or gateway is available.</p>
      </main>
    );
  }
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
          const target = hostCapabilities.managed
            ? project.managedRepositoryId
            : project.root;
          if (!target) return;
          // Already on this logical project — do not re-open (bumps openedAt / reorders chips).
          if (
            repository
            && (!hostCapabilities.managed && (repository.projectId === project.id
              || project.memberIds?.includes(repository.projectId)
              || repository.root === project.root)
              || hostCapabilities.managed && repository.managedRepositoryId === target)
          ) {
            return;
          }
          void openRepository(target, { quiet: true });
        }}
        profiles={profiles}
        onOpenProfiles={(provider) => {
          if (hostCapabilities.managed) return;
          setProviderManagement({ destination: "profiles", provider: provider ?? null });
        }}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectWorktree={(path) => setRepository((current) => current ? { ...current, selectedWorktree: path } : current)}
        onManageWorktrees={(path) => {
          setManagedWorktreePath(path ?? null);
          setWorktreeDialog(true);
        }}
        onSettings={() => setPreferencesOpen(true)}
        onProjectsChanged={loadSavedProjects}
        onRepositoryChanged={(next) => {
          setRepository(next);
          void loadThreads();
        }}
        chiseiBindingAdministrationAvailable={chiseiBindingAdministrationAvailable}
        orchestrationThreadsBeta={preferences.orchestrationThreadsBeta}
        showThinking={preferences.showThinking}
        managedMode={hostCapabilities.managed}
        managedModel={hostCapabilities.provider?.model}
        managedAccount={hostCapabilities.account}
      />
      <RepositoryDialog
        open={repositoryDialog}
        busy={repositoryBusy}
        error={repositoryError}
        projects={savedProjects}
        currentRoot={repository?.root ?? null}
        managedRepositories={hostCapabilities.managed ? hostCapabilities.repositories : undefined}
        onClose={() => setRepositoryDialog(false)}
        onSubmit={(path) => { void openRepository(path); }}
      />
      {worktreeDialog && (
        <WorktreeDialog
          repository={repository}
          selectedPath={managedWorktreePath}
          managedMode={hostCapabilities.managed}
          onClose={() => setWorktreeDialog(false)}
          onChanged={(next) => {
            setRepository(next);
            void loadThreads();
          }}
        />
      )}
      <ProviderManagementDialog
        open={providerManagement != null && !hostCapabilities.managed}
        profiles={profiles}
        initialDestination={providerManagement?.destination}
        initialProvider={providerManagement?.provider}
        onClose={() => setProviderManagement(null)}
        onProfilesChanged={loadProfiles}
      />
      <ThreadSearchDialog
        open={searchOpen}
        threads={threads}
        onClose={() => setSearchOpen(false)}
        onSelect={(threadId) => {
          window.dispatchEvent(
            new CustomEvent("aldunis:open-conversation", { detail: { threadId } }),
          );
        }}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenRepository={showRepositoryDialog}
        onSearch={() => setSearchOpen(true)}
        threads={threads}
        onOpenConversation={(threadId) => {
          window.dispatchEvent(
            new CustomEvent("aldunis:open-conversation", { detail: { threadId } }),
          );
        }}
        onPreferences={() => setPreferencesOpen(true)}
        onProviderManagement={() => {
          if (hostCapabilities.managed) return;
          setProviderManagement({ destination: "diagnostics", provider: null });
        }}
        onActivity={() => setActivityOpen(true)}
        onConnections={() => setConnectionsOpen(true)}
        onAutomations={() => setAutomationsOpen(true)}
        onManageWorktrees={() => {
          setManagedWorktreePath(null);
          setWorktreeDialog(true);
        }}
        hasRepository={repository != null}
      />
      <AutomationsDialog
        open={automationsOpen}
        threads={threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          projectName: thread.projectName,
          provider: thread.provider,
        }))}
        onClose={() => setAutomationsOpen(false)}
      />
      <PreferencesDialog
        open={preferencesOpen}
        preferences={preferences}
        recovered={preferencesRecovered}
        onClose={() => setPreferencesOpen(false)}
        onOpenProviderManagement={() => {
          if (hostCapabilities.managed) return;
          setProviderManagement({ destination: "diagnostics", provider: null });
        }}
        onOpenConnections={() => setConnectionsOpen(true)}
        onOpenArchivedThreads={() => {
          setPreferencesOpen(false);
          window.dispatchEvent(new CustomEvent("aldunis:show-archived"));
        }}
        onSave={async (value) => {
          const response = await fetch("/api/preferences/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
          if (!response.ok) return;
          setPreferences(await response.json() as Preferences);
          setPreferencesRecovered(false);
          setPreferencesOpen(false);
        }}
      />
      <ActivityDialog
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onSelect={(conversation, action: ActivitySelectionAction) => {
          window.dispatchEvent(
            new CustomEvent("aldunis:open-conversation", {
              detail: {
                threadId: conversation.id,
                conversation,
                action,
              },
            }),
          );
        }}
      />
      <ConnectionsDialog
        open={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
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
