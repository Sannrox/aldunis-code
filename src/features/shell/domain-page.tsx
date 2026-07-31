import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Product, IconName, RepositoryMetadata } from "../../types";
import { Icon } from "../../components/icon";
import type { SavedProject } from "../dialogs/repository-dialog";
import { Button, Input } from "../../components/ui";
import { TenkaiDeliveryPanel } from "./tenkai-delivery";

const productPages = {
  sekai: {
    eyebrow: "Knowledge plane",
    title: "Trace what the system knows.",
    summary: "Evidence, provenance, artifacts, and lineage — projected once a Sekai contract is attached.",
    items: ["Knowledge", "Evidence", "Provenance", "Artifacts", "Explorer"],
    icon: "spark" as IconName,
    integration: "projected" as const,
    boundary:
      "These are routes that would be projected once a contract is attached. Do not treat local exploration as knowledge-plane authority.",
  },
  chisei: {
    eyebrow: "Governance plane",
    title: "Make every decision inspectable.",
    summary: "Policies, budgets, model routing, usage, and audit remain governed by Sekai Chisei contracts.",
    items: ["Operations", "Policies", "Budgets", "Models", "Routing", "Usage", "Audit"],
    icon: "shield" as IconName,
    integration: "projected" as const,
    boundary:
      "Approvals granted locally in Code are not policy decisions. Chisei is a remote contract — not a local database shared with this workbench.",
  },
  tenkai: {
    eyebrow: "Delivery plane",
    title: "Ship with a way back.",
    summary: "Releases, environments, deployments, rollback, and recovery remain authoritative in Tenkai.",
    items: ["Releases", "Channels", "Environments", "Plans", "Approvals", "Runs", "Recovery"],
    icon: "rocket" as IconName,
    integration: "embedded" as const,
    boundary:
      "A merged worktree is not a release. Local Tenkai-facing UI may embed, but delivery authority stays in Tenkai.",
  },
};

interface ActionRow {
  instanceId: string;
  typeId: string;
  version: string;
  operationId: string | null;
  status: string;
  createdAt: string;
}

interface ActionDetail {
  action: ActionRow;
  effects: Array<{
    effectId: string;
    kind: string;
    status: string;
    lifecycleState: string;
    updatedAt: string;
  }>;
  receipt: {
    operationId: string;
    complete: boolean;
    missingSurfaces: string[];
    eventCount: number | null;
  } | null;
}

function ChiseiActionsPanel({
  projects,
  selectedProjectId,
  onProjectsChanged,
  bindingAdministrationAvailable,
  correlationId,
}: {
  projects: SavedProject[];
  selectedProjectId: string | null;
  onProjectsChanged?: () => Promise<void>;
  bindingAdministrationAvailable: boolean;
  correlationId: string | null;
}) {
  const selectedProject = useMemo(() => {
    const matched = projects.find((project) => (
      project.id === selectedProjectId || project.memberIds?.includes(selectedProjectId ?? "")
    ));
    return matched ?? (selectedProjectId === null ? projects[0] ?? null : null);
  }, [projects, selectedProjectId]);
  const activeProjectId = selectedProjectId && selectedProject?.memberIds?.includes(selectedProjectId)
    ? selectedProjectId
    : selectedProject?.id ?? null;
  const hasMemberBinding = Boolean(
    activeProjectId
    && selectedProject?.chiseiBindings
    && Object.hasOwn(selectedProject.chiseiBindings, activeProjectId),
  );
  const selectedNamespace = activeProjectId
    ? hasMemberBinding
      ? selectedProject?.chiseiBindings?.[activeProjectId] ?? null
      : selectedProject?.chiseiNamespace ?? null
    : null;
  const [namespace, setNamespace] = useState(selectedNamespace ?? "");
  const [boundNamespace, setBoundNamespace] = useState(selectedNamespace);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [projectionState, setProjectionState] = useState<"idle" | "loading" | "live" | "stale" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<ActionDetail | null>(null);
  const [operationReceipt, setOperationReceipt] = useState<ActionDetail["receipt"]>(null);
  const [operationLoading, setOperationLoading] = useState(false);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const synchronizedBinding = useRef(`${activeProjectId ?? ""}\n${selectedNamespace ?? ""}`);

  useEffect(() => {
    const next = selectedNamespace;
    const bindingKey = `${activeProjectId ?? ""}\n${next ?? ""}`;
    if (synchronizedBinding.current === bindingKey) {
      setNamespace(next ?? "");
      setBoundNamespace(next);
      return;
    }
    synchronizedBinding.current = bindingKey;
    setNamespace(next ?? "");
    setBoundNamespace(next);
    setActions([]);
    setDetail(null);
    setProjectionState(next ? "idle" : "idle");
    setMessage(null);
    listRequest.current += 1;
    detailRequest.current += 1;
  }, [activeProjectId, selectedNamespace]);

  useEffect(() => {
    if (!activeProjectId || !correlationId) {
      setOperationReceipt(null);
      setOperationLoading(false);
      return;
    }
    setOperationReceipt(null);
    setOperationLoading(true);
    setMessage(null);
    let active = true;
    void fetch("/api/integrations/chisei/operations/detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: activeProjectId, correlationId }),
    }).then(async (response) => {
      const body = await response.json() as NonNullable<ActionDetail["receipt"]> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Operation receipt failed.");
      if (active) {
        setOperationReceipt(body);
        setOperationLoading(false);
      }
    }).catch((error) => {
      if (active) {
        setOperationReceipt(null);
        setOperationLoading(false);
        setMessage(error instanceof Error ? error.message : "Operation receipt failed.");
      }
    });
    return () => { active = false; };
  }, [activeProjectId, correlationId]);

  const loadActions = async () => {
    if (!activeProjectId || !boundNamespace) return;
    const request = ++listRequest.current;
    const projectId = activeProjectId;
    setProjectionState("loading");
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/chisei/actions/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, limit: 25 }),
      });
      const body = await response.json() as {
        state?: "live" | "stale";
        actions?: ActionRow[];
        warning?: string | null;
        error?: string;
      };
      if (request !== listRequest.current || activeProjectId !== projectId) return;
      if (!response.ok) throw new Error(body.error ?? "Chisei projection failed.");
      setActions(body.actions ?? []);
      setProjectionState(body.state ?? "live");
      setMessage(body.warning ?? null);
    } catch (error) {
      if (request !== listRequest.current || activeProjectId !== projectId) return;
      setProjectionState("error");
      setMessage(error instanceof Error ? error.message : "Chisei projection failed.");
    }
  };

  useEffect(() => {
    if (boundNamespace) void loadActions();
    // Fetch only when the server-owned binding changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, boundNamespace]);

  const saveBinding = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeProjectId || !bindingAdministrationAvailable) return;
    listRequest.current += 1;
    detailRequest.current += 1;
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/chisei/bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          namespace: namespace.trim() || null,
        }),
      });
      const body = await response.json() as { chiseiNamespace?: string | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Chisei binding failed.");
      const nextBinding = body.chiseiNamespace ?? null;
      synchronizedBinding.current = `${activeProjectId}\n${nextBinding ?? ""}`;
      setBoundNamespace(nextBinding);
      setNamespace(nextBinding ?? "");
      if (nextBinding !== boundNamespace) {
        setActions([]);
        setDetail(null);
        setProjectionState("idle");
      }
      setMessage(body.chiseiNamespace
        ? "Project binding saved locally."
        : "Project binding removed.");
      await onProjectsChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Chisei binding failed.");
      setProjectionState("error");
    }
  };

  const openDetail = async (instanceId: string) => {
    if (!activeProjectId) return;
    const request = ++detailRequest.current;
    const projectId = activeProjectId;
    setMessage(null);
    try {
      const response = await fetch("/api/integrations/chisei/actions/detail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, instanceId }),
      });
      const body = await response.json() as ActionDetail & { error?: string };
      if (request !== detailRequest.current || activeProjectId !== projectId) return;
      if (!response.ok) throw new Error(body.error ?? "Action detail failed.");
      setDetail(body);
    } catch (error) {
      if (request !== detailRequest.current || activeProjectId !== projectId) return;
      setMessage(error instanceof Error ? error.message : "Action detail failed.");
    }
  };

  return (
    <section className="chisei-actions" aria-labelledby="chisei-actions-title">
      <header>
        <div>
          <p className="eyebrow">Read-only project projection</p>
          <h2 id="chisei-actions-title">Governed Actions</h2>
        </div>
        {boundNamespace && (
          <Button type="button" onClick={() => void loadActions()} disabled={projectionState === "loading"}>
            {projectionState === "loading" ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      </header>
      {!selectedProject ? (
        <p className="domain-empty">Open a local project before configuring its Chisei projection.</p>
      ) : (
        <>
          <form className="chisei-binding" onSubmit={saveBinding}>
            <label htmlFor="chisei-project-namespace">
              Project namespace
              <span>{selectedProject.name} · stored by this local host</span>
            </label>
            <Input
              id="chisei-project-namespace"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              disabled={!bindingAdministrationAvailable}
              placeholder="team/project"
              maxLength={200}
              autoComplete="off"
            />
            <Button type="submit" disabled={!bindingAdministrationAvailable}>Save binding</Button>
          </form>
          {!bindingAdministrationAvailable && (
            <p className="settings-hint">Binding administration is available only on loopback.</p>
          )}
          <p className="boundary-copy">
            Endpoint and credentials stay server-side. This view cannot admit, claim, retry, or mutate Actions.
          </p>
          {message && (
            <p className={projectionState === "error" ? "domain-message error" : "domain-message"} role={projectionState === "error" ? "alert" : "status"}>
              {message}
            </p>
          )}
          {operationReceipt && (
            <article className="chisei-action-detail" aria-label="Direct governed operation receipt">
              <p className="eyebrow">Direct governed · Shikigami</p>
              <h3>Operation receipt</h3>
              <dl>
                <div><dt>Operation</dt><dd><code>{operationReceipt.operationId}</code></dd></div>
                <div><dt>Receipt</dt><dd>{operationReceipt.complete ? "Complete" : "Incomplete"}</dd></div>
                <div><dt>Events</dt><dd>{operationReceipt.eventCount ?? "Not reported"}</dd></div>
              </dl>
            </article>
          )}
          {operationLoading && (
            <p className="domain-empty" role="status">Loading operation receipt…</p>
          )}
          {boundNamespace && projectionState !== "loading" && actions.length === 0 && projectionState !== "error" && (
            <p className="domain-empty">No governed Actions are visible for this project.</p>
          )}
          {projectionState === "loading" && <p className="domain-empty" role="status">Loading governed Actions…</p>}
          {actions.length > 0 && (
            <ul className="chisei-action-list" aria-label="Governed Actions">
              {actions.map((action) => (
                <li key={action.instanceId}>
                  <button type="button" onClick={() => void openDetail(action.instanceId)}>
                    <span className={`chisei-status ${action.status}`}>{action.status}</span>
                    <strong>{action.typeId}</strong>
                    <span>v{action.version}</span>
                    <span>{new Date(action.createdAt).toLocaleString()}</span>
                    <code>{action.operationId ?? "No operation"}</code>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {detail && (
            <article className="chisei-action-detail" aria-labelledby="chisei-action-detail-title">
              <header>
                <div>
                  <p className="eyebrow">Authoritative source: Chisei</p>
                  <h3 id="chisei-action-detail-title">{detail.action.typeId} · {detail.action.status}</h3>
                </div>
                <Button type="button" onClick={() => setDetail(null)}>Close detail</Button>
              </header>
              <dl>
                <div><dt>Action</dt><dd><code>{detail.action.instanceId}</code></dd></div>
                {detail.receipt && (
                  <>
                    <div><dt>Operation</dt><dd><code>{detail.receipt.operationId}</code></dd></div>
                    <div><dt>Receipt</dt><dd>{detail.receipt.complete ? "Complete" : "Incomplete"}{detail.receipt.eventCount === null ? "" : ` · ${detail.receipt.eventCount} events`}</dd></div>
                  </>
                )}
              </dl>
              {!detail.receipt && (
                <p className="domain-empty">This Action has no operation or receipt.</p>
              )}
              {detail.receipt && detail.receipt.missingSurfaces.length > 0 && (
                <p className="domain-message">Missing receipt surfaces: {detail.receipt.missingSurfaces.join(", ")}</p>
              )}
              <ul className="chisei-effect-list" aria-label="Action effects">
                {detail.effects.map((effect) => (
                  <li key={effect.effectId}>
                    <strong>{effect.kind}</strong>
                    <span>{effect.lifecycleState || effect.status}</span>
                    <time dateTime={effect.updatedAt}>{new Date(effect.updatedAt).toLocaleString()}</time>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </>
      )}
    </section>
  );
}

export function DomainPage({
  product,
  projects = [],
  selectedProjectId = null,
  onProjectsChanged,
  chiseiBindingAdministrationAvailable = true,
  chiseiCorrelationId = null,
  repository = null,
}: {
  product: Exclude<Product, "code">;
  projects?: SavedProject[];
  selectedProjectId?: string | null;
  onProjectsChanged?: () => Promise<void>;
  chiseiBindingAdministrationAvailable?: boolean;
  chiseiCorrelationId?: string | null;
  repository?: RepositoryMetadata | null;
}) {
  const page = productPages[product];
  const selectedProject = projects.find((project) => (
    project.id === selectedProjectId || project.memberIds?.includes(selectedProjectId ?? "")
  )) ?? null;
  const worktreeProjectId = repository && selectedProject
    ? Object.entries(selectedProject.memberRoots ?? {}).find(
      ([, root]) => root === repository.selectedWorktree,
    )?.[0] ?? null
    : null;
  const activeProjectId = worktreeProjectId
    ?? (
      selectedProjectId && selectedProject?.memberIds?.includes(selectedProjectId)
        ? selectedProjectId
        : selectedProject?.id ?? null
    );
  const chiseiBound = Boolean(
    activeProjectId
    && (
      Object.hasOwn(selectedProject?.chiseiBindings ?? {}, activeProjectId)
        ? selectedProject?.chiseiBindings?.[activeProjectId]
        : selectedProject?.chiseiNamespace
    ),
  );
  return (
    <main className={`domain-page ${product}`}>
      <div className="domain-orbit"><Icon name={page.icon} /></div>
      <p className="eyebrow">
        {page.eyebrow} · {page.integration === "embedded" ? "local integration" : "projected contract"}
      </p>
      <h1>{page.title}</h1>
      <p className="domain-summary">{page.summary}</p>
      <div className="domain-grid">
        {page.items.map((item, index) => (
          <button
            type="button"
            key={item}
            disabled
            aria-disabled="true"
            aria-label={`${item}: not available until ${page.eyebrow.toLowerCase()} is configured`}
            title="Projected route — unavailable until this plane is configured"
          >
            <span>0{index + 1}</span>
            <strong>{item}</strong>
            <Icon name="chevron" />
          </button>
        ))}
      </div>
      <aside className="boundary-note">
        <span>BOUNDARY</span>
        {page.boundary}
      </aside>
      {product === "chisei" && (
        <ChiseiActionsPanel
          projects={projects}
          selectedProjectId={activeProjectId ?? selectedProjectId}
          onProjectsChanged={onProjectsChanged}
          bindingAdministrationAvailable={chiseiBindingAdministrationAvailable}
          correlationId={chiseiCorrelationId}
        />
      )}
      {product === "tenkai" && (
        <TenkaiDeliveryPanel
          repository={repository}
          projectId={activeProjectId}
          chiseiBound={chiseiBound}
        />
      )}
    </main>
  );
}
