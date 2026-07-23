import { FormEvent, StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Product = "code" | "sekai" | "chisei" | "tenkai";
type WorktreeState = "available" | "detached" | "missing" | "inaccessible";
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
  }>;
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
  patch: string | null;
  message: string | null;
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
type ProviderState = "idle" | "starting" | "streaming" | "cancelling" | "completed" | "cancelled" | "failed";
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

const nav: Array<{ id: Product; label: string; icon: IconName; detail: string }> = [
  { id: "code", label: "Code", icon: "code", detail: "Local workbench" },
  { id: "sekai", label: "Sekai", icon: "spark", detail: "Knowledge & evidence" },
  { id: "chisei", label: "Chisei", icon: "shield", detail: "Policy & routing" },
  { id: "tenkai", label: "Tenkai", icon: "rocket", detail: "Delivery & recovery" },
];

const sessions = [
  { title: "Shape Claude permission flow", branch: "codex/12-permissions", age: "4m", active: true },
  { title: "Inspect provider event stream", branch: "main", age: "42m" },
  { title: "Refine worktree discovery", branch: "codex/8-worktrees", age: "2h" },
];

function ProductRail({
  product,
  onChange,
  onSettings,
}: {
  product: Product;
  onChange: (product: Product) => void;
  onSettings: () => void;
}) {
  return (
    <aside className="product-rail" aria-label="Products">
      <button className="aldunis-mark" aria-label="Aldunis home">A</button>
      <div className="rail-products">
        {nav.map((item) => (
          <button
            className={product === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
            aria-label={item.label}
            aria-current={product === item.id ? "page" : undefined}
            key={item.id}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <button className="rail-settings" aria-label="Claude profile settings" onClick={onSettings}><Icon name="settings" /></button>
    </aside>
  );
}

function CodeSidebar({
  repository,
  onOpenRepository,
  changes,
  onShowChanges,
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  changes: ChangedFile[];
  onShowChanges: () => void;
}) {
  return (
    <aside className="context-sidebar">
      <header>
        <div>
          <strong>ALDUNIS CODE</strong>
          <span>Local workbench</span>
        </div>
        <button aria-label="New conversation"><Icon name="plus" /></button>
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
        <button><Icon name="search" /> Search <kbd>⌘ K</kbd></button>
        <button><Icon name="branch" /> Worktrees <span className="count">{repository?.worktrees.length ?? "—"}</span></button>
        <button onClick={onShowChanges} disabled={!repository}>
          <Icon name="diff" /> Changed files <span className="change-count">{repository ? changes.length : "—"}</span>
        </button>
      </div>
      {repository && (
        <div className="worktree-list" aria-label="Repository worktrees">
          {repository.worktrees.map((worktree) => (
            <div key={worktree.path}>
              <span className={`worktree-state ${worktree.state}`} aria-hidden="true" />
              <span>
                <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                <small>{worktree.path}</small>
              </span>
              <em>{worktree.state}</em>
            </div>
          ))}
        </div>
      )}
      <div className="section-label"><span>Conversations</span><button>•••</button></div>
      <div className="session-list">
        {sessions.map((session) => (
          <button className={session.active ? "active" : ""} key={session.title}>
            <span className="session-icon"><Icon name="message" /></span>
            <span className="session-copy">
              <strong>{session.title}</strong>
              <small>{session.branch} · {session.age}</small>
            </span>
            {session.active && <i />}
          </button>
        ))}
      </div>
      <footer><span className="provider-dot" /><span><strong>Claude Code</strong><small>Not connected</small></span><button>Connect</button></footer>
    </aside>
  );
}

function ChangesPanel({
  repository,
  files,
  loading,
  error,
  onClose,
  onRefresh,
}: {
  repository: RepositoryMetadata;
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
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
  return (
    <section
      className="changes-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Changes for active conversation"
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <header>
        <div><span className="eyebrow">Active conversation</span><h2>Review changes</h2></div>
        <div><button onClick={onRefresh}>Refresh</button><button autoFocus onClick={onClose} aria-label="Close changed files">×</button></div>
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
          {diff?.patch && <pre>{diff.patch.split("\n").map((line, index) => (
            <span className={line.startsWith("+") && !line.startsWith("+++") ? "addition" : line.startsWith("-") && !line.startsWith("---") ? "deletion" : "context"} key={index}>{line || " "}</span>
          ))}</pre>}
        </div>
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
  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(path);
  };
  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onClose();
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
    >
      <section className="repository-dialog" role="dialog" aria-modal="true" aria-labelledby="repository-dialog-title">
        <p className="eyebrow">Local access</p>
        <h2 id="repository-dialog-title">Open a repository</h2>
        <p>Enter an absolute path. The local host canonicalizes it and returns only repository and worktree metadata.</p>
        <form onSubmit={submit}>
          <label htmlFor="repository-path">Repository path</label>
          <input
            id="repository-path"
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/Projects/repository"
            disabled={busy}
          />
          {error && <div className="repository-error" role="alert">{error}</div>}
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

function Conversation({
  repository,
  onOpenRepository,
  changes,
  changesLoading,
  changesError,
  changesOpen,
  onShowChanges,
  onHideChanges,
  onRefreshChanges,
  profiles,
  onOpenProfiles,
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  changes: ChangedFile[];
  changesLoading: boolean;
  changesError: string | null;
  changesOpen: boolean;
  onShowChanges: () => void;
  onHideChanges: () => void;
  onRefreshChanges: () => void;
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
  const [conversationId] = useState(() => crypto.randomUUID());
  const [threadId, setThreadId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Array<{ value: string; detail: string }>>([]);
  const [suggestionMode, setSuggestionMode] = useState<"files" | "commands" | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [contextError, setContextError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(null);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("default");
  useEffect(() => {
    if (!profiles.some((profile) => profile.id === profileId)) {
      setProfileId(profiles[0]?.id ?? "");
    }
  }, [profiles, profileId]);
  useEffect(() => {
    setSessionId(null);
    setThreadId(null);
  }, [repository?.projectId]);
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
  const runActive = providerState === "starting"
    || providerState === "streaming"
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
  const send = async () => {
    const value = draft.trim();
    if (!value || !repository || !worktree || !profileId || runActive) return;
    const turnMode = mode;
    setMessages((current) => [...current, { text: value, mode: turnMode }]);
    setDraft("");
    const sentAttachments = attachments;
    setAttachments([]);
    setProviderEvents([]);
    setProviderState("starting");
    setRunId(null);
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
        }),
      });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "Claude Code could not start.");
      }
      const activeRunId = response.headers.get("x-provider-run-id");
      setRunId(activeRunId);
      setThreadId(response.headers.get("x-thread-id"));
      setProviderState("streaming");
      if (!response.body) throw new Error("Claude Code returned no event stream.");
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
    } catch (error) {
      setAttachments(sentAttachments);
      setProviderEvents((current) => [...current, {
        kind: "failed",
        message: error instanceof Error ? error.message : "Claude Code failed.",
      }]);
      setProviderState("failed");
    } finally {
      setRunId(null);
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
  const stateCopy: Record<ProviderState, string> = {
    idle: repository ? "Ready" : "Open a repository to start",
    starting: "Starting Claude Code…",
    streaming: "Claude Code is working…",
    cancelling: "Cancelling…",
    completed: "Turn completed",
    cancelled: "Turn cancelled · send another prompt to resume",
    failed: "Provider stopped · send another prompt to resume",
  };
  return (
    <main className="conversation">
      <header className="conversation-header">
        <div><span className="breadcrumb">aldunis-code <b>/</b> codex/12-permissions</span><h1>Shape Claude permission flow</h1></div>
        <div className="header-actions">
          <button className="mobile-project" onClick={onOpenRepository} aria-label={repository ? `Change repository, current ${repository.name}` : "Open repository"}>
            <Icon name="branch" />
          </button>
          <button onClick={onShowChanges} disabled={!repository} aria-label={repository ? `Review ${changes.length} changed files` : "Review changed files"}>
            <Icon name="diff" /><span>{changes.length} changes</span>
          </button>
          <button className="ghost" onClick={onOpenProfiles} aria-label="Open Claude profile settings">•••</button>
        </div>
      </header>
      <section className="conversation-scroll">
        <div className="date-rule"><span>Today</span></div>
        <article className="user-message">
          <span className="avatar">RK</span>
          <div><header><strong>You</strong><time>14:32</time></header><p>Design the permission flow for Claude Code. Keep every mutating tool explicit and don’t add a terminal.</p></div>
        </article>
        <article className="assistant-message">
          <span className="claude-avatar">C</span>
          <div>
            <header><strong>Claude</strong><span className="model">Sonnet 4</span><time>14:33</time></header>
            <p>I’ll map the provider events into a small permission state machine, then keep approval decisions local to the active worktree.</p>
            <div className="thinking"><span /><span>Inspecting repository boundaries</span><small>2.4s</small></div>
            <div className="file-card">
              <header><span className="file-icon">TS</span><strong>src/providers/permissions.ts</strong><small>proposed</small></header>
              <pre><span>+ export type Approval =</span>{"\n"}<b>+   | {"{ kind: \"once\"; toolCallId: string }"}</b>{"\n"}<span>+   | {"{ kind: \"deny\"; reason?: string }"};</span></pre>
            </div>
            <p>The durable rule path should be a separate issue because it expands approval authority beyond one action.</p>
          </div>
        </article>
        {messages.map((message, index) => (
          <article className="user-message" key={`${message.text}-${index}`}>
            <span className="avatar">RK</span><div><header><strong>You</strong><span className={`turn-mode ${message.mode}`}>{modeCopy[message.mode].label}</span><time>now</time></header><p>{message.text}</p></div>
          </article>
        ))}
        {(providerState !== "idle" || providerEvents.length > 0) && (
          <article className="assistant-message provider-response" aria-live="polite">
            <span className="claude-avatar">C</span>
            <div>
              <header><strong>Claude</strong><span className="model">Claude Code</span><time>now</time></header>
              {(providerState === "starting" || providerState === "streaming" || providerState === "cancelling") && (
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
                <section className={`approval-card ${approval.state}`} key={approval.id} aria-label={`Approval required: ${approval.scope.summary}`}>
                  <header>
                    <span><Icon name="shield" /></span>
                    <div>
                      <strong>{approval.scope.summary}</strong>
                      <small>{approval.toolName} · one action only</small>
                    </div>
                    <em>{approval.state.replace("_", " ")}</em>
                  </header>
                  <p>{approval.scope.target}</p>
                  {approval.scope.details.length > 0 && (
                    <ul>{approval.scope.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                  )}
                  <small className="approval-binding">Bound to this conversation, repository, worktree, and tool call.</small>
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
            </div>
          </article>
        )}
      </section>
      <section className="composer-wrap">
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
            placeholder={!profileId
              ? "Configure a Claude profile first…"
              : worktree
              ? `${modeCopy[mode].label} Claude… Type @ for files or / for commands`
              : "Open a repository with an available worktree…"}
            aria-label="Message Claude"
            aria-autocomplete="list"
            disabled={!worktree || !profileId || runActive}
          />
          {contextError && <div className="context-error" role="alert">{contextError}</div>}
          <footer>
            <div className="provider-selectors">
              <span className="provider-symbol">C</span>
              {profiles.length > 0 ? (
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
              ) : <button className="configure-profile" onClick={onOpenProfiles}>Configure Claude</button>}
              <span className="context">{sessionId ? "Session resumable" : stateCopy[providerState]}</span>
            </div>
            {runId
              ? <button className="cancel-run" onClick={() => void cancel()} disabled={providerState === "cancelling"} aria-label="Cancel Claude Code">■</button>
              : <button className="send" onClick={() => void send()} disabled={!draft.trim() || !worktree || !profileId || runActive} aria-label="Send message">↑</button>}
          </footer>
        </div>
        <p className="disclaimer">Effective authority: {modeCopy[mode].authority} · local context only · @ files · / commands · Enter to send, Shift + Enter for newline</p>
      </section>
      {changesOpen && repository && (
        <ChangesPanel
          repository={repository}
          files={changes}
          loading={changesLoading}
          error={changesError}
          onClose={onHideChanges}
          onRefresh={onRefreshChanges}
        />
      )}
    </main>
  );
}

function CodeWorkbench({
  repository,
  onOpenRepository,
  profiles,
  onOpenProfiles,
}: {
  repository: RepositoryMetadata | null;
  onOpenRepository: () => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: () => void;
}) {
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const refresh = async () => {
    if (!repository) {
      setChanges([]);
      return;
    }
    setLoading(true);
    setError(null);
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
      setError(cause instanceof Error ? cause.message : "Changed files could not be inspected.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void refresh(); }, [repository]);
  const show = () => {
    setOpen(true);
    void refresh();
  };
  return (
    <>
      <CodeSidebar repository={repository} onOpenRepository={onOpenRepository} changes={changes} onShowChanges={show} />
      <Conversation
        repository={repository}
        onOpenRepository={onOpenRepository}
        changes={changes}
        changesLoading={loading}
        changesError={error}
        changesOpen={open}
        onShowChanges={show}
        onHideChanges={() => setOpen(false)}
        onRefreshChanges={refresh}
        profiles={profiles}
        onOpenProfiles={onOpenProfiles}
      />
    </>
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
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-dialog-title">
        <header>
          <div><p className="eyebrow">Local provider settings</p><h2 id="profile-dialog-title">Claude profiles</h2></div>
          <button onClick={onClose} aria-label="Close profile settings">×</button>
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

function App() {
  const [product, setProduct] = useState<Product>("code");
  const [repository, setRepository] = useState<RepositoryMetadata | null>(null);
  const [repositoryDialog, setRepositoryDialog] = useState(false);
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ClaudeProfile[]>([]);
  const [profileDialog, setProfileDialog] = useState(false);
  const loadProfiles = async () => {
    const response = await fetch("/api/provider/profiles/list", { method: "POST" });
    const body = await response.json() as { profiles?: ClaudeProfile[] };
    if (response.ok) setProfiles(body.profiles ?? []);
  };
  useEffect(() => { void loadProfiles(); }, []);
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
      setRepositoryDialog(false);
    } catch (error) {
      setRepositoryError(error instanceof Error ? error.message : "Repository discovery failed.");
    } finally {
      setRepositoryBusy(false);
    }
  };
  const content = useMemo(() => product === "code"
    ? <CodeWorkbench repository={repository} onOpenRepository={showRepositoryDialog} profiles={profiles} onOpenProfiles={() => setProfileDialog(true)} />
    : <DomainPage product={product} />, [product, repository, profiles]);
  return (
    <div className="app">
      <ProductRail product={product} onChange={setProduct} onSettings={() => setProfileDialog(true)} />
      {content}
      <RepositoryDialog
        open={repositoryDialog}
        busy={repositoryBusy}
        error={repositoryError}
        onClose={() => setRepositoryDialog(false)}
        onSubmit={openRepository}
      />
      <ProfileSettingsDialog
        open={profileDialog}
        profiles={profiles}
        onClose={() => setProfileDialog(false)}
        onChanged={loadProfiles}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
