import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, readPreferencesResponse, resolveTheme, type Preferences } from "./preferences";
import { initializeRemoteAuthentication } from "./remote-auth";
import "./styles.css";
import type { ClaudeProfile, Product, RepositoryMetadata, ThreadMetadata } from "./types";
import { PageHeader } from "./features/shell/page-header";
import { DomainPage } from "./features/shell/domain-page";
import { CodeWorkbench } from "./features/code/workbench";
import { RepositoryDialog } from "./features/dialogs/repository-dialog";
import { WorktreeDialog } from "./features/dialogs/worktree-dialog";
import { ProfileSettingsDialog } from "./features/dialogs/profile-settings-dialog";
import { AdapterSettingsDialog } from "./features/dialogs/adapter-settings-dialog";
import { ThreadSearchDialog } from "./features/dialogs/thread-search-dialog";
import { CommandPalette } from "./features/dialogs/command-palette";
import { PreferencesDialog } from "./features/dialogs/preferences-dialog";

function App() {
  const [product, setProduct] = useState<Product>("code");
  const [repository, setRepository] = useState<RepositoryMetadata | null>(null);
  const [repositoryDialog, setRepositoryDialog] = useState(false);
  const [worktreeDialog, setWorktreeDialog] = useState(false);
  const [managedWorktreePath, setManagedWorktreePath] = useState<string | null>(null);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [profileDialog, setProfileDialog] = useState(false);
  const [adapterDialog, setAdapterDialog] = useState(false);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [preferencesRecovered, setPreferencesRecovered] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const loadProfiles = async () => {
    const response = await fetch("/api/provider/profiles/list", { method: "POST" });
    const body = await response.json() as { profiles?: ClaudeProfile[] };
    if (response.ok) setProfiles(body.profiles ?? []);
  };
  useEffect(() => { void loadProfiles(); }, []);
  const loadThreads = async () => {
    const response = await fetch("/api/state/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "" }) });
    const body = await response.json() as { threads?: ThreadMetadata[] };
    if (response.ok) setThreads(body.threads ?? []);
  };
  useEffect(() => {
    void loadThreads();
    void fetch("/api/preferences/load", { method: "POST" })
      .then(async (response) => response.ok ? readPreferencesResponse(await response.json()) : null)
      .then((result) => {
        if (!result) return;
        setPreferences(result.preferences);
        setPreferencesRecovered(result.recovered);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = resolveTheme(preferences.theme, media.matches);
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
  const openRepository = async (path: string) => {
    setRepositoryBusy(true);
    setRepositoryError(null);
    try {
      const response = await fetch("/api/repositories/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = await response.json() as RepositoryMetadata | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Repository discovery failed.");
      setRepository(body as RepositoryMetadata);
      await loadThreads();
      setRepositoryDialog(false);
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : "Repository discovery failed.");
    } finally {
      setRepositoryBusy(false);
    }
  };
  return (
    <div className="app">
      <PageHeader product={product} onChange={setProduct} onSettings={() => setPreferencesOpen(true)} />
      <div className="app-content">
        <div className="code-page" hidden={product !== "code"}>
          <CodeWorkbench
            key={repository?.projectId ?? "no-project"}
            repository={repository}
            onOpenRepository={showRepositoryDialog}
            profiles={profiles}
            onOpenProfiles={() => setProfileDialog(true)}
            onSearch={() => setSearchOpen(true)}
            onOpenPalette={() => setPaletteOpen(true)}
            onSelectWorktree={(path) => setRepository((current) => current ? { ...current, selectedWorktree: path } : current)}
            onManageWorktrees={(path) => {
              setManagedWorktreePath(path ?? null);
              setWorktreeDialog(true);
            }}
          />
        </div>
        {product !== "code" && <DomainPage product={product} />}
      </div>
      <RepositoryDialog
        open={repositoryDialog}
        busy={repositoryBusy}
        error={repositoryError}
        onClose={() => setRepositoryDialog(false)}
        onSubmit={openRepository}
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
