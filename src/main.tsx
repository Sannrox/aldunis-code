import { lazy, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, resolveTheme, type Preferences } from "./preferences";
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
import type { SavedProject } from "./features/dialogs/repository-dialog";
import type { ProviderManagementDestination } from "./features/dialogs/provider-management-dialog";
import type { ActivitySelectionAction } from "./features/dialogs/activity-dialog";
import { DesktopUpdateBanner, type DesktopUpdateControls } from "./features/updates/desktop-update";
import { OptionalControlBoundary } from "./components/optional-control-boundary";
import { isKeybindingCaptured, matchesModifierShortcut } from "./lib/workspace-shortcuts";
import {
  DEFAULT_PRODUCT_AVAILABILITY,
  isProductAvailable,
  type ProductAvailability,
} from "./lib/product-availability";
import { ApplicationShellBootstrapModule } from "./lib/application-shell-bootstrap";
import type { DesktopUpdateSnapshot } from "../desktop/update-contract";

const AutomationsDialog = lazy(async () => ({
  default: (await import("./features/dialogs/automations-dialog")).AutomationsDialog,
}));
const AutonomyDialog = lazy(async () => ({
  default: (await import("./features/dialogs/autonomy-dialog")).AutonomyDialog,
}));
const PreferencesDialog = lazy(async () => ({
  default: (await import("./features/dialogs/preferences-dialog")).PreferencesDialog,
}));
const ActivityDialog = lazy(async () => ({
  default: (await import("./features/dialogs/activity-dialog")).ActivityDialog,
}));
const ConnectionsDialog = lazy(async () => ({
  default: (await import("./features/dialogs/connections-dialog")).ConnectionsDialog,
}));
const RepositoryDialog = lazy(async () => ({
  default: (await import("./features/dialogs/repository-dialog")).RepositoryDialog,
}));
const WorktreeDialog = lazy(async () => ({
  default: (await import("./features/dialogs/worktree-dialog")).WorktreeDialog,
}));
const ProviderManagementDialog = lazy(async () => ({
  default: (await import("./features/dialogs/provider-management-dialog")).ProviderManagementDialog,
}));
const ThreadSearchDialog = lazy(async () => ({
  default: (await import("./features/dialogs/thread-search-dialog")).ThreadSearchDialog,
}));
const CommandPalette = lazy(async () => ({
  default: (await import("./features/dialogs/command-palette")).CommandPalette,
}));

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
  const [chiseiBindingAdministrationAvailable, setChiseiBindingAdministrationAvailable] =
    useState(true);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [providerManagement, setProviderManagement] = useState<{
    destination: ProviderManagementDestination;
    provider: ProviderId | null;
  } | null>(null);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [preferencesRecovered, setPreferencesRecovered] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [productAvailability, setProductAvailability] = useState<ProductAvailability>(
    DEFAULT_PRODUCT_AVAILABILITY,
  );
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateSnapshot | null>(null);
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
  const [hostCapabilitiesError, setHostCapabilitiesError] = useState<string | null>(null);
  const bootstrapReference = useRef<ApplicationShellBootstrapModule | null>(null);
  if (!bootstrapReference.current) {
    bootstrapReference.current = new ApplicationShellBootstrapModule({
      request: (path, init) => fetch(path, init),
      locationSearch: () => window.location.search,
      readLastRepositoryRoot,
      writeLastRepositoryRoot,
      projection: {
        capabilities: setHostCapabilities,
        capabilitiesError: setHostCapabilitiesError,
        profiles: setProfiles,
        projects: (projects, available) => {
          setSavedProjects(projects);
          setChiseiBindingAdministrationAvailable(available);
        },
        threads: setThreads,
        preferences: (next, recovered) => {
          setPreferences(next);
          setPreferencesRecovered(recovered);
        },
        productAvailability: setProductAvailability,
        repository: setRepository,
        repositoryBusy: setRepositoryBusy,
        repositoryError: setRepositoryError,
        repositoryDialogClosed: () => setRepositoryDialog(false),
        repositoryRestoring: setRepositoryRestoring,
      },
    });
  }
  const bootstrap = bootstrapReference.current;
  useEffect(() => {
    bootstrap.start();
    return () => bootstrap.stop();
  }, [bootstrap]);
  const loadProfiles = () => bootstrap.refresh("profiles");
  const loadSavedProjects = () => bootstrap.refresh("projects");
  const loadThreads = () => bootstrap.refresh("threads");
  useEffect(() => {
    if (!isProductAvailable(product, productAvailability)) {
      setProduct("code");
    }
  }, [product, productAvailability]);
  useEffect(() => {
    const api = window.aldunisDesktop;
    if (!api) return;
    let active = true;
    const unsubscribe = api.onUpdateState((snapshot) => {
      if (active) setDesktopUpdate(snapshot);
    });
    void api
      .getUpdateState()
      .then((snapshot) => {
        if (active && snapshot) setDesktopUpdate(snapshot);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
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
  const openRepository = (target: string, options?: { quiet?: boolean }) =>
    bootstrap.openRepository(target, options);
  const runDesktopUpdateAction = async (
    action: "checkForUpdate" | "downloadUpdate" | "installUpdate",
  ): Promise<void> => {
    const api = window.aldunisDesktop;
    if (!api) return;
    try {
      const snapshot = await api[action]();
      if (snapshot) setDesktopUpdate(snapshot);
    } catch {
      // The main process publishes a sanitized error state for updater failures.
    }
  };
  const desktopUpdateControls: DesktopUpdateControls | undefined = desktopPlatform
    ? {
        snapshot: desktopUpdate,
        onCheck: () => {
          void runDesktopUpdateAction("checkForUpdate");
        },
        onDownload: () => {
          void runDesktopUpdateAction("downloadUpdate");
        },
        onInstall: () => {
          void runDesktopUpdateAction("installUpdate");
        },
      }
    : undefined;
  if (hostCapabilitiesError) {
    return (
      <main className="remote-pairing-error" role="alert">
        <h1>Host configuration unavailable</h1>
        <p>
          {hostCapabilitiesError} Reload this page after the configured host or gateway is
          available.
        </p>
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
          const project = savedProjects.find(
            (item) => item.id === projectId || item.memberIds?.includes(projectId),
          );
          if (!project) return;
          const target = hostCapabilities.managed ? project.managedRepositoryId : project.root;
          if (!target) return;
          // Already on this logical project — do not re-open (bumps openedAt / reorders chips).
          if (
            repository &&
            ((!hostCapabilities.managed &&
              (repository.projectId === project.id ||
                project.memberIds?.includes(repository.projectId) ||
                repository.root === project.root)) ||
              (hostCapabilities.managed && repository.managedRepositoryId === target))
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
        onSelectWorktree={(path) =>
          setRepository((current) => (current ? { ...current, selectedWorktree: path } : current))
        }
        onManageWorktrees={(path) => {
          setManagedWorktreePath(path ?? null);
          setWorktreeDialog(true);
        }}
        onSettings={() => setPreferencesOpen(true)}
        onProjectsChanged={async () => {
          await loadSavedProjects();
        }}
        onRepositoryChanged={(next) => {
          setRepository(next);
          void loadThreads();
        }}
        chiseiBindingAdministrationAvailable={chiseiBindingAdministrationAvailable}
        orchestrationThreadsBeta={preferences.orchestrationThreadsBeta}
        showThinking={preferences.showThinking}
        conversationOpenScroll={preferences.conversationOpenScroll}
        managedWorktreeLimit={preferences.managedWorktreeLimit}
        managedMode={hostCapabilities.managed}
        managedModel={hostCapabilities.provider?.model}
        managedAccount={hostCapabilities.account}
      />
      {desktopUpdateControls && <DesktopUpdateBanner {...desktopUpdateControls} />}
      <>
        {repositoryDialog && (
          <OptionalControlBoundary
            label="Repository controls"
            onDismiss={() => setRepositoryDialog(false)}
          >
            <RepositoryDialog
              open={repositoryDialog}
              busy={repositoryBusy}
              error={repositoryError}
              projects={savedProjects}
              currentRoot={repository?.root ?? null}
              managedRepositories={
                hostCapabilities.managed ? hostCapabilities.repositories : undefined
              }
              onClose={() => setRepositoryDialog(false)}
              onSubmit={(path) => {
                void openRepository(path);
              }}
            />
          </OptionalControlBoundary>
        )}
        {worktreeDialog && (
          <OptionalControlBoundary
            label="Worktree controls"
            onDismiss={() => setWorktreeDialog(false)}
          >
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
          </OptionalControlBoundary>
        )}
        {providerManagement != null && !hostCapabilities.managed && (
          <OptionalControlBoundary
            label="Provider management"
            onDismiss={() => setProviderManagement(null)}
          >
            <ProviderManagementDialog
              open
              profiles={profiles}
              initialDestination={providerManagement.destination}
              initialProvider={providerManagement.provider}
              onClose={() => setProviderManagement(null)}
              onProfilesChanged={loadProfiles}
            />
          </OptionalControlBoundary>
        )}
        {searchOpen && (
          <OptionalControlBoundary
            label="Conversation search"
            onDismiss={() => setSearchOpen(false)}
          >
            <ThreadSearchDialog
              open
              threads={threads}
              onClose={() => setSearchOpen(false)}
              onSelect={(threadId) => {
                window.dispatchEvent(
                  new CustomEvent("aldunis:open-conversation", { detail: { threadId } }),
                );
              }}
            />
          </OptionalControlBoundary>
        )}
        {paletteOpen && (
          <OptionalControlBoundary label="Command palette" onDismiss={() => setPaletteOpen(false)}>
            <CommandPalette
              open
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
              onAutonomy={() => setAutonomyOpen(true)}
              onManageWorktrees={() => {
                setManagedWorktreePath(null);
                setWorktreeDialog(true);
              }}
              hasRepository={repository != null}
            />
          </OptionalControlBoundary>
        )}
        {automationsOpen && (
          <OptionalControlBoundary label="Automations" onDismiss={() => setAutomationsOpen(false)}>
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
          </OptionalControlBoundary>
        )}
        {autonomyOpen && (
          <OptionalControlBoundary label="Autonomy" onDismiss={() => setAutonomyOpen(false)}>
            <AutonomyDialog
              open={autonomyOpen}
              repository={repository}
              projects={savedProjects}
              managed={hostCapabilities.managed}
              onClose={() => setAutonomyOpen(false)}
            />
          </OptionalControlBoundary>
        )}
        {preferencesOpen && (
          <OptionalControlBoundary label="Preferences" onDismiss={() => setPreferencesOpen(false)}>
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
              desktopUpdates={desktopUpdateControls}
              onSave={async (value) => {
                const response = await fetch("/api/preferences/save", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(value),
                });
                if (!response.ok) return;
                setPreferences((await response.json()) as Preferences);
                setPreferencesRecovered(false);
                setPreferencesOpen(false);
              }}
            />
          </OptionalControlBoundary>
        )}
        {activityOpen && (
          <OptionalControlBoundary label="Activity" onDismiss={() => setActivityOpen(false)}>
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
          </OptionalControlBoundary>
        )}
        {connectionsOpen && (
          <OptionalControlBoundary label="Connections" onDismiss={() => setConnectionsOpen(false)}>
            <ConnectionsDialog open onClose={() => setConnectionsOpen(false)} />
          </OptionalControlBoundary>
        )}
      </>
    </div>
  );
}

void initializeRemoteAuthentication()
  .then(async (remoteEnabled) => {
    if (remoteEnabled && window.aldunisDesktop) {
      const confirmed = await window.aldunisDesktop.confirmRemoteEnvironmentPairing();
      if (!confirmed) throw new Error("The desktop could not confirm the remote pairing.");
    }
    if (window.aldunisDesktop) {
      window.aldunisDesktopCapabilities = await window.aldunisDesktop.getCapabilities();
    }
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    const root = document.getElementById("root")!;
    root.innerHTML = "";
    const main = document.createElement("main");
    main.className = "remote-pairing-error";
    main.setAttribute("role", "alert");
    const heading = document.createElement("h1");
    heading.textContent = "Remote pairing failed";
    const detail = document.createElement("p");
    detail.textContent =
      error instanceof Error ? error.message : "The pairing link is invalid or expired.";
    main.append(heading, detail);
    root.append(main);
  });
