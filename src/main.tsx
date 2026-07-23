import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Product = "code" | "sekai" | "chisei" | "tenkai";
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

function ProductRail({ product, onChange }: { product: Product; onChange: (product: Product) => void }) {
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
      <button className="rail-settings" aria-label="Settings"><Icon name="settings" /></button>
    </aside>
  );
}

function CodeSidebar() {
  return (
    <aside className="context-sidebar">
      <header>
        <div>
          <strong>ALDUNIS CODE</strong>
          <span>Local workbench</span>
        </div>
        <button aria-label="New conversation"><Icon name="plus" /></button>
      </header>
      <button className="project-switcher">
        <span className="repo-glyph">A</span>
        <span><strong>aldunis-code</strong><small>~/Projects/aldunis-code</small></span>
        <Icon name="chevron" />
      </button>
      <div className="sidebar-actions">
        <button><Icon name="search" /> Search <kbd>⌘ K</kbd></button>
        <button><Icon name="branch" /> Worktrees <span className="count">3</span></button>
        <button><Icon name="diff" /> Changed files <span className="change-count">8</span></button>
      </div>
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

function Conversation() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const send = () => {
    const value = draft.trim();
    if (!value) return;
    setMessages((current) => [...current, value]);
    setDraft("");
  };
  return (
    <main className="conversation">
      <header className="conversation-header">
        <div><span className="breadcrumb">aldunis-code <b>/</b> codex/12-permissions</span><h1>Shape Claude permission flow</h1></div>
        <div className="header-actions"><button><Icon name="diff" /><span>8 changes</span></button><button className="ghost">•••</button></div>
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
          <article className="user-message" key={`${message}-${index}`}>
            <span className="avatar">RK</span><div><header><strong>You</strong><time>now</time></header><p>{message}</p></div>
          </article>
        ))}
      </section>
      <section className="composer-wrap">
        <div className="composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }}} placeholder="Ask Claude about this worktree…" aria-label="Message Claude" />
          <footer>
            <div><button className="model-select"><span className="provider-symbol">C</span> Claude Sonnet <span>⌄</span></button><span className="context">42% context</span></div>
            <button className="send" onClick={send} disabled={!draft.trim()} aria-label="Send message">↑</button>
          </footer>
        </div>
        <p className="disclaimer">Prototype only · Claude Code is not connected · Enter to send, Shift + Enter for newline</p>
      </section>
    </main>
  );
}

function App() {
  const [product, setProduct] = useState<Product>("code");
  const content = useMemo(() => product === "code" ? <><CodeSidebar /><Conversation /></> : <DomainPage product={product} />, [product]);
  return <div className="app"><ProductRail product={product} onChange={setProduct} />{content}</div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

