import { FormEvent, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, readPreferencesResponse, resolveTheme, type Preferences } from "./preferences";
import { initializeRemoteAuthentication } from "./remote-auth";
import "./styles.css";
import { clampSplitPercent, normalizeSplitWorkspaceState } from "./split-workspace";

type Product = "code" | "sekai" | "chisei" | "tenkai";
type WorktreeState = "available" | "detached" | "missing" | "inaccessible";
type WorktreeRecovery = "available" | "moved" | "missing" | "inaccessible";
interface RepositoryMetadata {
  projectId: string;
  name: string;
  root: string;
  selectedWorktree: string;
  worktrees: Array<{
    path: string;
    head: string | null;
    branch: string | null;
    state: WorktreeState;
    ownership: "aldunis" | "user";
    recovery: WorktreeRecovery;
    originalPath: string | null;
  }>;
}
interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  truncated: boolean;
  limits: {
    maxDepth: number;
    maxEntries: number;
    timeoutMs: number;
    maxConcurrent: number;
  };
}
interface WorktreeCreationPlan {
  id: string;
  action: "create";
  repository: string;
  base: string;
  baseRevision: string;
  branch: string;
  path: string;
  expiresAt: string;
}
interface WorktreeRemovalPlan {
  id: string;
  action: "remove";
  repository: string;
  branch: string;
  path: string;
  expiresAt: string;
}
interface ThreadMetadata {
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  updatedAt: string;
  projectName: string;
  pinnedAt: string | null;
  archivedAt: string | null;
}
interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  provider: ProviderId;
  parentThreadId?: string;
  profileId?: string | null;
  model?: string | null;
  updatedAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
}
interface ForkPreview {
  sourceThreadId: string;
  sourceProvider: ProviderId;
  worktree: string;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string }>;
  annotations: Array<{ id: string; path: string; text: string; capturedContext: string }>;
  files: [];
  summaries: [];
  byteCount: number;
  digest: string;
  excluded: string[];
}
type ChangeState = "added" | "modified" | "deleted" | "renamed" | "binary" | "oversized";
interface ChangedFile {
  path: string;
  previousPath: string | null;
  state: ChangeState;
  additions: number | null;
  deletions: number | null;
}
interface FileDiff extends ChangedFile {
  identity: string;
  lines: Array<{
    index: number;
    side: "context" | "addition" | "deletion" | "metadata";
    oldLine: number | null;
    newLine: number | null;
    content: string;
  }>;
  patch: string | null;
  message: string | null;
}
interface DiffAnnotation {
  id: string;
  threadId: string;
  checkpointId: string | null;
  diffIdentity: string;
  path: string;
  previousPath: string | null;
  targetState: ChangeState;
  scope: "file" | "line";
  side: "addition" | "deletion" | "context" | null;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  capturedContext: string;
  resolution: "unresolved" | "resolved";
  stale: boolean;
  staleReason: string | null;
}
interface RepositoryFileResult {
  path: string;
  kind: "text" | "image" | "binary" | "oversized" | "inaccessible";
  size: number | null;
  match: "name" | "content" | null;
}
interface RepositoryFilePreview extends RepositoryFileResult {
  mediaType: string | null;
  content: string | null;
  imageData: string | null;
  truncated: boolean;
  encoding: "utf-8" | "binary" | "image" | "unavailable";
  message: string | null;
  attachable: boolean;
}
interface ProviderCapabilities {
  provider: "claude-code";
  commands: Array<{ name: string; description: string }>;
  attachments: {
    maxCount: number;
    textMaxBytes: number;
    imageMaxBytes: number;
    imageTypes: string[];
  };
}
type ProviderId = "claude-code" | "codex-cli" | `adapter:${string}@${string}`;
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
interface ProviderDiscovery {
  id: ProviderId;
  installed: boolean;
  authenticated?: boolean;
  version?: string | null;
  name?: string;
  enabled?: boolean;
  models?: Array<{
    id: string;
    displayName: string;
    isDefault: boolean;
    reasoningEfforts: ReasoningEffort[];
    defaultReasoningEffort: ReasoningEffort;
  }>;
}
interface ProviderAdapterManifest {
  schemaVersion: 1;
  id: string;
  publisher: { name: string };
  version: string;
  aldunis: { minimumVersion: string; maximumVersion: string };
  protocol: { kind: "acp"; minimumVersion: 1; maximumVersion: 1 };
  executable: { names: string[]; arguments: string[] };
  capabilities: { tools: boolean; images: boolean; sessionResume: boolean };
  environment: Array<{ name: string; required: boolean; sensitive: boolean }>;
  presentation: { name: string; description: string; website?: string };
}
interface InstalledProviderAdapter {
  schemaVersion: 1;
  source: string;
  digest: string;
  enabled: boolean;
  installedAt: string;
  manifest: ProviderAdapterManifest;
}
type ProfileProbeKind = "availability" | "version" | "authentication" | "models";
interface ProfileProbe {
  state: "unknown" | "refreshing" | "ready" | "unavailable";
  checkedAt: string | null;
  detail: string | null;
  authenticated?: boolean;
  models?: string[];
}
interface ClaudeProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  binaryPath: string;
  homePath: string;
  environment: Array<{
    name: string;
    sensitive: boolean;
    value?: string;
    valueSet?: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
  probes: Record<ProfileProbeKind, ProfileProbe>;
}
type DeliveryAction = "stage" | "commit" | "push" | "pull_request";
interface DeliveryContext {
  repository: string;
  worktree: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  remotes: Array<{ name: string; url: string }>;
  staged: string[];
  unstaged: string[];
}
interface DeliveryPlan {
  id: string;
  action: DeliveryAction;
  summary: string;
  repository: string;
  worktree: string;
  branch: string;
  remote: string | null;
  destination: string | null;
  details: string[];
  expiresAt: string;
}
type PreviewState = "approval_pending" | "starting" | "running" | "stopping" | "stopped" | "failed";
interface PreviewSnapshot {
  id: string;
  repository: string;
  worktree: string;
  command: string;
  origin: string;
  state: PreviewState;
  approvalExpiresAt: string | null;
  message: string | null;
}
interface ElementReference {
  selector: string;
  tag: string;
  role: string | null;
  name: string | null;
  text: string | null;
  screenshot: string | null;
}
type ProviderState = "idle" | "starting" | "streaming" | "waiting_for_approval" | "cancelling" | "completed" | "cancelled" | "failed";
type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_started"; toolCallId: string; name: string }
  | {
    kind: "approval_pending";
    id: string;
    runId: string;
    conversationId: string;
    repository: string;
    worktree: string;
    provider: string;
    toolCallId: string;
    toolName: string;
    scope: { summary: string; target: string; details: string[] };
    state: ApprovalState;
    expiresAt: string;
  }
  | { kind: "approval_resolved"; id: string; state: ApprovalState }
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };
type ApprovalState = "pending" | "allowed_once" | "denied" | "cancelled" | "expired" | "provider_failed";
type InteractionMode = "ask" | "plan" | "build";
type CheckpointState = "baseline" | "completed" | "failed" | "superseded" | "unavailable";
interface TurnCheckpoint {
  id: string;
  turnId: string;
  worktree: string;
  baselineIdentity: string | null;
  baselineIndexIdentity: string | null;
  completedIdentity: string | null;
  completedIndexIdentity: string | null;
  state: CheckpointState;
  message: string | null;
}
interface CheckpointFile {
  path: string;
  state: "added" | "modified" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
}
type IconName =
  | "code"
  | "branch"
  | "message"
  | "diff"
  | "spark"
  | "shield"
  | "route"
  | "rocket"
  | "plus"
  | "search"
  | "settings"
  | "chevron";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    code: <><path d="m8 9-3 3 3 3"/><path d="m16 9 3 3-3 3"/><path d="m14 6-4 12"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 8c5 0 5-2 8-2"/></>,
    message: <><path d="M5 18 3 21l4-1h11a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v9a3 3 0 0 0 2 3Z"/><path d="M8 9h8M8 13h5"/></>,
    diff: <><path d="M6 4v16M3 7h6M15 6h6M18 3v6M15 18h6"/></>,
    spark: <path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5L12 2Z"/>,
    shield: <path d="M12 3 5 6v5c0 4.8 3 8 7 10 4-2 7-5.2 7-10V6l-7-3Z"/>,
    route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3M9 18H5a2 2 0 0 1-2-2v-2"/></>,
    rocket: <><path d="M14 5c3-3 6-2 6-2s1 3-2 6l-5 5-4-4 5-5Z"/><path d="m9 10-4 1-2 3 6 1M13 14l-1 5-3 2-1-6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.8-1.9.9-1.9-2.1-2.1-1.9.9-1.9-.8-.7-2h-3l-.7 2-1.9.8-1.9-.9L.9 6 2 7.9l-.8 1.9-2 .7v3l2 .7.8 1.9L.9 18l2.1 2.1 1.9-.9 1.9.8.7 2h3l.7-2 1.9-.8 1.9.9L18.1 18l-.9-1.9.8-1.9 2-.7Z" transform="translate(2) scale(.83)"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function CloseButton({ label, ...props }: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} aria-label={label}>×</button>;
}

const nav: Array<{ id: Product; label: string; icon: IconName; detail: string }> = [
  { id: "code", label: "Code", icon: "code", detail: "Local workbench" },
  { id: "sekai", label: "Sekai", icon: "spark", detail: "Knowledge & evidence" },
  { id: "chisei", label: "Chisei", icon: "shield", detail: "Policy & routing" },
  { id: "tenkai", label: "Tenkai", icon: "rocket", detail: "Delivery & recovery" },
];

const DIALOG_FOCUSABLE = [
  "[data-dialog-initial-focus]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function useDialogFocus(open: boolean, onClose: () => void, dismissible = true) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE) ?? [])]
      .filter((element) => element.offsetParent !== null);
    (focusable.find((element) => element.hasAttribute("data-dialog-initial-focus")) ?? focusable[0])?.focus();
    return () => previouslyFocused?.focus();
  }, [open]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && dismissible) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE) ?? [])]
      .filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  };
  return { dialogRef, onKeyDown };
}

function PageHeader({
  product,
  onChange,
  onSettings,
}: {
  product: Product;
  onChange: (product: Product) => void;
  onSettings: () => void;
}) {
  const current = nav.find((item) => item.id === product)!;
  return (
    <header className="page-header">
      <span className="aldunis-mark" aria-hidden="true">A</span>
      <label className="page-selector">
        <span>Page</span>
        <span className="page-selector-current">
          <Icon name={current.icon} />
          <select
            value={product}
            onChange={(event) => onChange(event.target.value as Product)}
            aria-label="Current page"
          >
            {nav.map((item) => (
              <option value={item.id} key={item.id}>{item.label} — {item.detail}</option>
            ))}
          </select>
          <Icon name="chevron" />
        </span>
      </label>
      <button className="page-settings" aria-label="Appearance and keyboard settings" onClick={onSettings}>
        <Icon name="settings" />
        <span>Preferences</span>
      </button>
    </header>
  );
}

function CodeSidebar({
  repository,
  onOpenRepository,
  changes,
  onShowChanges,
  onBrowseFiles,
  onSearch,
  onOpenPalette,
  conversations,
  primaryConversationId,
  secondaryConversationId,
  onOpenConversation,
  onOpenBeside,
  onNewConversation,
  onSelectWorktree,
  onManageWorktrees,
  showingArchived,
  onToggleArchived,
  onConversationAction,
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  changes: ChangedFile[];
  onShowChanges: () => void;
  onBrowseFiles: () => void;
  onSearch: () => void;
  onOpenPalette: () => void;
  conversations: ConversationSummary[];
  primaryConversationId: string | null;
  secondaryConversationId: string | null;
  onOpenConversation: (id: string) => void;
  onOpenBeside: (id: string) => void;
  onNewConversation: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
  showingArchived: boolean;
  onToggleArchived: () => void;
  onConversationAction: (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => void;
}) {
  return (
    <aside className="context-sidebar">
      <header>
        <div>
          <strong>ALDUNIS CODE</strong>
          <span>Local workbench</span>
        </div>
        <button aria-label="New conversation" onClick={onNewConversation}><Icon name="plus" /></button>
      </header>
      <button className="project-switcher" onClick={onOpenRepository}>
        <span className="repo-glyph">{repository?.name.charAt(0).toUpperCase() ?? "+"}</span>
        <span>
          <strong>{repository?.name ?? "Open repository"}</strong>
          <small>{repository?.root ?? "Select an explicit local root"}</small>
        </span>
        <Icon name="chevron" />
      </button>
      <div className="sidebar-actions">
        <button onClick={onOpenPalette}><Icon name="spark" /> Commands <kbd>⌘ K</kbd></button>
        <button onClick={onSearch}><Icon name="search" /> Thread search</button>
        <button onClick={onBrowseFiles} disabled={!repository}><Icon name="search" /> Browse files</button>
        <button onClick={() => onManageWorktrees()} disabled={!repository}><Icon name="branch" /> Worktrees <span className="count">{repository?.worktrees.length ?? "—"}</span></button>
        <button onClick={onShowChanges} disabled={!repository}>
          <Icon name="diff" /> Changed files <span className="change-count">{repository ? changes.length : "—"}</span>
        </button>
      </div>
      {repository && (
        <div className="worktree-list" aria-label="Repository worktrees">
          {repository.worktrees.map((worktree) => (
            <div className={repository.selectedWorktree === worktree.path ? "selected" : ""} key={worktree.path}>
              <span className={`worktree-state ${worktree.state}`} aria-hidden="true" />
              <button
                className="worktree-select"
                onClick={() => onSelectWorktree(worktree.path)}
                disabled={worktree.state === "missing" || worktree.state === "inaccessible"}
                aria-current={repository.selectedWorktree === worktree.path ? "true" : undefined}
              >
                <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                <small>{worktree.path}</small>
              </button>
              <button
                className="worktree-manage"
                onClick={() => onManageWorktrees(worktree.path)}
                aria-label={`Manage ${worktree.branch ?? worktree.path}`}
              >
                {worktree.ownership === "aldunis" ? worktree.recovery : "user"}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="section-label">
        <span>{showingArchived ? "Archived conversations" : "Conversations"}</span>
        <button onClick={onToggleArchived}>{showingArchived ? "Active" : "Archived"}</button>
      </div>
      <div className="session-list">
        {conversations.map((conversation) => (
          <div className="session-row" key={conversation.id}>
            <button
              className={primaryConversationId === conversation.id ? "active" : ""}
              onClick={() => onOpenConversation(conversation.id)}
              aria-label={`Open ${conversation.title}`}
            >
              <span className="session-icon"><Icon name="message" /></span>
              <span className="session-copy">
                <strong>{conversation.pinnedAt ? "◆ " : ""}{conversation.title}</strong>
                <small>{conversation.worktree}</small>
              </span>
              {(primaryConversationId === conversation.id || secondaryConversationId === conversation.id) && <i />}
            </button>
            <button
              className="open-beside"
              onClick={() => onOpenBeside(conversation.id)}
              disabled={primaryConversationId === conversation.id}
              aria-label={`Open ${conversation.title} beside current conversation`}
            >▥</button>
            <button
              className="conversation-actions"
              aria-label={`Manage ${conversation.title}`}
              onClick={() => {
                const options = showingArchived
                  ? "restore or delete"
                  : `rename, ${conversation.pinnedAt ? "unpin" : "pin"}, archive, or delete`;
                const selected = window.prompt(`Choose ${options}:`)?.trim().toLocaleLowerCase();
                if (selected === "rename" || selected === "pin" || selected === "archive"
                  || selected === "restore" || selected === "delete") {
                  onConversationAction(conversation, selected);
                } else if (selected === "unpin") {
                  onConversationAction(conversation, "pin");
                }
              }}
            >•••</button>
          </div>
        ))}
        {repository && conversations.length === 0 && (
          <p className="empty-conversations">
            {showingArchived ? "No archived conversations." : "Send a prompt to create the first conversation."}
          </p>
        )}
      </div>
      <footer><span className="provider-dot" /><span><strong>Claude Code</strong><small>Not connected</small></span><button>Connect</button></footer>
    </aside>
  );
}

function OverlayDialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const { dialogRef, onKeyDown } = useDialogFocus(true, onClose);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="quick-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-dialog-title" onKeyDown={onKeyDown} tabIndex={-1}>
        <header><h2 id="quick-dialog-title">{title}</h2><CloseButton onClick={onClose} label={`Close ${title}`} /></header>
        {children}
      </section>
    </div>
  );
}

function ThreadSearchDialog({ open, threads, onClose }: { open: boolean; threads: ThreadMetadata[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState<"exclude" | "include" | "only">("exclude");
  const [results, setResults] = useState<ThreadMetadata[]>(threads);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/state/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, archived }),
      signal: controller.signal,
    }).then((response) => response.json()).then((body: { threads?: ThreadMetadata[] }) => setResults(body.threads ?? []));
    return () => controller.abort();
  }, [archived, open, query]);
  if (!open) return null;
  return (
    <OverlayDialog title="Search local conversations" onClose={onClose}>
      <label className="quick-search"><Icon name="search" /><input data-dialog-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, project, or worktree" /></label>
      <label className="search-scope">
        Archived conversations{" "}
        <select value={archived} onChange={(event) => setArchived(event.target.value as typeof archived)}>
          <option value="exclude">Exclude</option>
          <option value="include">Include</option>
          <option value="only">Only archived</option>
        </select>
      </label>
      <p className="search-scope">Search is limited to 50 local metadata matches. Messages, provider output, and repository contents are excluded.</p>
      <div className="quick-results">
        {results.map((thread) => <button key={thread.id}><strong>{thread.title}</strong><small>{thread.projectName} · {thread.worktree}</small></button>)}
        {results.length === 0 && <p>No matching conversations.</p>}
      </div>
    </OverlayDialog>
  );
}

function ForkConversationDialog({
  sourceThreadId,
  sourceProvider,
  profiles,
  providers,
  onClose,
  onCreated,
}: {
  sourceThreadId: string;
  sourceProvider: ProviderId;
  profiles: ClaudeProfile[];
  providers: ProviderDiscovery[];
  onClose: () => void;
  onCreated: (threadId: string) => void;
}) {
  const destination: ProviderId = sourceProvider === "claude-code" ? "codex-cli" : "claude-code";
  const codex = providers.find((provider) => provider.id === "codex-cli");
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [model, setModel] = useState("default");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void fetch("/api/forks/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceThreadId }),
    }).then(async (response) => {
      const body = await response.json() as ForkPreview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The fork preview could not be prepared.");
      setPreview(body);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "The fork preview failed."))
      .finally(() => setBusy(false));
  }, [sourceThreadId]);
  const create = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/forks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceThreadId,
          provider: destination,
          profileId: destination === "claude-code" ? profileId : null,
          model,
          expectedDigest: preview.digest,
        }),
      });
      const body = await response.json() as { thread?: { id: string }; error?: string };
      if (!response.ok || !body.thread) throw new Error(body.error ?? "The fork could not be created.");
      onCreated(body.thread.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The fork failed.");
      setBusy(false);
    }
  };
  const unavailable = destination === "codex-cli"
    ? !codex?.installed || !codex.authenticated
    : profiles.length === 0;
  return (
    <OverlayDialog title={`Fork to ${destination === "codex-cli" ? "Codex CLI" : "Claude Code"}`} onClose={onClose}>
      <div className="fork-dialog">
        <p>This creates a new provider-native conversation. The source and its provider session remain unchanged.</p>
        {busy && !preview && <p role="status">Preparing bounded context…</p>}
        {preview && <>
          <dl>
            <div><dt>Messages</dt><dd>{preview.messages.length}</dd></div>
            <div><dt>Annotations</dt><dd>{preview.annotations.length}</dd></div>
            <div><dt>File context</dt><dd>None</dd></div>
            <div><dt>Summaries</dt><dd>None</dd></div>
            <div><dt>Transfer size</dt><dd>{preview.byteCount.toLocaleString()} bytes</dd></div>
            <div><dt>Worktree</dt><dd>{preview.worktree}</dd></div>
          </dl>
          <details open>
            <summary>Exact messages crossing the boundary</summary>
            {preview.messages.length
              ? preview.messages.map((message) => <article key={message.id}><strong>{message.role}</strong><p>{message.text}</p></article>)
              : <p>No messages will be transferred.</p>}
          </details>
          {preview.annotations.length > 0 && <details>
            <summary>User-authored annotations</summary>
            {preview.annotations.map((annotation) => <article key={annotation.id}><strong>{annotation.path}</strong><p>{annotation.text}</p></article>)}
          </details>}
          <details>
            <summary>Always excluded</summary>
            <ul>{preview.excluded.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
          {destination === "claude-code" ? <>
            <label>Profile<select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>
            <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{["default", "sonnet", "opus", "haiku"].map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
          </> : <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="default">Default model</option>{codex?.models?.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label>}
          <footer><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" onClick={() => void create()} disabled={busy || unavailable}>Create reviewed fork</button></footer>
        </>}
        {unavailable && <p className="context-error" role="alert">The destination provider is unavailable or not authenticated.</p>}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}

function ChangesPanel({
  repository,
  threadId,
  files,
  loading,
  error,
  onClose,
  onRefresh,
  onSendRevision,
  canSendRevision,
}: {
  repository: RepositoryMetadata;
  threadId: string | null;
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSendRevision: (prompt: string) => void;
  canSendRevision: boolean;
}) {
  const { dialogRef, onKeyDown } = useDialogFocus(true, onClose);
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [commentLineIndex, setCommentLineIndex] = useState<number | null | undefined>(undefined);
  const [commentText, setCommentText] = useState("");
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [revisionPreview, setRevisionPreview] = useState<string | null>(null);
  const revisionPreviewRef = useRef<HTMLElement>(null);
  const [delivery, setDelivery] = useState<DeliveryContext | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [deliveryAction, setDeliveryAction] = useState<DeliveryAction>("stage");
  const [message, setMessage] = useState("");
  const [remote, setRemote] = useState("");
  const [base, setBase] = useState("main");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [plan, setPlan] = useState<DeliveryPlan | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const inspectDelivery = async () => {
    const response = await fetch("/api/delivery/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
    });
    const result = await response.json() as DeliveryContext | { error?: string };
    if (!response.ok) throw new Error("error" in result ? result.error : "Delivery state could not be inspected.");
    const context = result as DeliveryContext;
    setDelivery(context);
    setRemote((current) => current || context.remotes[0]?.name || "");
  };
  useEffect(() => {
    setSelectedPaths([]);
    setPlan(null);
    setRemote("");
    setDeliveryError(null);
    void inspectDelivery().catch((cause) => setDeliveryError(cause instanceof Error ? cause.message : "Delivery state could not be inspected."));
  }, [repository.root, repository.selectedWorktree]);
  const prepareDelivery = async () => {
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      const input = deliveryAction === "stage" ? { paths: selectedPaths }
        : deliveryAction === "commit" ? { message }
        : deliveryAction === "push" ? { remote }
        : { remote, base, title, body };
      const response = await fetch("/api/delivery/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          action: deliveryAction,
          input,
        }),
      });
      const result = await response.json() as DeliveryPlan | { error?: string };
      if (!response.ok) throw new Error("error" in result ? result.error : "The action could not be prepared.");
      setPlan(result as DeliveryPlan);
    } catch (cause) {
      setDeliveryError(cause instanceof Error ? cause.message : "The action could not be prepared.");
    } finally {
      setDeliveryBusy(false);
    }
  };
  const executeDelivery = async () => {
    if (!plan) return;
    setDeliveryBusy(true);
    setDeliveryError(null);
    try {
      const response = await fetch(`/api/delivery/plans/${plan.id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "The approved action failed.");
      setPlan(null);
      setSelectedPaths([]);
      await Promise.all([inspectDelivery(), Promise.resolve(onRefresh())]);
    } catch (cause) {
      setDeliveryError(cause instanceof Error ? cause.message : "The approved action failed.");
    } finally {
      setDeliveryBusy(false);
    }
  };
  useEffect(() => {
    if (!selected || !files.some((file) => file.path === selected)) {
      setSelected(files[0]?.path ?? null);
    }
  }, [files, selected]);
  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let active = true;
    setDiff(null);
    setDiffError(null);
    void fetch("/api/changes/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        path: selected,
      }),
    }).then(async (response) => {
      const body = await response.json() as FileDiff | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Diff could not be read.");
      if (active) setDiff(body as FileDiff);
    }).catch((cause) => {
      if (active) setDiffError(cause instanceof Error ? cause.message : "Diff could not be read.");
    });
    return () => { active = false; };
  }, [repository, selected]);
  const loadAnnotations = async () => {
    if (!threadId) {
      setAnnotations([]);
      return;
    }
    const response = await fetch("/api/annotations/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        threadId,
      }),
    });
    const body = await response.json() as { annotations?: DiffAnnotation[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Annotations could not be loaded.");
    const loaded = body.annotations ?? [];
    setAnnotations(loaded);
    setSelectedAnnotationIds((current) => current.filter(
      (id) => loaded.some((annotation) => annotation.id === id),
    ));
  };
  useEffect(() => {
    void loadAnnotations().catch((cause) => {
      setAnnotationError(cause instanceof Error ? cause.message : "Annotations could not be loaded.");
    });
  }, [threadId, repository.root, repository.selectedWorktree]);
  const saveAnnotation = async () => {
    if (!threadId || !selected || !diff || commentLineIndex === undefined || !commentText.trim()) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch("/api/annotations/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          path: selected,
          diffIdentity: diff.identity,
          scope: commentLineIndex === null ? "file" : "line",
          lineIndex: commentLineIndex,
          text: commentText,
        }),
      });
      const body = await response.json() as DiffAnnotation | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "The annotation could not be saved.");
      setCommentLineIndex(undefined);
      setCommentText("");
      await loadAnnotations();
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be saved.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  const setResolution = async (annotation: DiffAnnotation) => {
    if (!threadId) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch(`/api/annotations/${annotation.id}/resolution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          resolved: annotation.resolution === "unresolved",
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The annotation could not be updated.");
      await loadAnnotations();
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The annotation could not be updated.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  const previewRevision = async () => {
    if (!threadId || selectedAnnotationIds.length === 0) return;
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      const response = await fetch("/api/annotations/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          threadId,
          annotationIds: selectedAnnotationIds,
        }),
      });
      const body = await response.json() as { prompt?: string; error?: string };
      if (!response.ok || !body.prompt) throw new Error(body.error ?? "The revision request could not be previewed.");
      setRevisionPreview(body.prompt);
    } catch (cause) {
      setAnnotationError(cause instanceof Error ? cause.message : "The revision request could not be previewed.");
    } finally {
      setAnnotationBusy(false);
    }
  };
  useEffect(() => {
    if (revisionPreview) revisionPreviewRef.current?.focus();
  }, [revisionPreview]);
  return (
    <section
      ref={dialogRef}
      className="changes-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Changes for active conversation"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <header>
        <div><span className="eyebrow">Active conversation</span><h2>Review changes</h2></div>
        <div><button onClick={() => { onRefresh(); void loadAnnotations(); }}>Refresh</button><CloseButton data-dialog-initial-focus onClick={onClose} label="Close changed files" /></div>
      </header>
      <div className="changes-body">
        <nav aria-label="Changed files">
          {loading && <p className="changes-note">Inspecting worktree…</p>}
          {error && <p className="changes-error" role="alert">{error}</p>}
          {!loading && !error && files.length === 0 && <p className="changes-note">The active worktree is clean.</p>}
          {files.map((file) => (
            <div className={selected === file.path ? "changed-file active" : "changed-file"} key={file.path}>
              <input
                type="checkbox"
                aria-label={`Select ${file.path} for staging`}
                checked={selectedPaths.includes(file.path)}
                onChange={(event) => {
                  const stagedPaths = file.previousPath ? [file.path, file.previousPath] : [file.path];
                  setSelectedPaths((paths) => event.target.checked
                    ? [...new Set([...paths, ...stagedPaths])]
                    : paths.filter((path) => !stagedPaths.includes(path)));
                }}
              />
              <button onClick={() => setSelected(file.path)} aria-current={selected === file.path}>
                <span className={`change-state ${file.state}`}>{file.state}</span>
                <span><strong>{file.path}</strong>{file.previousPath && <small>from {file.previousPath}</small>}</span>
                <small className="change-lines">{file.additions === null ? "—" : `+${file.additions}`} {file.deletions === null ? "—" : `−${file.deletions}`}</small>
              </button>
            </div>
          ))}
        </nav>
        <div className="review-workspace">
        <div className="diff-view" tabIndex={0} aria-label={selected ? `Diff for ${selected}` : "File diff"}>
          {diffError && <p className="changes-error" role="alert">{diffError}</p>}
          {selected && !diff && !diffError && <p className="changes-note">Loading structured diff…</p>}
          {diff?.message && <div className={`diff-placeholder ${diff.state}`}><strong>{diff.state}</strong><p>{diff.message}</p></div>}
          {diff && threadId && <button className="file-comment-button" onClick={() => setCommentLineIndex(null)}>Comment on {diff.path}</button>}
          {diff?.patch && <pre>{diff.lines.map((line) => (
            <span className={line.side} key={line.index}>
              {line.side !== "metadata" && threadId
                ? <button
                    className="diff-comment-button"
                    onClick={() => setCommentLineIndex(line.index)}
                    aria-label={`Comment on ${diff.path} ${line.side} line ${line.newLine ?? line.oldLine}`}
                  >+</button>
                : <i aria-hidden="true" />}
              <code>{line.content || " "}</code>
            </span>
          ))}</pre>}
          {!threadId && <p className="changes-note">Send the first conversation turn before saving review comments.</p>}
          {commentLineIndex !== undefined && diff && (
            <section className="annotation-composer" aria-label="New local diff comment">
              <strong>{commentLineIndex === null
                ? `Comment on ${diff.path}`
                : `Comment on ${diff.path} line ${diff.lines.find((line) => line.index === commentLineIndex)?.newLine
                  ?? diff.lines.find((line) => line.index === commentLineIndex)?.oldLine}`}
              </strong>
              <textarea
                autoFocus
                maxLength={2000}
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void saveAnnotation();
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setCommentLineIndex(undefined);
                    setCommentText("");
                  }
                }}
                aria-label="Review comment"
              />
              <footer>
                <button onClick={() => { setCommentLineIndex(undefined); setCommentText(""); }}>Cancel</button>
                <button onClick={() => void saveAnnotation()} disabled={annotationBusy || !commentText.trim()}>Save comment</button>
              </footer>
            </section>
          )}
        </div>
        <section className="annotations-panel" aria-label="Local diff comments">
          <header><strong>Review comments</strong><small>{annotations.filter((item) => item.resolution === "unresolved").length} unresolved</small></header>
          {annotations.length === 0 && <p>No local comments yet.</p>}
          <ul>
            {annotations.map((annotation) => (
              <li className={`${annotation.resolution} ${annotation.stale ? "stale" : ""}`} key={annotation.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedAnnotationIds.includes(annotation.id)}
                    onChange={(event) => setSelectedAnnotationIds((current) => event.target.checked
                      ? [...current, annotation.id]
                      : current.filter((id) => id !== annotation.id))}
                  />
                  <span>
                    <strong>{annotation.path} · {annotation.scope === "file" ? "file" : annotation.side === "deletion" ? `old line ${annotation.oldLine}` : `new line ${annotation.newLine}`}</strong>
                    <small>{annotation.stale ? annotation.staleReason : annotation.checkpointId ? "Checkpoint-bound target" : "Diff-bound target"}</small>
                    <em>{annotation.text}</em>
                  </span>
                </label>
                <button onClick={() => void setResolution(annotation)} disabled={annotationBusy}>
                  {annotation.resolution === "unresolved" ? "Resolve" : "Reopen"}
                </button>
              </li>
            ))}
          </ul>
          {annotationError && <p className="changes-error" role="alert">{annotationError}</p>}
          <button className="preview-revision" onClick={() => void previewRevision()} disabled={annotationBusy || selectedAnnotationIds.length === 0}>Preview revision request</button>
        </section>
        {revisionPreview && (
          <section
            ref={revisionPreviewRef}
            tabIndex={-1}
            className="revision-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Revision request preview"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setRevisionPreview(null);
              }
            }}
          >
            <header><strong>Exact provider context</strong><CloseButton onClick={() => setRevisionPreview(null)} label="Close revision preview" /></header>
            <pre>{revisionPreview}</pre>
            <p>Sending starts a normal follow-up turn. It does not resolve comments, edit files, approve tools, or publish a hosted review.</p>
            <footer>
              <button onClick={() => setRevisionPreview(null)}>Cancel</button>
              <button onClick={() => onSendRevision(revisionPreview)} disabled={!canSendRevision}>Send selected comments</button>
            </footer>
            {!canSendRevision && <p role="alert">Configure an available provider before sending this revision request.</p>}
          </section>
        )}
        <section className="delivery-panel" aria-label="Commit, push, and pull request actions">
          <header><div><strong>Reviewed delivery</strong><small>{delivery?.branch ?? "Detached HEAD"} · {repository.selectedWorktree}</small></div><span>{delivery?.upstream ?? "No upstream"}</span></header>
          <div className="delivery-form">
            <label>Action<select value={deliveryAction} onChange={(event) => { setDeliveryAction(event.target.value as DeliveryAction); setPlan(null); }}>
              <option value="stage">Stage selected files</option><option value="commit">Commit staged files</option><option value="push">Push branch</option><option value="pull_request">Open pull request</option>
            </select></label>
            {deliveryAction === "commit" && <label>Commit message<input value={message} onChange={(event) => setMessage(event.target.value)} /></label>}
            {(deliveryAction === "push" || deliveryAction === "pull_request") && <label>Remote<select value={remote} onChange={(event) => setRemote(event.target.value)}>{delivery?.remotes.map((item) => <option key={item.name} value={item.name}>{item.name} · {item.url}</option>)}</select></label>}
            {deliveryAction === "pull_request" && <><label>Base<input value={base} onChange={(event) => setBase(event.target.value)} /></label><label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="delivery-body">Body<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label></>}
            {!plan && <button className="prepare-delivery" onClick={() => void prepareDelivery()} disabled={deliveryBusy || delivery?.detached}>Inspect action</button>}
          </div>
          {delivery?.detached && <p className="delivery-warning" role="alert">Detached HEAD cannot be delivered. Create or select a branch first.</p>}
          {deliveryError && <p className="delivery-warning" role="alert">{deliveryError}</p>}
          {plan && <div className="delivery-approval"><strong>{plan.summary}</strong><small>{plan.repository} · {plan.worktree} · {plan.branch}</small><ul>{plan.details.map((detail) => <li key={detail}>{detail}</li>)}</ul><footer><button onClick={() => setPlan(null)}>Cancel</button><button className="allow-once" disabled={deliveryBusy} onClick={() => void executeDelivery()}>Approve once</button></footer></div>}
        </section>
        </div>
      </div>
    </section>
  );
}

function RepositoryDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (path: string) => void;
}) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const browseController = useRef<AbortController | null>(null);
  const { dialogRef, onKeyDown } = useDialogFocus(open, onClose, !busy);
  const browse = async (nextPath?: string, hidden = includeHidden) => {
    browseController.current?.abort();
    const controller = new AbortController();
    browseController.current = controller;
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      const response = await fetch("/api/directories/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(nextPath ? { path: nextPath } : {}),
          includeHidden: hidden,
        }),
        signal: controller.signal,
      });
      const body = await response.json() as DirectoryListing | { error?: string };
      if (!response.ok) {
        throw new Error("error" in body ? body.error : "Directories could not be listed.");
      }
      setListing(body as DirectoryListing);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setListing(null);
      setBrowseError(cause instanceof Error ? cause.message : "Directories could not be listed.");
    } finally {
      if (browseController.current === controller) setBrowseBusy(false);
    }
  };
  useEffect(() => {
    if (!open) {
      browseController.current?.abort();
      return;
    }
    setPath("");
    setListing(null);
    setIncludeHidden(false);
    void browse(undefined, false);
    return () => browseController.current?.abort();
  }, [open]);
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBrowseError(null);
    onSubmit(path);
  };
  return (
    <div
      className="dialog-backdrop"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <section ref={dialogRef} className="repository-dialog" role="dialog" aria-modal="true" aria-labelledby="repository-dialog-title" tabIndex={-1}>
        <p className="eyebrow">Local access</p>
        <h2 id="repository-dialog-title">Open a repository</h2>
        <p>Choose a local directory or enter an absolute path. Every selection is canonicalized and validated before the active repository changes.</p>
        {window.aldunisDesktop && (
          <button
            className="native-directory-picker"
            type="button"
            disabled={busy || pickerBusy}
            onClick={() => {
              setPickerBusy(true);
              setBrowseError(null);
              void window.aldunisDesktop?.chooseDirectory()
                .then((selected) => {
                  if (selected) {
                    setPath(selected);
                    onSubmit(selected);
                  }
                })
                .catch(() => setBrowseError("The system folder picker could not be opened."))
                .finally(() => setPickerBusy(false));
            }}
          >
            {pickerBusy ? "Opening system picker…" : "Choose with system picker…"}
          </button>
        )}
        <section className="directory-browser" aria-label="Permitted local directories" aria-busy={browseBusy}>
          <header>
            <strong>{listing?.path ?? "Local directories"}</strong>
            <label>
              <input
                type="checkbox"
                checked={includeHidden}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setIncludeHidden(checked);
                  void browse(listing?.path, checked);
                }}
                disabled={busy || browseBusy}
              />
              Show hidden
            </label>
          </header>
          <nav aria-label="Directory choices">
            {listing?.parent && (
              <button type="button" onClick={() => void browse(listing.parent ?? undefined)} disabled={busy || browseBusy}>
                <span aria-hidden="true">↰</span><strong>Parent directory</strong>
              </button>
            )}
            {listing?.entries.map((entry) => (
              <button type="button" key={entry.path} onClick={() => void browse(entry.path)} disabled={busy || browseBusy}>
                <span aria-hidden="true">▰</span><strong>{entry.name}</strong>
              </button>
            ))}
            {browseBusy && <p role="status">Listing directories…</p>}
            {!browseBusy && listing && listing.entries.length === 0 && <p>No available subdirectories.</p>}
          </nav>
          {listing && (
            <footer>
              <small>{listing.truncated ? `Showing the first ${listing.limits.maxEntries} directories.` : "Directory metadata only."}</small>
              <button type="button" onClick={() => setPath(listing.path)} disabled={busy}>Use this directory</button>
            </footer>
          )}
        </section>
        <form onSubmit={submit}>
          <label htmlFor="repository-path">Repository path <span>— manual fallback</span></label>
          <input
            id="repository-path"
            data-dialog-initial-focus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/Projects/repository"
            disabled={busy}
          />
          {(browseError || error) && <div className="repository-error" role="alert">{browseError ?? error}</div>}
          <footer>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="primary" type="submit" disabled={busy || !path.trim()}>
              {busy ? "Inspecting…" : "Open repository"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function WorktreeDialog({
  repository,
  selectedPath,
  onClose,
  onChanged,
}: {
  repository: RepositoryMetadata | null;
  selectedPath: string | null;
  onClose: () => void;
  onChanged: (repository: RepositoryMetadata) => void;
}) {
  const selected = repository?.worktrees.find((worktree) => worktree.path === selectedPath) ?? null;
  const [base, setBase] = useState("main");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<WorktreeCreationPlan | WorktreeRemovalPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = repository !== null && selectedPath !== undefined;
  const { dialogRef, onKeyDown } = useDialogFocus(open, onClose, !busy);
  useEffect(() => {
    setPlan(null);
    setError(null);
    setBranch("");
    setPath("");
    setBase(repository?.worktrees.find((worktree) => worktree.path === repository.root)?.branch ?? "main");
  }, [repository?.root, selectedPath]);
  if (!repository) return null;

  const request = async (route: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as RepositoryMetadata | WorktreeCreationPlan | WorktreeRemovalPlan | { error?: string };
      if (!response.ok) throw new Error("error" in result ? result.error : "The worktree operation failed.");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The worktree operation failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const previewCreate = async (event: FormEvent) => {
    event.preventDefault();
    const result = await request("/api/worktrees/create/preview", {
      root: repository.root,
      base,
      branch,
      ...(path.trim() ? { path } : {}),
    });
    if (result && "action" in result && result.action === "create") setPlan(result);
  };
  const previewRemove = async () => {
    if (!selected) return;
    const result = await request("/api/worktrees/remove/preview", {
      root: repository.root,
      path: selected.path,
    });
    if (result && "action" in result && result.action === "remove") setPlan(result);
  };
  const confirm = async () => {
    if (!plan) return;
    if (plan.action === "create") {
      const result = await request("/api/worktrees/create", { planId: plan.id, confirm: true });
      if (result && "worktrees" in result) {
        onChanged(result);
        onClose();
      }
      return;
    }
    const result = await request("/api/worktrees/remove", { planId: plan.id, confirm: true });
    if (!result) return;
    const refreshed = await request("/api/repositories/open", { path: repository.root });
    if (refreshed && "worktrees" in refreshed) onChanged(refreshed);
    onClose();
  };

  return (
    <div className="dialog-backdrop" onKeyDown={onKeyDown} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section ref={dialogRef} className="repository-dialog worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-dialog-title" tabIndex={-1}>
        <p className="eyebrow">Isolated conversation workspace</p>
        <h2 id="worktree-dialog-title">{selected ? "Manage worktree" : "Create worktree"}</h2>
        {selected ? (
          <>
            <dl className="worktree-details">
              <div><dt>Repository</dt><dd>{repository.root}</dd></div>
              <div><dt>Worktree</dt><dd>{selected.path}</dd></div>
              <div><dt>Branch</dt><dd>{selected.branch ?? "Detached HEAD"}</dd></div>
              <div><dt>Ownership</dt><dd>{selected.ownership === "aldunis" ? `Aldunis · ${selected.recovery}` : "User-created"}</dd></div>
            </dl>
            {selected.ownership === "user" && <p>This worktree remains selectable, but Aldunis Code does not claim or remove it.</p>}
            {selected.ownership === "aldunis" && !plan && (
              <button className="danger worktree-remove" onClick={() => void previewRemove()} disabled={busy || selected.recovery !== "available"}>
                {busy ? "Inspecting…" : "Preview worktree removal"}
              </button>
            )}
          </>
        ) : (
          <form onSubmit={previewCreate}>
            <label htmlFor="worktree-base">Base revision</label>
            <input id="worktree-base" data-dialog-initial-focus value={base} onChange={(event) => { setBase(event.target.value); setPlan(null); }} disabled={busy} />
            <label htmlFor="worktree-branch">New branch</label>
            <input id="worktree-branch" value={branch} onChange={(event) => { setBranch(event.target.value); setPlan(null); }} placeholder="codex/26-isolated-worktree" disabled={busy} />
            <label htmlFor="worktree-path">Worktree path <span>(optional)</span></label>
            <input id="worktree-path" value={path} onChange={(event) => { setPath(event.target.value); setPlan(null); }} placeholder="Managed application path" disabled={busy} />
            {!plan && <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !base.trim() || !branch.trim()}>{busy ? "Validating…" : "Preview creation"}</button></footer>}
          </form>
        )}
        {plan && (
          <section className="worktree-approval" aria-label={`Approve worktree ${plan.action}`}>
            <strong>{plan.action === "create" ? "Create this isolated worktree once?" : "Remove this worktree checkout once?"}</strong>
            <dl>
              <div><dt>Repository</dt><dd>{plan.repository}</dd></div>
              {plan.action === "create" && <div><dt>Base</dt><dd>{plan.base} · {plan.baseRevision}</dd></div>}
              <div><dt>Branch</dt><dd>{plan.branch}</dd></div>
              <div><dt>Path</dt><dd>{plan.path}</dd></div>
            </dl>
            <p>{plan.action === "create"
              ? "Approval is single-use. The conversation will be bound to the canonical result."
              : "Only the clean checkout is removed. The branch, commits, remotes, and conversation history remain."}</p>
            <footer>
              <button onClick={() => setPlan(null)} disabled={busy}>Back</button>
              <button className={plan.action === "remove" ? "danger" : "primary"} onClick={() => void confirm()} disabled={busy}>
                {busy ? "Revalidating…" : "Approve once"}
              </button>
            </footer>
          </section>
        )}
        {error && <div className="repository-error" role="alert">{error}</div>}
        {selected && !plan && <footer><button onClick={onClose}>Close</button></footer>}
      </section>
    </div>
  );
}

const productPages = {
  sekai: {
    eyebrow: "Knowledge plane",
    title: "Trace what the system knows.",
    summary: "Evidence, provenance, artifacts, and lineage—presented from Sekai Chisei without copying its authority.",
    items: ["Knowledge", "Evidence", "Provenance", "Artifacts", "Explorer"],
    icon: "spark" as IconName,
  },
  chisei: {
    eyebrow: "Governance plane",
    title: "Make every decision inspectable.",
    summary: "Policies, budgets, model routing, usage, and audit remain governed by Sekai Chisei contracts.",
    items: ["Operations", "Policies", "Budgets", "Models", "Routing", "Usage", "Audit"],
    icon: "shield" as IconName,
  },
  tenkai: {
    eyebrow: "Delivery plane",
    title: "Ship with a way back.",
    summary: "Releases, environments, approvals, deployments, rollback, and recovery remain authoritative in Tenkai.",
    items: ["Releases", "Channels", "Environments", "Plans", "Approvals", "Runs", "Recovery"],
    icon: "rocket" as IconName,
  },
};

function DomainPage({ product }: { product: Exclude<Product, "code"> }) {
  const page = productPages[product];
  return (
    <main className={`domain-page ${product}`}>
      <div className="domain-orbit"><Icon name={page.icon} /></div>
      <p className="eyebrow">{page.eyebrow} · planned integration</p>
      <h1>{page.title}</h1>
      <p className="domain-summary">{page.summary}</p>
      <div className="domain-grid">
        {page.items.map((item, index) => (
          <button key={item}>
            <span>0{index + 1}</span>
            <strong>{item}</strong>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
      <aside className="boundary-note"><span>BOUNDARY</span> No service connection is configured. These routes are information architecture, not simulated domain state.</aside>
    </main>
  );
}

function PreviewPanel({
  repository,
  onClose,
  onReference,
}: {
  repository: RepositoryMetadata;
  onClose: () => void;
  onReference: (reference: ElementReference) => void;
}) {
  const [origin, setOrigin] = useState("http://localhost:4173");
  const [preview, setPreview] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<"idle" | "loading" | "visible" | "stale">("idle");
  const [reference, setReference] = useState<ElementReference | null>(null);
  const [referencePending, setReferencePending] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const request = async () => {
    setError(null);
    setReference(null);
    try {
      const response = await fetch("/api/previews/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          origin,
        }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview could not be prepared.");
      setPreview(body as PreviewSnapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview could not be prepared.");
    }
  };
  const decide = async (decision: "allow_once" | "deny") => {
    if (!preview) return;
    setError(null);
    try {
      const response = await fetch(`/api/previews/${preview.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          decision,
        }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview decision failed.");
      setPreview(body as PreviewSnapshot);
      if ((body as PreviewSnapshot).state === "running") setFrameState("loading");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview decision failed.");
    }
  };
  const stop = async () => {
    if (!preview) return;
    setError(null);
    try {
      const response = await fetch(`/api/previews/${preview.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const body = await response.json() as PreviewSnapshot | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Preview could not be stopped.");
      setPreview(body as PreviewSnapshot);
      setFrameState("idle");
      setReference(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview could not be stopped.");
    }
  };
  useEffect(() => {
    if (!preview || !["starting", "running", "stopping"].includes(preview.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/previews/${preview.id}/status`, { method: "POST" });
        const body = await response.json() as PreviewSnapshot;
        if (response.ok) setPreview(body);
      } catch {
        setError("Preview status is unavailable.");
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [preview?.id, preview?.state]);
  useEffect(() => {
    if (frameState !== "loading") return;
    const timer = window.setTimeout(() => {
      setFrameState((current) => current === "loading" ? "stale" : current);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [frameState]);
  useEffect(() => {
    if (preview?.state === "running" && frameState === "idle") setFrameState("loading");
  }, [frameState, preview?.state]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!preview || event.origin !== preview.origin || !referencePending) return;
      const value = event.data as Record<string, unknown>;
      if (value?.type === "aldunis-preview:element-error") {
        setReferencePending(false);
        setError(typeof value.message === "string" ? value.message.slice(0, 240) : "Element is unavailable or stale.");
        return;
      }
      if (value?.type !== "aldunis-preview:element-reference") return;
      const screenshot = typeof value.screenshot === "string"
        && value.screenshot.startsWith("data:image/")
        && value.screenshot.length <= 512_000
        ? value.screenshot
        : null;
      const short = (candidate: unknown, limit: number) => (
        typeof candidate === "string" ? candidate.slice(0, limit) : null
      );
      const selector = short(value.selector, 240);
      const tag = short(value.tag, 32);
      if (!selector || !tag) {
        setError("The page returned an invalid element reference.");
      } else {
        const nextReference = {
          selector,
          tag,
          role: short(value.role, 80),
          name: short(value.name, 240),
          text: short(value.text, 500),
          screenshot,
        };
        setReference(nextReference);
        onReference(nextReference);
      }
      setReferencePending(false);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onReference, preview, referencePending]);
  const selectElement = () => {
    if (!preview || !frameRef.current?.contentWindow) return;
    setError(null);
    setReferencePending(true);
    frameRef.current.contentWindow.postMessage(
      { type: "aldunis-preview:select-element", requestId: crypto.randomUUID() },
      preview.origin,
    );
    window.setTimeout(() => {
      setReferencePending((pending) => {
        if (pending) setError("The page did not provide an element reference. Its preview bridge may be unavailable.");
        return false;
      });
    }, 10_000);
  };
  const running = preview?.state === "running";
  return (
    <section className="preview-panel" aria-label="Web preview">
      <header>
        <div><p className="eyebrow">CONSTRAINED PREVIEW</p><h2>Local web application</h2></div>
        <div>
          {running && <button onClick={() => void stop()}>Stop</button>}
          <CloseButton onClick={onClose} label="Close preview" />
        </div>
      </header>
      <div className="preview-policy">
        <strong>Loopback only</strong>
        <span>Popups, downloads, clipboard, browser permissions, and top navigation are denied.</span>
      </div>
      {!preview && (
        <form className="preview-setup" onSubmit={(event) => { event.preventDefault(); void request(); }}>
          <label htmlFor="preview-origin">Configured preview origin</label>
          <input id="preview-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} />
          <button type="submit">Review start</button>
        </form>
      )}
      {preview?.state === "approval_pending" && (
        <section className="preview-approval">
          <span><Icon name="shield" /></span>
          <div><strong>Start development server once?</strong><code>{preview.command}</code><small>{preview.worktree}</small></div>
          <footer>
            <button onClick={() => void decide("deny")}>Deny</button>
            <button className="allow-once" onClick={() => void decide("allow_once")}>Allow once</button>
          </footer>
        </section>
      )}
      {running && (
        <div className="preview-workspace">
          <div className="preview-toolbar">
            <span>{preview.origin}</span>
            <em className={frameState}>{frameState}</em>
            <button onClick={selectElement} disabled={referencePending || frameState !== "visible"}>
              {referencePending ? "Choose an element…" : "Reference element"}
            </button>
          </div>
          <iframe
            ref={frameRef}
            title="Local application preview"
            src={preview.origin}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            allow="clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
            onLoad={() => setFrameState("visible")}
          />
          {reference && (
            <aside className="element-reference">
              <header><strong>Element context</strong><span>{reference.tag}{reference.role ? ` · ${reference.role}` : ""}</span></header>
              <code>{reference.selector}</code>
              {reference.name && <p>Accessible name: {reference.name}</p>}
              {reference.text && <p>{reference.text}</p>}
              {reference.screenshot && <img src={reference.screenshot} alt="Selected element snapshot" />}
              <small>Only this bounded reference is attached; unrelated page data is not collected.</small>
            </aside>
          )}
        </div>
      )}
      {preview && !["approval_pending", "running"].includes(preview.state) && (
        <div className={`preview-status ${preview.state}`}>
          <strong>{preview.state.replace("_", " ")}</strong>
          <p>{preview.message ?? (preview.state === "starting" ? "Starting the approved command…" : "Preview is inactive.")}</p>
        </div>
      )}
      {error && <div className="provider-error" role="alert">{error}</div>}
    </section>
  );
}

function FileBrowserPanel({
  repository,
  attached,
  maxAttachments,
  onAttach,
  onClose,
}: {
  repository: RepositoryMetadata;
  attached: string[];
  maxAttachments: number;
  onAttach: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<RepositoryFileResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<RepositoryFilePreview | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetch("/api/context/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: repository.selectedWorktree,
          query,
        }),
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json() as {
          files?: RepositoryFileResult[];
          truncated?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? "Worktree files could not be searched.");
        const next = body.files ?? [];
        setFiles(next);
        setTruncated(body.truncated ?? false);
        setSelected((current) => next.some(({ path }) => path === current) ? current : next[0]?.path ?? null);
      }).catch((cause) => {
        if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, repository.root, repository.selectedWorktree]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    void fetch("/api/context/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: repository.root,
        worktree: repository.selectedWorktree,
        path: selected,
      }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { preview?: RepositoryFilePreview; error?: string };
      if (!response.ok || !body.preview) throw new Error(body.error ?? "The selected file could not be previewed.");
      setPreview(body.preview);
    }).catch((cause) => {
      if (cause instanceof Error && cause.name !== "AbortError") setError(cause.message);
    });
    return () => controller.abort();
  }, [repository.root, repository.selectedWorktree, selected]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [onClose]);

  const selectedIndex = files.findIndex(({ path }) => path === selected);
  return (
    <section className="file-browser-panel" aria-label="Browse active worktree">
      <header>
        <div><p className="eyebrow">Bounded local context</p><h2>Browse active worktree</h2></div>
        <CloseButton onClick={onClose} label="Close file browser" />
      </header>
      <div className="file-browser-policy">
        Hidden, ignored, secret-like, and generated ignored files are excluded. Search is local, capped, and not indexed.
      </div>
      <label className="file-search">
        <Icon name="search" />
        <span className="sr-only">Search file names and text content</span>
        <input
          ref={searchRef}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search file names and supported text content"
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="file-browser-body">
        <nav
          aria-label="Worktree files"
          tabIndex={0}
          onKeyDown={(event) => {
            if (!files.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0
              : event.key === "End" ? files.length - 1
              : event.key === "ArrowDown" ? Math.min(files.length - 1, selectedIndex + 1)
              : Math.max(0, selectedIndex - 1);
            setSelected(files[next].path);
          }}
        >
          {loading && <p className="file-browser-note">Searching active worktree…</p>}
          {!loading && files.length === 0 && <p className="file-browser-note">No supported files match this search.</p>}
          {files.map((file) => (
            <button
              className={selected === file.path ? "active" : ""}
              key={file.path}
              onClick={() => setSelected(file.path)}
              aria-current={selected === file.path ? "true" : undefined}
            >
              <strong>{file.path}</strong>
              <small>{file.match ? `${file.match} match · ` : ""}{file.kind}{file.size === null ? "" : ` · ${file.size.toLocaleString()} B`}</small>
            </button>
          ))}
          {truncated && <p className="file-browser-note">Results are capped. Refine the search to find more.</p>}
        </nav>
        <article className="file-preview" tabIndex={0}>
          {!selected && <div className="file-preview-state">Select a file to preview it.</div>}
          {selected && !preview && !error && <div className="file-preview-state">Loading bounded preview…</div>}
          {preview && (
            <>
              <header>
                <div><strong>{preview.path}</strong><small>{preview.encoding} · {preview.size?.toLocaleString() ?? "unknown"} B</small></div>
                <button
                  onClick={() => onAttach(preview.path)}
                  disabled={attached.includes(preview.path) || attached.length >= maxAttachments || !preview.attachable}
                >
                  {attached.includes(preview.path) ? "Attached" : "Attach to composer"}
                </button>
              </header>
              {preview.message && <p className="file-preview-message">{preview.message}</p>}
              {preview.imageData
                ? <img src={preview.imageData} alt={`Preview of ${preview.path}`} />
                : preview.content !== null
                ? <pre>{preview.content}</pre>
                : <div className="file-preview-state">Preview unavailable for this file type.</div>}
            </>
          )}
          {error && <div className="file-browser-error" role="alert">{error}</div>}
        </article>
      </div>
    </section>
  );
}

function Conversation({
  repository,
  conversation,
  pane,
  active,
  onOpenBeside,
  onClosePane,
  onConversationAvailable,
  onOpenRepository,
  onManageWorktrees,
  changes,
  changesLoading,
  changesError,
  changesOpen,
  onShowChanges,
  onHideChanges,
  onRefreshChanges,
  filesOpen,
  onBrowseFiles,
  onHideFiles,
  profiles,
  onOpenProfiles,
}: {
  repository: RepositoryMetadata | null;
  conversation: ConversationSummary | null;
  pane: "primary" | "secondary";
  active: boolean;
  onOpenBeside: () => void;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  onOpenRepository: () => void;
  onManageWorktrees: () => void;
  changes: ChangedFile[];
  changesLoading: boolean;
  changesError: string | null;
  changesOpen: boolean;
  onShowChanges: () => void;
  onHideChanges: () => void;
  onRefreshChanges: () => void;
  filesOpen: boolean;
  onBrowseFiles: () => void;
  onHideFiles: () => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Array<{ text: string; mode: InteractionMode }>>([]);
  const [mode, setMode] = useState<InteractionMode>("ask");
  const [providerEvents, setProviderEvents] = useState<ProviderEvent[]>([]);
  const [providerState, setProviderState] = useState<ProviderState>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [historyRestored, setHistoryRestored] = useState(() => conversation === null);
  const [historyRestoreError, setHistoryRestoreError] = useState<string | null>(null);
  const [conversationId] = useState(() => conversation?.id ?? crypto.randomUUID());
  const [threadId, setThreadId] = useState<string | null>(conversation?.id ?? null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Array<{ value: string; detail: string }>>([]);
  const [suggestionMode, setSuggestionMode] = useState<"files" | "commands" | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [contextError, setContextError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("default");
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "granted",
  );
  const lastAttentionState = useRef<string | null>(null);
  const [provider, setProvider] = useState<ProviderId>("claude-code");
  const [providers, setProviders] = useState<ProviderDiscovery[]>([]);
  const [forkOpen, setForkOpen] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  useEffect(() => {
    const loadProviders = () => {
      void fetch("/api/providers/discover", { method: "POST" })
        .then((response) => response.json())
        .then((body: { providers?: ProviderDiscovery[] }) => setProviders(body.providers ?? []))
        .catch(() => setProviders([{ id: "claude-code", installed: true }]));
    };
    loadProviders();
    window.addEventListener("aldunis:adapters-changed", loadProviders);
    return () => window.removeEventListener("aldunis:adapters-changed", loadProviders);
  }, []);
  const codex = providers.find((item) => item.id === "codex-cli");
  const selectedProvider = providers.find((item) => item.id === provider);
  const selectedCodexModel = codex?.models?.find((item) => item.id === model);
  const providerName = provider === "codex-cli"
    ? "Codex CLI"
    : provider === "claude-code"
    ? "Claude Code"
    : selectedProvider?.name ?? "Provider adapter unavailable";
  const providerLabel = provider === "codex-cli" ? "Codex" : provider === "claude-code" ? "Claude" : providerName;
  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) {
      setProfileId(profiles[0]?.id ?? "");
    }
  }, [profiles, profileId]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [elementReferences, setElementReferences] = useState<ElementReference[]>([]);
  const [checkpoint, setCheckpoint] = useState<TurnCheckpoint | null>(null);
  const [rewindPreview, setRewindPreview] = useState<{
    currentIdentity: string;
    currentIndexIdentity: string;
    files: CheckpointFile[];
  } | null>(null);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  useEffect(() => {
    setSessionId(null);
    setHistoryRestored(conversation === null);
    setHistoryRestoreError(null);
    setThreadId(conversation?.id ?? null);
    setCheckpoint(null);
    setRewindPreview(null);
    setMessages([]);
    setProviderEvents([]);
    setProviderState("idle");
    setRunId(null);
  }, [conversation?.id, repository?.projectId, repository?.selectedWorktree, provider]);
  useEffect(() => {
    if (!repository?.projectId) return;
    let active = true;
    let timer: number | undefined;
    const restore = async () => {
      const response = await fetch("/api/state/load", { method: "POST" });
      if (!active) return;
      if (!response.ok) throw new Error("Conversation history could not be restored.");
      const projection = await response.json() as {
        threads: Array<{
          id: string;
          projectId: string;
          worktree: string;
          provider?: ProviderId;
          profileId?: string | null;
          model?: string | null;
          updatedAt: string;
        }>;
        turns: Array<{
          id: string;
          threadId: string;
          status: "active" | "idle" | "waiting_for_user" | "waiting_for_approval" | "completed" | "failed" | "interrupted" | "running" | "cancelled";
          mode?: InteractionMode;
          providerRunId?: string;
          createdAt: string;
        }>;
        messages: Array<{ turnId: string; role: "user" | "assistant"; text: string; createdAt: string }>;
        providerSessions: Array<{ threadId: string; provider?: ProviderId; sessionId: string }>;
      };
      const thread = conversation
        ? projection.threads.find((item) => (
            item.id === conversation.id
            && item.projectId === repository.projectId
            && item.worktree === repository.selectedWorktree
          ))
        : null;
      if (!thread) {
        setHistoryRestored(true);
        return;
      }
      const threadProvider = thread.provider ?? "claude-code";
      if (threadProvider !== provider) {
        setProvider(threadProvider);
        return;
      }
      if (thread.profileId) setProfileId(thread.profileId);
      if (thread.model) setModel(thread.model);
      const turns = projection.turns
        .filter((item) => item.threadId === thread.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const latest = turns.at(-1);
      if (!latest) {
        setHistoryRestored(true);
        return;
      }
      setThreadId(thread.id);
      setSessionId(projection.providerSessions.find((item) => (
        item.threadId === thread.id
        && (item.provider ?? "claude-code") === provider
      ))?.sessionId ?? null);
      setRunId(
        latest.providerRunId && (
          latest.status === "active"
          || latest.status === "running"
          || latest.status === "waiting_for_approval"
        )
          ? latest.providerRunId
          : null,
      );
      const turnIds = new Set(turns.map((turn) => turn.id));
      const history = projection.messages
        .filter((message) => turnIds.has(message.turnId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      setMessages(history.filter((message) => message.role === "user").map((message) => ({
        text: message.text,
        mode: turns.find((turn) => turn.id === message.turnId)?.mode ?? "ask",
      })));
      setProviderEvents(history.filter((message) => message.role === "assistant").map((message) => ({
        kind: "assistant_text" as const,
        text: message.text,
      })));
      const nextState: ProviderState = latest.status === "active" || latest.status === "running"
        ? "streaming"
        : latest.status === "waiting_for_approval"
          ? "waiting_for_approval"
          : latest.status === "interrupted" || latest.status === "cancelled"
            ? "cancelled"
            : latest.status === "failed"
              ? "failed"
              : latest.status === "completed"
                ? "completed"
                : "idle";
      setProviderState(nextState);
      if (latest.providerRunId && latest.status === "waiting_for_approval") {
        const approvalsResponse = await fetch("/api/provider/approvals/list", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: latest.providerRunId }),
        });
        if (approvalsResponse.ok) {
          const body = await approvalsResponse.json() as {
            approvals: Array<Extract<ProviderEvent, { kind: "approval_pending" }>>;
          };
          setProviderEvents((current) => [
            ...current.filter((event) => event.kind !== "approval_pending"),
            ...body.approvals.map(({ kind: _kind, ...approval }) => ({
              kind: "approval_pending" as const,
              ...approval,
            })),
          ]);
        }
      }
      if (
        notificationsEnabled
        && document.visibilityState !== "visible"
        && lastAttentionState.current !== latest.status
        && ["waiting_for_approval", "completed", "failed", "interrupted"].includes(latest.status)
      ) {
        new Notification("Aldunis Code needs attention", {
          body: latest.status === "waiting_for_approval"
            ? "A local action is waiting for your decision."
            : "A background turn changed state.",
        });
      }
      lastAttentionState.current = latest.status;
      setHistoryRestored(true);
      setHistoryRestoreError(null);
      if (
        latest.status === "active"
        || latest.status === "running"
        || latest.status === "waiting_for_approval"
      ) {
        timer = window.setTimeout(() => attempt(), 10_000);
      }
    };
    const attempt = () => {
      void restore().catch(() => {
        if (!active) return;
        setHistoryRestoreError("Conversation history could not be restored. Retrying locally…");
        timer = window.setTimeout(attempt, 5_000);
      });
    };
    attempt();
    const visible = () => { if (document.visibilityState === "visible") attempt(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [conversation?.id, notificationsEnabled, provider, repository?.projectId, repository?.selectedWorktree]);
  useEffect(() => {
    void fetch("/api/provider/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(async (response) => {
      if (response.ok) setCapabilities(await response.json() as ProviderCapabilities);
    });
  }, []);
  const worktree = repository?.worktrees.find((item) => (
    item.path === repository.selectedWorktree
    && (item.state === "available" || item.state === "detached")
  )) ?? null;
  const conversationBranch = worktree?.branch ?? "Detached HEAD";
  const runActive = providerState === "starting"
    || providerState === "streaming"
    || providerState === "waiting_for_approval"
    || providerState === "cancelling";
  const modeCopy: Record<InteractionMode, { label: string; authority: string }> = {
    ask: { label: "Ask", authority: "Read-only tools" },
    plan: { label: "Plan", authority: "Planning; mutations blocked" },
    build: { label: "Build", authority: "Mutations require approval" },
  };
  useEffect(() => {
    const token = draft.slice(0, draft.length).match(/(?:^|\s)([@/])([^\s]*)$/);
    if (!token || !worktree || !repository) {
      setSuggestionMode(null);
      setSuggestions([]);
      return;
    }
    const [, prefix, query] = token;
    setSuggestionIndex(0);
    if (prefix === "/") {
      setSuggestionMode("commands");
      setSuggestions((capabilities?.commands ?? [])
        .filter((command) => command.name.slice(1).includes(query.toLocaleLowerCase()))
        .map((command) => ({ value: command.name, detail: command.description })));
      return;
    }
    setSuggestionMode("files");
    const controller = new AbortController();
    void fetch("/api/context/files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: repository.root, worktree: worktree.path, query }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json() as { files?: string[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Repository files could not be searched.");
      setSuggestions((body.files ?? []).map((path) => ({ value: path, detail: "Local repository file" })));
    }).catch((error) => {
      if (error instanceof Error && error.name !== "AbortError") setContextError(error.message);
    });
    return () => controller.abort();
  }, [capabilities, draft, repository, worktree]);
  const selectSuggestion = (value: string) => {
    if (suggestionMode === "files") {
      if (!attachments.includes(value)) {
        if (attachments.length >= (capabilities?.attachments.maxCount ?? 8)) {
          setContextError(`Attach at most ${capabilities?.attachments.maxCount ?? 8} files.`);
          return;
        }
        setAttachments((current) => [...current, value]);
      }
      setDraft((current) => current.replace(/(?:^|\s)@[^\s]*$/, (match) => match.startsWith(" ") ? " " : ""));
    } else {
      setDraft((current) => current.replace(/(?:^|\s)\/[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}${value} `));
    }
    setContextError(null);
    setSuggestionMode(null);
    setSuggestions([]);
  };
  const send = async (promptOverride?: string) => {
    const value = (promptOverride ?? draft).trim();
    if (
      !value
      || !repository
      || !worktree
      || (provider === "claude-code" && !profileId)
      || runActive
      || !historyRestored
    ) return;
    const turnMode = mode;
    setMessages((current) => [...current, { text: value, mode: turnMode }]);
    if (promptOverride === undefined) setDraft("");
    const sentAttachments = promptOverride === undefined ? attachments : [];
    if (promptOverride === undefined) setAttachments([]);
    const sentElementReferences = promptOverride === undefined ? elementReferences : [];
    if (promptOverride === undefined) setElementReferences([]);
    setProviderEvents([]);
    setProviderState("starting");
    setRunId(null);
    setCheckpoint(null);
    setRewindPreview(null);
    setCheckpointError(null);
    let activeTurnId: string | null = null;
    let createdThreadId: string | null = null;
    try {
      const response = await fetch("/api/provider/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktree.path,
          prompt: value,
          mode: turnMode,
          conversationId,
          projectId: repository.projectId,
          threadId: threadId ?? undefined,
          resumeSessionId: sessionId ?? undefined,
          attachments: sentAttachments,
          profileId,
          model,
          provider,
          reasoningEffort: provider === "codex-cli" && model !== "default"
            ? reasoningEffort
            : undefined,
          elementReferences: sentElementReferences.map(({ screenshot: _screenshot, ...reference }) => reference),
        }),
      });
      createdThreadId = response.headers.get("x-thread-id");
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? `${providerName} could not start.`);
      }
      const activeRunId = response.headers.get("x-provider-run-id");
      setRunId(activeRunId);
      setThreadId(createdThreadId);
      activeTurnId = response.headers.get("x-turn-id");
      setProviderState("streaming");
      if (!response.body) throw new Error(`${providerName} returned no event stream.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const event = JSON.parse(line) as ProviderEvent;
            if (event.kind === "approval_resolved") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.id === event.id
                  ? { ...candidate, state: event.state }
                  : candidate
              )));
              newline = buffer.indexOf("\n");
              continue;
            }
            setProviderEvents((current) => [...current, event]);
            if (event.kind === "session_started" || event.kind === "turn_completed") setSessionId(event.sessionId);
            if (event.kind === "turn_completed") setProviderState("completed");
            if (event.kind === "cancelled") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.state === "pending"
                  ? { ...candidate, state: "cancelled" }
                  : candidate
              )));
              setProviderState("cancelled");
            }
            if (event.kind === "failed") {
              setProviderEvents((current) => current.map((candidate) => (
                candidate.kind === "approval_pending" && candidate.state === "pending"
                  ? { ...candidate, state: "provider_failed" }
                  : candidate
              )));
              setProviderState("failed");
            }
          }
          newline = buffer.indexOf("\n");
        }
        if (result.done) break;
      }
      if (activeTurnId) {
        const stateResponse = await fetch("/api/state/load", { method: "POST" });
        if (stateResponse.ok) {
          const projection = await stateResponse.json() as { checkpoints?: TurnCheckpoint[] };
          setCheckpoint(projection.checkpoints?.find((item) => item.turnId === activeTurnId) ?? null);
        }
      }
    } catch (error) {
      if (promptOverride === undefined) {
        setAttachments(sentAttachments);
        setElementReferences(sentElementReferences);
      }
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : `${providerName} failed.`,
      }]);
      setProviderState("failed");
    } finally {
      setRunId(null);
      const availableThreadId = createdThreadId ?? conversation?.id;
      if (availableThreadId) onConversationAvailable?.(availableThreadId);
    }
  };
  const previewRewind = async () => {
    if (!checkpoint || !repository || !worktree) return;
    setCheckpointBusy(true);
    setCheckpointError(null);
    try {
      const response = await fetch(`/api/checkpoints/${checkpoint.id}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: worktree.path }),
      });
      const body = await response.json() as {
        currentIdentity?: string;
        currentIndexIdentity?: string;
        files?: CheckpointFile[];
        error?: string;
      };
      if (!response.ok || !body.currentIdentity || !body.currentIndexIdentity || !body.files) {
        throw new Error(body.error ?? "The rewind preview could not be prepared.");
      }
      setRewindPreview({
        currentIdentity: body.currentIdentity,
        currentIndexIdentity: body.currentIndexIdentity,
        files: body.files,
      });
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "The rewind preview failed.");
    } finally {
      setCheckpointBusy(false);
    }
  };
  const confirmRewind = async () => {
    if (!checkpoint || !rewindPreview || !repository || !worktree) return;
    setCheckpointBusy(true);
    setCheckpointError(null);
    try {
      const response = await fetch(`/api/checkpoints/${checkpoint.id}/rewind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktree.path,
          currentIdentity: rewindPreview.currentIdentity,
          currentIndexIdentity: rewindPreview.currentIndexIdentity,
          confirm: true,
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "The workspace could not be rewound.");
      setCheckpoint({ ...checkpoint, state: "superseded", message: "Workspace rewound to the turn baseline." });
      setRewindPreview(null);
    } catch (error) {
      setCheckpointError(error instanceof Error ? error.message : "The workspace rewind failed.");
    } finally {
      setCheckpointBusy(false);
    }
  };
  const cancel = async () => {
    if (!runId) return;
    setProviderState("cancelling");
    try {
      const response = await fetch(`/api/provider/runs/${runId}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error("The provider run could not be cancelled.");
    } catch (error) {
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : "Cancellation failed.",
      }]);
      setProviderState("failed");
    }
  };
  const decideApproval = async (
    approval: Extract<ProviderEvent, { kind: "approval_pending" }>,
    decision: "allow_once" | "deny",
  ) => {
    try {
      const response = await fetch(`/api/provider/approvals/${approval.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: approval.runId,
          conversationId: approval.conversationId,
          repository: approval.repository,
          worktree: approval.worktree,
          toolCallId: approval.toolCallId,
          decision,
        }),
      });
      const body = await response.json() as typeof approval | { error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error : "Approval decision failed.");
      setProviderEvents((current) => current.map((event) => (
        event.kind === "approval_pending" && event.id === approval.id
          ? { ...event, state: (body as typeof approval).state }
          : event
      )));
    } catch (error) {
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : "Approval decision failed.",
      }]);
    }
  };
  const assistantText = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "assistant_text" }> => event.kind === "assistant_text")
    .map((event) => event.text)
    .join("\n");
  const toolEvents = providerEvents.filter((event) => event.kind === "tool_started" || event.kind === "tool_finished");
  const approvals = providerEvents.filter(
    (event): event is Extract<ProviderEvent, { kind: "approval_pending" }> => event.kind === "approval_pending",
  );
  const failure = providerEvents
    .filter((event): event is Extract<ProviderEvent, { kind: "failed" }> => event.kind === "failed")
    .at(-1);
  const conversationEmpty = messages.length === 0
    && providerEvents.length === 0
    && providerState === "idle";
  const emptyState = !repository
    ? {
        title: "Open a repository to begin",
        detail: "Choose an explicit local root before starting a provider conversation.",
        action: <button onClick={onOpenRepository}>Open repository</button>,
      }
    : provider === "claude-code" && !profileId
      ? {
          title: "Configure Claude Code to begin",
          detail: "Add a local Claude profile, then return here to describe the task.",
          action: <button onClick={onOpenProfiles}>Configure Claude</button>,
        }
      : {
          title: "What do you want to work on?",
          detail: "Describe the outcome in the composer. Aldunis Code will keep the conversation bound to this worktree.",
          action: null,
        };
  const stateCopy: Record<ProviderState, string> = {
    idle: repository ? "Ready" : "Open a repository to start",
    starting: `Starting ${providerName}…`,
    streaming: `${providerName} is working…`,
    waiting_for_approval: "Waiting for your approval…",
    cancelling: "Cancelling…",
    completed: "Turn completed",
    cancelled: "Turn cancelled · send another prompt to resume",
    failed: "Provider stopped · send another prompt to resume",
  };
  return (
    <main className="conversation" aria-label={`${pane === "primary" ? "Primary" : "Secondary"} conversation: ${conversation?.title ?? "New conversation"}`}>
      <header className="conversation-header">
        <div className="conversation-identity">
          <span className="pane-label">{pane} pane</span>
          <span className="breadcrumb">
            {repository?.name ?? "No project"} <b>/</b> {worktree?.branch ?? "detached"} <b>/</b> {providerName} · {profileId ? profiles.find((profile) => profile.id === profileId)?.name : "no profile"} · {model} · direct · {mode} · {stateCopy[providerState]}
          </span>
          <h1>{conversation?.title ?? "New conversation"}</h1>
          <small className="conversation-binding">
            {repository && worktree ? `${repository.root} · ${worktree.path} · ${conversationBranch}` : "No available worktree"}
          </small>
        </div>
        <div className="header-actions">
          <button className="mobile-project" onClick={onOpenRepository} aria-label={repository ? `Change repository, current ${repository.name}` : "Open repository"}>
            <Icon name="branch" />
          </button>
          <button className="mobile-worktrees" onClick={onManageWorktrees} disabled={!repository} aria-label="Create isolated conversation worktree">
            <Icon name="plus" />
          </button>
          <button onClick={onShowChanges} disabled={!repository} aria-label={repository ? `Review ${changes.length} changed files` : "Review changed files"}>
            <Icon name="diff" /><span>{changes.length} changes</span>
          </button>
          <button onClick={onBrowseFiles} disabled={!repository} aria-label="Browse active worktree">
            <Icon name="search" /><span>Files</span>
          </button>
          <button onClick={() => setPreviewOpen(true)} disabled={!repository} aria-label="Open web preview">
            <Icon name="code" /><span>Preview</span>
          </button>
          <button
            onClick={() => setForkOpen(true)}
            disabled={!threadId || runActive}
            aria-label="Fork conversation to another provider"
          >
            <Icon name="message" /><span>Fork</span>
          </button>
          <button className="ghost" onClick={onOpenProfiles} aria-label="Open Claude profile settings">•••</button>
          {pane === "primary" && <button className="ghost" onClick={onOpenBeside} aria-label="Open a conversation beside this one">▥</button>}
          {onClosePane && <CloseButton className="ghost" onClick={onClosePane} label={`Close ${pane} pane`} />}
          {!notificationsEnabled && typeof Notification !== "undefined" && Notification.permission !== "denied" && (
            <button
              className="ghost"
              onClick={async () => setNotificationsEnabled(await Notification.requestPermission() === "granted")}
              aria-label="Enable optional background notifications"
            >Notify</button>
          )}
        </div>
      </header>
      <section className="conversation-scroll">
        {conversationEmpty
          ? (
            <section className="conversation-empty" aria-labelledby={`${pane}-empty-title`}>
              <span>New conversation</span>
              <h2 id={`${pane}-empty-title`}>{emptyState.title}</h2>
              <p>{emptyState.detail}</p>
              {emptyState.action}
            </section>
          )
          : <div className="date-rule"><span>Today</span></div>}
        {messages.map((message, index) => (
          <article className="user-message" key={`${message.text}-${index}`}>
            <span className="avatar">RK</span><div><header><strong>You</strong><span className={`turn-mode ${message.mode}`}>{modeCopy[message.mode].label}</span><time>now</time></header><p>{message.text}</p></div>
          </article>
        ))}
        {(providerState !== "idle" || providerEvents.length > 0) && (
          <article className="assistant-message provider-response" aria-live="polite">
            <span className="claude-avatar">C</span>
            <div>
              <header><strong>{providerLabel}</strong><span className="model">{providerName}</span><time>now</time></header>
              {(providerState === "starting" || providerState === "streaming" || providerState === "waiting_for_approval" || providerState === "cancelling") && (
                <div className="thinking"><span /><span>{stateCopy[providerState]}</span></div>
              )}
              {assistantText && <p className="provider-copy">{assistantText}</p>}
              {toolEvents.map((event, index) => (
                <div className={`tool-activity ${event.kind === "tool_finished" && event.failed ? "failed" : ""}`} key={`${event.toolCallId}-${event.kind}-${index}`}>
                  <Icon name="settings" />
                  <span>{event.kind === "tool_started" ? `${event.name} requested` : event.failed ? "Tool failed" : "Tool finished"}</span>
                  <small>{event.toolCallId}</small>
                </div>
              ))}
              {approvals.map((approval) => (
                <section className={`approval-card ${approval.state}`} key={approval.id} aria-label={`${pane} pane approval required: ${approval.scope.summary}`}>
                  <header>
                    <span><Icon name="shield" /></span>
                    <div>
                      <strong>{approval.scope.summary}</strong>
                      <small>{approval.toolName} · one action only</small>
                    </div>
                    <em>{approval.state.replace("_", " ")}</em>
                  </header>
                  <dl className="approval-context">
                    <div><dt>Host</dt><dd>{location.host}</dd></div>
                    <div><dt>Repository</dt><dd>{approval.repository}</dd></div>
                    <div><dt>Worktree</dt><dd>{approval.worktree}</dd></div>
                    <div><dt>Provider</dt><dd>{approval.provider}</dd></div>
                  </dl>
                  <p>{approval.scope.target}</p>
                  {approval.scope.details.length > 0 && (
                    <ul>{approval.scope.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  )}
                  <small className="approval-binding">
                    {location.host} · {pane} pane · conversation {approval.conversationId} · {approval.repository} · {approval.worktree} · {approval.provider} · direct · {approval.toolName} · {approval.scope.target}
                  </small>
                  {approval.state === "pending" && (
                    <footer>
                      <button onClick={() => void decideApproval(approval, "deny")}>Deny</button>
                      <button className="allow-once" onClick={() => void decideApproval(approval, "allow_once")}>Allow once</button>
                    </footer>
                  )}
                </section>
              ))}
              {failure && <div className="provider-error" role="alert">{failure.message}</div>}
              {(providerState === "completed" || providerState === "cancelled") && <p className="provider-state">{stateCopy[providerState]}</p>}
              {checkpoint && (
                <section className={`checkpoint-card ${checkpoint.state}`} aria-label={`Workspace checkpoint: ${checkpoint.state}`}>
                  <header>
                    <div>
                      <strong>Workspace checkpoint</strong>
                      <small>{checkpoint.state}</small>
                    </div>
                    {checkpoint.state === "completed" && !rewindPreview && (
                      <button onClick={() => void previewRewind()} disabled={checkpointBusy}>
                        {checkpointBusy ? "Inspecting…" : "Preview rewind"}
                      </button>
                    )}
                  </header>
                  {checkpoint.message && <p>{checkpoint.message}</p>}
                  {rewindPreview && (
                    <>
                      <p>This restores the turn baseline. Only these files will be affected:</p>
                      <ul>
                        {rewindPreview.files.map((file) => (
                          <li key={`${file.path}-${file.previousPath ?? ""}`}>
                            <span>{file.state}</span> {file.previousPath ? `${file.previousPath} → ` : ""}{file.path}
                          </li>
                        ))}
                      </ul>
                      <footer>
                        <button onClick={() => setRewindPreview(null)} disabled={checkpointBusy}>Cancel</button>
                        <button className="rewind-confirm" onClick={() => void confirmRewind()} disabled={checkpointBusy}>
                          {checkpointBusy ? "Rechecking…" : "Confirm rewind"}
                        </button>
                      </footer>
                    </>
                  )}
                  {checkpointError && <p className="checkpoint-error" role="alert">{checkpointError}</p>}
                </section>
              )}
            </div>
          </article>
        )}
      </section>
      <section className="composer-wrap">
        {elementReferences.length > 0 && (
          <div className="composer-context" aria-label="Attached element context">
            {elementReferences.map((reference, index) => (
              <span key={`${reference.selector}-${index}`}>
                {reference.tag} · {reference.name ?? reference.selector}
                <button
                  onClick={() => setElementReferences((current) => current.filter((_, item) => item !== index))}
                  aria-label={`Remove element reference ${reference.name ?? reference.selector}`}
                >×</button>
              </span>
            ))}
          </div>
        )}
        <fieldset className="mode-picker" disabled={runActive}>
          <legend>Interaction mode</legend>
          <div>
            {(Object.keys(modeCopy) as InteractionMode[]).map((candidate) => (
              <label className={mode === candidate ? "selected" : ""} key={candidate}>
                <input
                  type="radio"
                  name="interaction-mode"
                  value={candidate}
                  checked={mode === candidate}
                  onChange={() => setMode(candidate)}
                />
                <span>{modeCopy[candidate].label}</span>
              </label>
            ))}
          </div>
          <p aria-live="polite">{modeCopy[mode].authority}{runActive ? " · locked for active turn" : ""}</p>
        </fieldset>
        <div className="composer">
          {attachments.length > 0 && (
            <div className="context-chips" aria-label="Attached local context">
              {attachments.map((path) => (
                <span key={path}>@{path}<button onClick={() => setAttachments((current) => current.filter((item) => item !== path))} aria-label={`Remove ${path}`}>×</button></span>
              ))}
            </div>
          )}
          {suggestionMode && (
            <div className="composer-suggestions" role="listbox" aria-label={suggestionMode === "files" ? "Repository files" : "Provider commands"}>
              {suggestions.length === 0
                ? <p>No matching {suggestionMode === "files" ? "files" : "commands"}.</p>
                : suggestions.map((suggestion, index) => (
                  <button
                    className={index === suggestionIndex ? "active" : ""}
                    key={suggestion.value}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSuggestion(suggestion.value)}
                    role="option"
                    aria-selected={index === suggestionIndex}
                  >
                    <strong>{suggestionMode === "files" ? "@" : ""}{suggestion.value}</strong>
                    <small>{suggestion.detail}</small>
                  </button>
                ))}
            </div>
          )}
          <textarea
            value={draft}
            spellCheck
            onChange={(event) => setDraft(event.target.value)}
            onPaste={() => setContextError(null)}
            onKeyDown={(event) => {
              if (suggestionMode && suggestions.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                setSuggestionIndex((current) => (
                  event.key === "ArrowDown"
                    ? (current + 1) % suggestions.length
                    : (current - 1 + suggestions.length) % suggestions.length
                ));
                return;
              }
              if (suggestionMode && suggestions.length > 0 && (event.key === "Tab" || event.key === "Enter")) {
                event.preventDefault();
                selectSuggestion(suggestions[suggestionIndex].value);
                return;
              }
              if (event.key === "Escape" && suggestionMode) {
                event.preventDefault();
                setSuggestionMode(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={!historyRestored
              ? "Restoring conversation session…"
              : provider === "claude-code" && !profileId
              ? "Configure a Claude profile first…"
              : worktree
              ? `${modeCopy[mode].label} ${providerName}… Type @ for files or / for commands`
              : "Open a repository with an available worktree…"}
            aria-label={`Message ${providerName}`}
            aria-autocomplete="list"
            disabled={!worktree || (provider === "claude-code" && !profileId) || runActive || !historyRestored}
          />
          {contextError && <div className="context-error" role="alert">{contextError}</div>}
          {historyRestoreError && <div className="context-error" role="alert">{historyRestoreError}</div>}
          <footer>
            <div className="provider-selectors">
              <span className="provider-symbol">C</span>
              <label>
                <span className="sr-only">Provider</span>
                <select aria-label="Provider" value={provider} onChange={(event) => {
                  setProvider(event.target.value as ProviderId);
                  setModel("default");
                }} disabled={runActive}>
                  <option value="claude-code">Claude Code</option>
                  <option value="codex-cli" disabled={!codex?.installed || !codex?.authenticated}>Codex CLI</option>
                  {providers.filter((item) => item.id.startsWith("adapter:")).map((item) => (
                    <option value={item.id} disabled={!item.enabled} key={item.id}>
                      {item.name ?? item.id}{item.enabled ? "" : " (disabled)"}
                    </option>
                  ))}
                </select>
              </label>
              {provider === "claude-code" && profiles.length > 0 ? (
                <>
                  <label>
                    <span className="sr-only">Claude profile</span>
                    <select value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={runActive}>
                      {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label>
                    <span className="sr-only">Claude model</span>
                    <select value={model} onChange={(event) => setModel(event.target.value)} disabled={runActive}>
                      {["default", "sonnet", "opus", "haiku"].map((option) => <option value={option} key={option}>{option}</option>)}
                    </select>
                  </label>
                </>
              ) : provider === "claude-code"
                ? <button className="configure-profile" onClick={onOpenProfiles}>Configure Claude</button>
                : provider === "codex-cli" ? (
                  <>
                    <label>
                      <span className="sr-only">Codex model</span>
                      <select aria-label="Codex model" value={model} onChange={(event) => {
                        const next = event.target.value;
                        setModel(next);
                        const found = codex?.models?.find((item) => item.id === next);
                        if (found) setReasoningEffort(found.defaultReasoningEffort);
                      }} disabled={runActive}>
                        <option value="default">Default model</option>
                        {codex?.models?.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}
                      </select>
                    </label>
                    {model !== "default" && (
                      <label>
                        <span className="sr-only">Reasoning effort</span>
                        <select aria-label="Reasoning effort" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={runActive}>
                          {(selectedCodexModel?.reasoningEfforts ?? ["low", "medium", "high", "xhigh"]).map((effort) => <option value={effort} key={effort}>{effort}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                ) : <span className="context">ACP · adapter {selectedProvider?.version}</span>}
              <span className="context">{sessionId ? "Session resumable" : stateCopy[providerState]}</span>
            </div>
            {runId
              ? <button className="cancel-run" onClick={() => void cancel()} disabled={providerState === "cancelling"} aria-label={`Cancel ${providerName}`}>■</button>
              : <button className="send" onClick={() => void send()} disabled={!draft.trim() || !worktree || (provider === "claude-code" && !profileId) || runActive || !historyRestored} aria-label="Send message">↑</button>}
          </footer>
        </div>
        <p className="disclaimer">Effective authority: {modeCopy[mode].authority} · local context only · @ files · / commands · Enter to send, Shift + Enter for newline</p>
      </section>
      {changesOpen && repository && (
        <ChangesPanel
          repository={repository}
          threadId={threadId}
          files={changes}
          loading={changesLoading}
          error={changesError}
          onClose={onHideChanges}
          onRefresh={onRefreshChanges}
          canSendRevision={historyRestored && !runActive && (
            provider === "codex-cli"
              ? Boolean(codex?.installed && codex.authenticated)
              : Boolean(profileId)
          )}
          onSendRevision={(prompt) => {
            onHideChanges();
            void send(prompt);
          }}
        />
      )}
      {forkOpen && threadId && (
        <ForkConversationDialog
          sourceThreadId={threadId}
          sourceProvider={provider}
          profiles={profiles}
          providers={providers}
          onClose={() => setForkOpen(false)}
          onCreated={(id) => {
            setForkOpen(false);
            onConversationAvailable?.(id);
          }}
        />
      )}
      {previewOpen && repository && (
        <PreviewPanel
          repository={repository}
          onClose={() => setPreviewOpen(false)}
          onReference={(reference) => setElementReferences((current) => [...current.slice(-2), reference])}
        />
      )}
      {filesOpen && repository && (
        <FileBrowserPanel
          repository={repository}
          attached={attachments}
          maxAttachments={capabilities?.attachments.maxCount ?? 8}
          onAttach={(path) => {
            if (!attachments.includes(path) && attachments.length < (capabilities?.attachments.maxCount ?? 8)) {
              setAttachments((current) => [...current, path]);
              setContextError(null);
            }
          }}
          onClose={onHideFiles}
        />
      )}
    </main>
  );
}

async function loadConversationList(repository: RepositoryMetadata): Promise<ConversationSummary[]> {
  const response = await fetch("/api/state/load", { method: "POST" });
  if (!response.ok) throw new Error("Conversation history could not be loaded.");
  const projection = await response.json() as { threads: ConversationSummary[] };
  return projection.threads
    .filter((thread) => thread.projectId === repository.projectId)
    .sort((left, right) => {
      if (Boolean(left.pinnedAt) !== Boolean(right.pinnedAt)) return left.pinnedAt ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    });
}

function PaneConversation({
  repository,
  conversation,
  pane,
  active,
  profiles,
  onOpenRepository,
  onOpenProfiles,
  onOpenBeside,
  onClosePane,
  onConversationAvailable,
  showChangesSignal,
  showFilesSignal,
  onManageWorktrees,
}: {
  repository: RepositoryMetadata | null;
  conversation: ConversationSummary | null;
  pane: "primary" | "secondary";
  active: boolean;
  profiles: ClaudeProfile[];
  onOpenRepository: () => void;
  onOpenProfiles: () => void;
  onOpenBeside: () => void;
  onClosePane?: () => void;
  onConversationAvailable?: (id: string) => void;
  showChangesSignal: number;
  showFilesSignal: number;
  onManageWorktrees: (path?: string) => void;
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const refreshChanges = async () => {
    if (!repository) {
      setChanges([]);
      return;
    }
    setChangesLoading(true);
    setChangesError(null);
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: repository.root, worktree: repository.selectedWorktree }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch (cause) {
      setChangesError(cause instanceof Error ? cause.message : "Changed files could not be inspected.");
    } finally {
      setChangesLoading(false);
    }
  };
  useEffect(() => { void refreshChanges(); }, [repository?.root, repository?.selectedWorktree]);
  useEffect(() => { if (showChangesSignal > 0) { setChangesOpen(true); void refreshChanges(); } }, [showChangesSignal]);
  useEffect(() => { if (showFilesSignal > 0) setFilesOpen(true); }, [showFilesSignal]);
  return (
    <Conversation
      repository={repository}
      conversation={conversation}
      pane={pane}
      active={active}
      onOpenBeside={onOpenBeside}
      onClosePane={onClosePane}
      onConversationAvailable={onConversationAvailable}
      onOpenRepository={onOpenRepository}
      onManageWorktrees={() => onManageWorktrees()}
      changes={changes}
      changesLoading={changesLoading}
      changesError={changesError}
      changesOpen={changesOpen}
      onShowChanges={() => { setChangesOpen(true); void refreshChanges(); }}
      onHideChanges={() => setChangesOpen(false)}
      onRefreshChanges={refreshChanges}
      filesOpen={filesOpen}
      onBrowseFiles={() => setFilesOpen(true)}
      onHideFiles={() => setFilesOpen(false)}
      profiles={profiles}
      onOpenProfiles={onOpenProfiles}
    />
  );
}

function CodeWorkbench({
  repository,
  onOpenRepository,
  profiles,
  onOpenProfiles,
  onSearch,
  onOpenPalette,
  onSelectWorktree,
  onManageWorktrees,
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: () => void;
  onSearch: () => void;
  onOpenPalette: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [primaryChangesSignal, setPrimaryChangesSignal] = useState(0);
  const [primaryFilesSignal, setPrimaryFilesSignal] = useState(0);
  const [secondaryChangesSignal, setSecondaryChangesSignal] = useState(0);
  const [secondaryFilesSignal, setSecondaryFilesSignal] = useState(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [showingArchived, setShowingArchived] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [incompleteDeletionIds, setIncompleteDeletionIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryNewKey, setPrimaryNewKey] = useState(0);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitPercent, setSplitPercent] = useState(50);
  const [restoreState, setRestoreState] = useState<"idle" | "loading" | "ready" | "failed">(
    () => repository ? "loading" : "idle",
  );
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const splitReference = useRef<HTMLDivElement>(null);
  const restoredProjectReference = useRef<string | null>(null);
  const primarySelectionReference = useRef("new:0");
  const secondaryIdReference = useRef<string | null>(null);
  const primaryPaneReference = useRef<HTMLDivElement>(null);
  const secondaryPaneReference = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!repository) return;
    let active = true;
    restoredProjectReference.current = null;
    secondaryIdReference.current = null;
    setConversations([]);
    setPrimaryId(null);
    primarySelectionReference.current = "new:0";
    setSecondaryId(null);
    setRestoreState("loading");
    const restore = async () => {
      const available = await loadConversationList(repository);
      if (!active) return;
      setConversations(available);
      const lifecycleResponse = await fetch("/api/state/load", { method: "POST" });
      const lifecycleProjection = await lifecycleResponse.json() as {
        conversationDeletions?: Array<{ threadId: string; status: string }>;
      };
      setIncompleteDeletionIds(
        (lifecycleProjection.conversationDeletions ?? [])
          .filter((deletion) => deletion.status !== "completed")
          .map((deletion) => deletion.threadId),
      );
      const parameters = new URLSearchParams(window.location.search);
      const urlMatchesProject = parameters.get("project") === repository.projectId;
      const stored = window.localStorage.getItem(`aldunis.split.${repository.projectId}`);
      let saved: { primaryId?: string | null; secondaryId?: string | null; splitPercent?: number } = {};
      try { saved = stored ? JSON.parse(stored) as typeof saved : {}; } catch { saved = {}; }
      const restored = normalizeSplitWorkspaceState({
        primaryId: (urlMatchesProject ? parameters.get("conversation") : null) ?? saved.primaryId,
        secondaryId: (urlMatchesProject ? parameters.get("beside") : null) ?? saved.secondaryId,
        splitPercent: saved.splitPercent,
      }, available[0]?.id ?? null);
      setPrimaryId(restored.primaryId);
      primarySelectionReference.current = restored.primaryId ?? `new:${primaryNewKey}`;
      setSecondaryId(restored.secondaryId);
      secondaryIdReference.current = restored.secondaryId;
      setSplitPercent(restored.splitPercent);
      restoredProjectReference.current = repository.projectId;
      setRestoreState("ready");
    };
    void restore().catch(() => {
      if (!active) return;
      restoredProjectReference.current = null;
      setRestoreState("failed");
    });
    return () => { active = false; };
  }, [repository?.projectId, restoreAttempt]);
  useEffect(() => {
    if (!repository || restoredProjectReference.current !== repository.projectId) return;
    window.localStorage.setItem(`aldunis.split.${repository.projectId}`, JSON.stringify({
      primaryId,
      secondaryId,
      splitPercent,
    }));
    const parameters = new URLSearchParams(window.location.search);
    parameters.set("project", repository.projectId);
    if (primaryId) parameters.set("conversation", primaryId); else parameters.delete("conversation");
    if (secondaryId) parameters.set("beside", secondaryId); else parameters.delete("beside");
    window.history.replaceState(null, "", `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`);
  }, [primaryId, repository?.projectId, secondaryId, splitPercent]);
  useEffect(() => {
    const moveFocus = (event: KeyboardEvent) => {
      if (!secondaryId || !event.altKey || !event.shiftKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActivePane("primary");
        primaryPaneReference.current?.focus();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActivePane("secondary");
        secondaryPaneReference.current?.focus();
      }
    };
    window.addEventListener("keydown", moveFocus);
    return () => window.removeEventListener("keydown", moveFocus);
  }, [secondaryId]);
  const primary = conversations.find((conversation) => conversation.id === primaryId) ?? null;
  const secondary = conversations.find((conversation) => conversation.id === secondaryId) ?? null;
  const primarySelectionKey = primaryId ?? `new:${primaryNewKey}`;
  const activeConversation = activePane === "secondary" ? secondary : primary;
  const listedConversations = conversations.filter(
    (conversation) => showingArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt,
  );
  const postLifecycle = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Conversation lifecycle action failed.");
    if (repository) setConversations(await loadConversationList(repository));
    return result;
  };
  const manageConversation = async (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => {
    setLifecycleError(null);
    try {
      if (action === "rename") {
        const title = window.prompt("Rename conversation:", conversation.title);
        if (title === null) return;
        await postLifecycle("/api/state/conversations/rename", { threadId: conversation.id, title });
      } else if (action === "pin") {
        await postLifecycle("/api/state/conversations/pin", {
          threadId: conversation.id,
          pinned: !conversation.pinnedAt,
        });
      } else if (action === "archive" || action === "restore") {
        await postLifecycle(`/api/state/conversations/${action}`, { threadId: conversation.id });
        if (action === "archive") {
          if (primaryId === conversation.id) setPrimaryId(null);
          if (secondaryId === conversation.id) setSecondaryId(null);
        }
      } else {
        const previewResponse = await fetch("/api/state/conversations/delete/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: conversation.id }),
        });
        const preview = await previewResponse.json() as {
          affectedRecords?: Record<string, number>;
          excluded?: string[];
          error?: string;
        };
        if (!previewResponse.ok) throw new Error(preview.error ?? "Deletion preview failed.");
        const affected = Object.entries(preview.affectedRecords ?? {})
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${count} ${name}`)
          .join(", ");
        const confirmed = window.confirm(
          `Delete "${conversation.title}"?\n\nLocal data removed: ${affected}.\n\nNot removed: ${(preview.excluded ?? []).join(", ")}.\n\nThis cannot be undone.`,
        );
        if (!confirmed) return;
        await postLifecycle("/api/state/conversations/delete", {
          threadId: conversation.id,
          confirm: true,
        });
        if (primaryId === conversation.id) setPrimaryId(null);
        if (secondaryId === conversation.id) setSecondaryId(null);
      }
    } catch (error) {
      setLifecycleError(error instanceof Error ? error.message : "Conversation lifecycle action failed.");
    }
  };
  const refresh = async () => {
    if (!repository) {
      setChanges([]);
      return;
    }
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: activeConversation?.worktree ?? repository.selectedWorktree,
        }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch {
      setChanges([]);
    }
  };
  useEffect(() => { void refresh(); }, [activeConversation?.worktree, repository]);
  const repositoryFor = (conversation: ConversationSummary | null) => repository
    ? { ...repository, selectedWorktree: conversation?.worktree ?? repository.selectedWorktree }
    : null;
  const openBeside = (id?: string) => {
    const candidate = id ?? conversations.find((conversation) => conversation.id !== primaryId)?.id ?? `new:${crypto.randomUUID()}`;
    secondaryIdReference.current = candidate;
    setSecondaryId(candidate);
    setActivePane("secondary");
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = splitReference.current;
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      setSplitPercent(clampSplitPercent(((pointer.clientX - bounds.left) / bounds.width) * 100));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  return (
    <>
      <CodeSidebar
        repository={repository}
        onOpenRepository={onOpenRepository}
        changes={changes}
        onShowChanges={() => {
          void refresh();
          if (activePane === "secondary") setSecondaryChangesSignal((value) => value + 1);
          else setPrimaryChangesSignal((value) => value + 1);
        }}
        onBrowseFiles={() => (
          activePane === "secondary"
            ? setSecondaryFilesSignal((value) => value + 1)
            : setPrimaryFilesSignal((value) => value + 1)
        )}
        conversations={listedConversations}
        primaryConversationId={primaryId}
        secondaryConversationId={secondaryId}
        onOpenConversation={(id) => {
          primarySelectionReference.current = id;
          setPrimaryId(id);
          if (secondaryId === id) {
            secondaryIdReference.current = null;
            setSecondaryId(null);
          }
          setActivePane("primary");
        }}
        onOpenBeside={openBeside}
        onNewConversation={() => {
          primarySelectionReference.current = `new:${primaryNewKey + 1}`;
          setPrimaryId(null);
          setPrimaryNewKey((value) => value + 1);
          if (secondaryId?.startsWith("new:")) {
            secondaryIdReference.current = null;
            setSecondaryId(null);
          }
          setActivePane("primary");
        }}
        onSearch={onSearch}
        onOpenPalette={onOpenPalette}
        onSelectWorktree={onSelectWorktree}
        onManageWorktrees={onManageWorktrees}
        showingArchived={showingArchived}
        onToggleArchived={() => setShowingArchived((value) => !value)}
        onConversationAction={(conversation, action) => { void manageConversation(conversation, action); }}
      />
      <section className={`conversation-workspace active-${activePane}`} aria-label="Conversation workspace">
        {lifecycleError && <div className="workspace-state error" role="alert">{lifecycleError}</div>}
        {incompleteDeletionIds.map((threadId) => (
          <div className="workspace-state error" role="alert" key={threadId}>
            <span>Conversation deletion {threadId} is incomplete.</span>
            <button onClick={() => {
              void postLifecycle("/api/state/conversations/delete", { threadId, confirm: true })
                .then(() => setIncompleteDeletionIds((ids) => ids.filter((id) => id !== threadId)))
                .catch((error: unknown) => setLifecycleError(
                  error instanceof Error ? error.message : "Conversation deletion retry failed.",
                ));
            }}>Retry deletion</button>
          </div>
        ))}
        {restoreState === "loading" && <div className="workspace-state" role="status">Restoring local conversations…</div>}
        {restoreState === "failed" && (
          <div className="workspace-state failed" role="alert">
            <span>Local conversation history could not be loaded.</span>
            <button onClick={() => setRestoreAttempt((value) => value + 1)}>Retry</button>
          </div>
        )}
        {(restoreState === "ready" || !repository) && <>
        {secondaryId && (
          <nav className="pane-switcher" aria-label="Visible conversation pane">
            <button className={activePane === "primary" ? "active" : ""} onClick={() => setActivePane("primary")}>
              Primary · {primary?.title ?? (primaryId ? "Replace conversation" : "New conversation")}
            </button>
            <button className={activePane === "secondary" ? "active" : ""} onClick={() => setActivePane("secondary")}>
              Secondary · {secondary?.title ?? (secondaryId.startsWith("new:") ? "New conversation" : "Replace conversation")}
            </button>
          </nav>
        )}
        <div
          className={`split-workspace ${secondaryId ? "split" : ""}`}
          ref={splitReference}
          style={secondaryId ? { gridTemplateColumns: `${splitPercent}% 6px minmax(0, 1fr)` } : undefined}
        >
          <div className="conversation-pane primary-pane" tabIndex={-1} ref={primaryPaneReference} onFocusCapture={() => setActivePane("primary")}>
            {primaryId && !primary
              ? <MissingConversation pane="primary" conversations={conversations.filter((item) => item.id !== secondaryId)} onReplace={(id) => {
                  primarySelectionReference.current = id ?? `new:${primaryNewKey + 1}`;
                  setPrimaryId(id);
                }} />
              : <PaneConversation key={primaryId ?? `new-primary:${primaryNewKey}`} repository={repositoryFor(primary)} conversation={primary} pane="primary" active={activePane === "primary"} profiles={profiles} onOpenRepository={onOpenRepository} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} showChangesSignal={primaryChangesSignal} showFilesSignal={primaryFilesSignal} onConversationAvailable={(id) => {
                  if (primarySelectionReference.current === primarySelectionKey) {
                    primarySelectionReference.current = id;
                    setPrimaryId(id);
                  }
                  if (repository) void loadConversationList(repository).then(setConversations).catch(() => {});
                }} />}
          </div>
          {secondaryId && (
            <>
              <div
                className="split-divider"
                role="separator"
                aria-label="Resize conversation panes"
                aria-orientation="vertical"
                aria-valuemin={30}
                aria-valuemax={70}
                aria-valuenow={Math.round(splitPercent)}
                tabIndex={0}
                onPointerDown={resize}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") setSplitPercent((value) => Math.max(30, value - 5));
                  if (event.key === "ArrowRight") setSplitPercent((value) => Math.min(70, value + 5));
                }}
              />
              <div className="conversation-pane secondary-pane" tabIndex={-1} ref={secondaryPaneReference} onFocusCapture={() => setActivePane("secondary")}>
                {!secondary && !secondaryId.startsWith("new:")
                  ? <MissingConversation pane="secondary" conversations={conversations.filter((item) => item.id !== primaryId)} onReplace={setSecondaryId} onClose={() => setSecondaryId(null)} />
                  : <PaneConversation key={secondaryId} repository={repositoryFor(secondary)} conversation={secondary} pane="secondary" active={activePane === "secondary"} profiles={profiles} onOpenRepository={onOpenRepository} onOpenProfiles={onOpenProfiles} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} onClosePane={() => {
                      secondaryIdReference.current = null;
                      setSecondaryId(null);
                      setActivePane("primary");
                    }} showChangesSignal={secondaryChangesSignal} showFilesSignal={secondaryFilesSignal} onConversationAvailable={(id) => {
                      if (secondaryIdReference.current !== secondaryId) return;
                      secondaryIdReference.current = id;
                      setSecondaryId(id);
                      if (repository) void loadConversationList(repository).then(setConversations).catch(() => {});
                    }} />}
              </div>
            </>
          )}
        </div>
        </>}
      </section>
    </>
  );
}

function MissingConversation({
  pane,
  conversations,
  onReplace,
  onClose,
}: {
  pane: "primary" | "secondary";
  conversations: ConversationSummary[];
  onReplace: (id: string | null) => void;
  onClose?: () => void;
}) {
  return (
    <section className="missing-conversation" role="region" aria-label={`${pane} conversation unavailable`}>
      <span>{pane} pane</span>
      <h2>Conversation unavailable</h2>
      <p>It may have been deleted, archived, or created by an incompatible local state version. Choose a replacement; no provider session was ended.</p>
      <label>
        Replacement conversation
        <select defaultValue="" onChange={(event) => { if (event.target.value) onReplace(event.target.value); }}>
          <option value="" disabled>Choose a conversation…</option>
          {conversations.map((conversation) => <option value={conversation.id} key={conversation.id}>{conversation.title}</option>)}
        </select>
      </label>
      {onClose && <button onClick={onClose}>Close pane</button>}
    </section>
  );
}

function parseEnvironment(
  input: string,
  sensitive: boolean,
  existing: ClaudeProfile["environment"],
): ClaudeProfile["environment"] {
  return input.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    const name = (separator === -1 ? line : line.slice(0, separator)).trim();
    const value = separator === -1 ? "" : line.slice(separator + 1);
    const previous = existing.find((variable) => variable.name === name && variable.sensitive === sensitive);
    return sensitive
      ? { name, sensitive: true, value, valueSet: previous?.valueSet === true }
      : { name, sensitive: false, value };
  });
}

function ProfileSettingsDialog({
  open,
  profiles,
  onClose,
  onChanged,
}: {
  open: boolean;
  profiles: ClaudeProfile[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const [name, setName] = useState("");
  const [binaryPath, setBinaryPath] = useState("claude");
  const [homePath, setHomePath] = useState("");
  const [environment, setEnvironment] = useState("");
  const [sensitiveEnvironment, setSensitiveEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef, onKeyDown } = useDialogFocus(open, onClose, !busy);
  const edit = (profile: ClaudeProfile | null) => {
    setSelectedId(profile?.id ?? null);
    setName(profile?.name ?? "");
    setBinaryPath(profile?.binaryPath ?? "claude");
    setHomePath(profile?.homePath ?? "");
    setEnvironment(profile?.environment.filter((item) => !item.sensitive).map((item) => `${item.name}=${item.value ?? ""}`).join("\n") ?? "");
    setSensitiveEnvironment(profile?.environment.filter((item) => item.sensitive).map((item) => `${item.name}=`).join("\n") ?? "");
    setError(null);
  };
  useEffect(() => {
    if (open && selectedId && !profiles.some((profile) => profile.id === selectedId)) edit(null);
  }, [open, profiles, selectedId]);
  if (!open) return null;
  const request = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Claude profiles could not be updated.");
      await onChanged();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude profiles could not be updated.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await request("/api/provider/profiles/save", {
      ...(selected ? { id: selected.id } : {}),
      name,
      binaryPath,
      homePath,
      environment: [
        ...parseEnvironment(environment, false, selected?.environment ?? []),
        ...parseEnvironment(sensitiveEnvironment, true, selected?.environment ?? []),
      ],
    }) as ClaudeProfile | null;
    if (saved?.id) edit(saved);
  };
  const refresh = async (profile: ClaudeProfile, kind: ProfileProbeKind) => {
    await request("/api/provider/profiles/refresh", { id: profile.id, kind });
  };
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
      onKeyDown={onKeyDown}
    >
      <section ref={dialogRef} className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title" tabIndex={-1}>
        <header>
          <div><p className="eyebrow">Local provider settings</p><h2 id="profile-dialog-title">Claude profiles</h2></div>
          <CloseButton onClick={onClose} label="Close profile settings" />
        </header>
        <div className="profile-dialog-body">
          <nav aria-label="Claude profiles">
            {profiles.map((profile) => (
              <button className={selectedId === profile.id ? "active" : ""} onClick={() => edit(profile)} key={profile.id}>
                <strong>{profile.name}</strong><small>{profile.homePath || "Default Claude home"}</small>
              </button>
            ))}
            <button className={!selectedId ? "active add-profile" : "add-profile"} onClick={() => edit(null)}>+ New profile</button>
          </nav>
          <form onSubmit={save}>
            <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} required /></label>
            <div className="profile-fields">
              <label>Binary path<input value={binaryPath} onChange={(event) => setBinaryPath(event.target.value)} placeholder="claude" /></label>
              <label>Claude config path<input value={homePath} onChange={(event) => setHomePath(event.target.value)} placeholder="~/.claude-personal" /></label>
            </div>
            <label>Environment variables<textarea value={environment} onChange={(event) => setEnvironment(event.target.value)} placeholder={"ANTHROPIC_BASE_URL=https://…"} /></label>
            <label>Sensitive environment values<textarea value={sensitiveEnvironment} onChange={(event) => setSensitiveEnvironment(event.target.value)} placeholder={"ANTHROPIC_AUTH_TOKEN=write-only value"} /></label>
            <p className="secret-note">Sensitive values are write-only. Existing values appear empty and remain stored unless their line is removed.</p>
            {selected && (
              <div className="probe-grid">
                {(["availability", "version", "authentication", "models"] as ProfileProbeKind[]).map((kind) => (
                  <button type="button" onClick={() => void refresh(selected, kind)} disabled={busy} key={kind}>
                    <span className={`probe-state ${selected.probes[kind].state}`} />
                    <strong>{kind}</strong>
                    <small>{selected.probes[kind].detail ?? "Not checked"}</small>
                  </button>
                ))}
              </div>
            )}
            {error && <p className="repository-error" role="alert">{error}</p>}
            <footer>
              {selected && <button type="button" className="danger" onClick={async () => {
                if (await request("/api/provider/profiles/delete", { id: selected.id })) edit(null);
              }} disabled={busy}>Delete profile</button>}
              <span />
              <button type="button" onClick={onClose}>Cancel</button>
              <button className="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save profile"}</button>
            </footer>
          </form>
        </div>
      </section>
    </div>
  );
}

function PreferencesDialog({
  open,
  preferences,
  recovered,
  onClose,
  onSave,
}: {
  open: boolean;
  preferences: Preferences;
  recovered: boolean;
  onClose: () => void;
  onSave: (preferences: Preferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState(preferences);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setDraft(preferences); }, [open, preferences]);
  if (!open) return null;
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <OverlayDialog title="Appearance & keyboard" onClose={onClose}>
      {recovered && <p className="recovery-note" role="status">Invalid preference data was recovered to safe defaults.</p>}
      <form className="preferences-form" onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void onSave(draft).finally(() => setBusy(false));
      }}>
        <label>Theme<select value={draft.theme} onChange={(event) => update("theme", event.target.value as Preferences["theme"])}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label>Density<select value={draft.density} onChange={(event) => update("density", event.target.value as Preferences["density"])}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        <label>Zoom<select value={draft.zoom} onChange={(event) => update("zoom", Number(event.target.value) as Preferences["zoom"])}>{[0.8, 0.9, 1, 1.1, 1.2].map((value) => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}</select></label>
        <label>Reduced motion<select value={draft.reducedMotion} onChange={(event) => update("reducedMotion", event.target.value as Preferences["reducedMotion"])}><option value="system">Follow system</option><option value="reduce">Reduce</option><option value="no-preference">Allow motion</option></select></label>
        <label>Command palette<select value={draft.commandPaletteShortcut} onChange={(event) => update("commandPaletteShortcut", event.target.value as Preferences["commandPaletteShortcut"])}><option value="mod+k">⌘/Ctrl K</option><option value="mod+shift+p">⌘/Ctrl Shift P</option></select></label>
        <label>Managed worktree limit<select value={draft.managedWorktreeLimit ?? "unlimited"} onChange={(event) => update("managedWorktreeLimit", event.target.value === "unlimited" ? null : Number(event.target.value))}><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value="unlimited">Unlimited</option></select></label>
        <p className="preference-note">The limit applies only to Aldunis-created worktrees. Reaching it blocks creation until an eligible checkout is explicitly removed or the limit is raised.</p>
        <p className="search-scope">Shortcuts are exclusive: selecting one command-palette binding releases the other, preventing conflicts.</p>
        <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save preferences"}</button></footer>
      </form>
    </OverlayDialog>
  );
}

function AdapterSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [adapters, setAdapters] = useState<InstalledProviderAdapter[]>([]);
  const [administrationAvailable, setAdministrationAvailable] = useState(true);
  const [source, setSource] = useState("");
  const [digest, setDigest] = useState("");
  const [manifestText, setManifestText] = useState("");
  const [candidate, setCandidate] = useState<InstalledProviderAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (route: string, body: unknown = {}) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Adapter operation failed.");
    return result;
  };
  const load = async () => {
    const result = await request("/api/provider/adapters/list") as unknown as {
      adapters: InstalledProviderAdapter[];
      administrationAvailable: boolean;
    };
    setAdapters(result.adapters);
    setAdministrationAvailable(result.administrationAvailable);
  };
  useEffect(() => {
    if (!open) return;
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Adapters could not be loaded."));
  }, [open]);
  if (!open) return null;

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      const manifest = JSON.parse(manifestText) as unknown;
      const result = await request("/api/provider/adapters/inspect", { source, digest, manifest });
      setCandidate(result as unknown as InstalledProviderAdapter);
    } catch (cause) {
      setCandidate(null);
      setError(cause instanceof Error ? cause.message : "Adapter inspection failed.");
    } finally {
      setBusy(false);
    }
  };
  const act = async (route: string, body: unknown = { approved: true }) => {
    setBusy(true);
    setError(null);
    try {
      await request(route, body);
      setCandidate(null);
      await load();
      window.dispatchEvent(new Event("aldunis:adapters-changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Adapter operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const existing = candidate
    ? adapters.find((adapter) => adapter.manifest.id === candidate.manifest.id)
    : undefined;

  return (
    <OverlayDialog title="Declarative provider adapters" onClose={onClose}>
      <div className="adapter-settings">
        <p className="adapter-policy">
          You decide which source and publisher to trust. Aldunis verifies the reviewed digest,
          rejects executable package code, and keeps authority inside its ACP runtime and permission broker.
        </p>
        {!administrationAvailable && (
          <p className="context-error" role="status">Remote clients can inspect adapter readiness but cannot administer host adapters.</p>
        )}
        <section className="adapter-list" aria-label="Installed provider adapters">
          {adapters.length === 0 && <p>No declarative adapters installed.</p>}
          {adapters.map((adapter) => (
            <article key={adapter.manifest.id}>
              <header>
                <div>
                  <strong>{adapter.manifest.presentation.name}</strong>
                  <small>{adapter.manifest.id}@{adapter.manifest.version} · {adapter.enabled ? "enabled" : "disabled"}</small>
                </div>
                <code>{adapter.digest}</code>
              </header>
              <p>{adapter.manifest.presentation.description}</p>
              <footer>
                <button disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/${adapter.enabled ? "disable" : "enable"}`)}>
                  {adapter.enabled ? "Disable" : "Enable"}
                </button>
                <button disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/rollback`)}>Rollback</button>
                <button className="danger" disabled={busy || !administrationAvailable} onClick={() => void act(`/api/provider/adapters/${adapter.manifest.id}/uninstall`)}>Uninstall</button>
              </footer>
            </article>
          ))}
        </section>
        {administrationAvailable && (
          <section className="adapter-import">
            <h3>Inspect a manifest</h3>
            <label>Source URL<input value={source} onChange={(event) => { setSource(event.target.value); setCandidate(null); }} placeholder="file:///… or https://…" /></label>
            <label>Expected SHA-256 digest<input value={digest} onChange={(event) => { setDigest(event.target.value); setCandidate(null); }} placeholder="sha256:…" /></label>
            <label>Manifest JSON<textarea value={manifestText} onChange={(event) => { setManifestText(event.target.value); setCandidate(null); }} rows={10} spellCheck={false} /></label>
            <button disabled={busy || !source || !digest || !manifestText} onClick={() => void inspect()}>
              {busy ? "Checking…" : "Inspect compatibility"}
            </button>
          </section>
        )}
        {candidate && (
          <section className="adapter-review" aria-label="Adapter approval review">
            <h3>{existing ? "Review update" : "Review installation"}</h3>
            <dl>
              <div><dt>Source</dt><dd>{candidate.source}</dd></div>
              <div><dt>Publisher claim</dt><dd>{candidate.manifest.publisher.name} · not endorsed by Aldunis</dd></div>
              <div><dt>Integrity</dt><dd>{candidate.digest}</dd></div>
              <div><dt>Compatibility</dt><dd>Aldunis {candidate.manifest.aldunis.minimumVersion}–{candidate.manifest.aldunis.maximumVersion}; ACP {candidate.manifest.protocol.minimumVersion}</dd></div>
              <div><dt>Executable</dt><dd>{candidate.manifest.executable.names.join(", ")}</dd></div>
              <div><dt>Fixed arguments</dt><dd>{candidate.manifest.executable.arguments.join(" ") || "None"}</dd></div>
              <div><dt>Environment names</dt><dd>{candidate.manifest.environment.map((item) => `${item.name}${item.required ? " (required)" : ""}`).join(", ") || "None"}</dd></div>
              <div><dt>Declared capabilities</dt><dd>{Object.entries(candidate.manifest.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "None"}</dd></div>
              <div><dt>Working directory</dt><dd>Canonical conversation worktree</dd></div>
              <div><dt>Provider process authority</dt><dd>Runs as your local OS user. Aldunis bounds cwd and environment, but does not sandbox native filesystem, process, or network access.</dd></div>
              <div><dt>Declared capabilities</dt><dd>Cannot grant Aldunis tool authority; ACP mutations still require allow-once approval</dd></div>
            </dl>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void act(
                existing ? "/api/provider/adapters/update" : "/api/provider/adapters/install",
                { source, digest, manifest: candidate.manifest, approved: true },
              )}
            >
              Approve and {existing ? "update" : "install"}
            </button>
          </section>
        )}
        {error && <p className="context-error" role="alert">{error}</p>}
      </div>
    </OverlayDialog>
  );
}

function CommandPalette({
  open,
  onClose,
  onOpenRepository,
  onSearch,
  onPreferences,
  onProviderSettings,
  onAdapterSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenRepository: () => void;
  onSearch: () => void;
  onPreferences: () => void;
  onProviderSettings: () => void;
  onAdapterSettings: () => void;
}) {
  const [query, setQuery] = useState("");
  if (!open) return null;
  const actions = [
    { label: "Open repository", detail: "Choose an explicit local repository root", run: onOpenRepository, available: true },
    { label: "Search conversations", detail: "Search bounded local thread metadata", run: onSearch, available: true },
    { label: "Appearance & keyboard", detail: "Theme, density, zoom, motion, and keybindings", run: onPreferences, available: true },
    { label: "Provider settings", detail: "Configure local Claude profiles", run: onProviderSettings, available: true },
    { label: "Provider adapters", detail: "Inspect and administer declarative ACP adapters", run: onAdapterSettings, available: true },
  ].filter((action) => action.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return (
    <OverlayDialog title="Command palette" onClose={onClose}>
      <label className="quick-search"><Icon name="search" /><input data-dialog-initial-focus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search available actions" /></label>
      <div className="quick-results">{actions.map((action) => <button key={action.label} onClick={() => { onClose(); action.run(); }}><strong>{action.label}</strong><small>{action.detail}</small></button>)}</div>
    </OverlayDialog>
  );
}

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
