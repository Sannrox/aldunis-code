import React, { useEffect, useMemo, useState } from "react";
import type {
  ReleaseDeliveryPlan,
  ReleaseDeliverySession,
  ReleaseWorkflowAction,
  RepositoryMetadata,
} from "../../types";
import { Button, Input } from "../../components/ui";

interface Inspection {
  configuration: {
    chisei: boolean;
    tenkai: boolean;
    localOnly: true;
  };
  sessions: ReleaseDeliverySession[];
}

const stages = [
  { key: "candidate", label: "Candidate", detail: "Clean commit + build evidence" },
  { key: "governance", label: "Evaluate", detail: "Chisei receipt" },
  { key: "release", label: "Publish", detail: "Tenkai immutable release" },
  { key: "promotion", label: "Promote", detail: "Stable channel" },
  { key: "plan", label: "Plan", detail: "Local environment" },
  { key: "outcome", label: "Apply", detail: "Health or rollback" },
] as const;

const stateProgress: Record<string, number> = {
  candidate_ready: 1,
  governance_allowed: 2,
  governance_denied: 1,
  governance_unavailable: 1,
  governance_unknown: 1,
  published: 3,
  publication_unknown: 2,
  promoted: 4,
  planned: 5,
  applying: 5,
  completed: 6,
  recovered: 6,
  failed: 5,
  unknown: 5,
  stale: 0,
};

export function nextReleaseAction(session: ReleaseDeliverySession | null): ReleaseWorkflowAction | null {
  if (!session) return "prepare";
  if (session.state === "stale") return null;
  if (["candidate_ready", "governance_denied", "governance_unavailable", "governance_unknown"].includes(session.state)) {
    return "evaluate";
  }
  if (session.state === "governance_allowed") return "publish";
  if (session.state === "publication_unknown") return "reconcile";
  if (session.state === "published") return "promote";
  if (session.state === "promoted") return "plan";
  if (session.state === "planned") return "apply";
  return "reconcile";
}

export function releaseSessionForView(
  sessions: ReleaseDeliverySession[],
  selectedSessionId: string | null,
  startingNewCandidate: boolean,
): ReleaseDeliverySession | null {
  if (startingNewCandidate) return null;
  return sessions.find((item) => item.id === selectedSessionId) ?? sessions[0] ?? null;
}

function actionLabel(action: ReleaseWorkflowAction): string {
  return {
    prepare: "Prepare candidate",
    evaluate: "Evaluate with Chisei",
    publish: "Publish to Tenkai",
    promote: "Promote to stable",
    plan: "Create local plan",
    apply: "Apply to local",
    reconcile: "Reconcile state",
    rollback: "Roll back local",
  }[action];
}

function compactIdentity(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.length > 32 ? `${value.slice(0, 18)}…${value.slice(-10)}` : value;
}

export function TenkaiDeliveryPanel({
  repository,
  projectId,
  chiseiBound,
}: {
  repository: RepositoryMetadata | null;
  projectId: string | null;
  chiseiBound: boolean;
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [startingNewCandidate, setStartingNewCandidate] = useState(false);
  const [manifestPath, setManifestPath] = useState("tenkai.toml");
  const [rollbackReason, setRollbackReason] = useState("");
  const [preview, setPreview] = useState<ReleaseDeliveryPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const context = repository && projectId ? {
    root: repository.root,
    worktree: repository.selectedWorktree,
    projectId,
  } : null;

  const load = async () => {
    if (!context) {
      setInspection(null);
      return;
    }
    const response = await fetch("/api/release-delivery/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
    });
    const body = await response.json() as Inspection & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Release delivery could not be inspected.");
    setInspection(body);
    setSelectedSessionId((current) => (
      current && body.sessions.some((session) => session.id === current)
        ? current
        : body.sessions[0]?.id ?? null
    ));
  };

  useEffect(() => {
    setInspection(null);
    setPreview(null);
    setStartingNewCandidate(false);
    setError(null);
    setMessage(null);
    void load().catch((cause) => setError(
      cause instanceof Error ? cause.message : "Release delivery could not be inspected.",
    ));
    // Reload when the selected local worktree changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository?.root, repository?.selectedWorktree, projectId]);

  const session = useMemo(
    () => releaseSessionForView(
      inspection?.sessions ?? [],
      selectedSessionId,
      startingNewCandidate,
    ),
    [inspection, selectedSessionId, startingNewCandidate],
  );
  const nextAction = nextReleaseAction(session);
  const progress = session ? stateProgress[session.state] ?? 0 : 0;

  const preparePreview = async (action: ReleaseWorkflowAction) => {
    if (!context) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const input = action === "prepare"
        ? { manifestPath: manifestPath.trim() }
        : action === "rollback"
          ? { sessionId: session?.id, reason: rollbackReason.trim() }
          : { sessionId: session?.id };
      const response = await fetch("/api/release-delivery/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...context, action, input }),
      });
      const body = await response.json() as ReleaseDeliveryPlan & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Release-delivery preview failed.");
      setPreview(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Release-delivery preview failed.");
    } finally {
      setBusy(false);
    }
  };

  const executePreview = async () => {
    if (!context || !preview) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/release-delivery/plans/${preview.id}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      });
      const body = await response.json() as ReleaseDeliverySession & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Release-delivery action failed.");
      setPreview(null);
      setSelectedSessionId(body.id);
      setStartingNewCandidate(false);
      setMessage(`${actionLabel(preview.action)} finished with ${body.state.replaceAll("_", " ")}.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Release-delivery action failed.");
      setPreview(null);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const exportReceipt = async () => {
    if (!context || !session) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/release-delivery/receipt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...context, sessionId: session.id }),
      });
      const body = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Delivery receipt export failed.");
      const blob = new Blob([`${JSON.stringify(body, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `aldunis-delivery-${session.candidate.product}-${session.candidate.version}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("Correlation receipt exported. Foreign authority records were not copied.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delivery receipt export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tenkai-delivery" aria-labelledby="tenkai-delivery-title">
      <header className="tenkai-delivery-heading">
        <div>
          <p className="eyebrow">Capability-linked handoff · local v1</p>
          <h2 id="tenkai-delivery-title">Candidate ledger</h2>
          <p>
            One clean commit crosses three authority boundaries. Every mutation is previewed,
            confirmed, and reconciled before the next one unlocks.
          </p>
        </div>
        <div className="tenkai-config" aria-label="Delivery configuration">
          <span data-ready={inspection?.configuration.chisei && chiseiBound}>
            Chisei {inspection?.configuration.chisei && chiseiBound ? "ready" : "not ready"}
          </span>
          <span data-ready={inspection?.configuration.tenkai}>
            Tenkai {inspection?.configuration.tenkai ? "ready" : "not ready"}
          </span>
        </div>
      </header>

      {!context ? (
        <p className="domain-empty">Open a local project and select its committed worktree.</p>
      ) : (
        <div className="tenkai-ledger-layout">
          <ol className="tenkai-stage-rail" aria-label="Release delivery stages">
            {stages.map((stage, index) => {
              const number = index + 1;
              const state = number < progress ? "complete" : number === progress ? "current" : "pending";
              return (
                <li key={stage.key} data-state={state}>
                  <span>{String(number).padStart(2, "0")}</span>
                  <div>
                    <strong>{stage.label}</strong>
                    <small>{stage.detail}</small>
                  </div>
                </li>
              );
            })}
          </ol>

          <div className="tenkai-ledger-main">
            {inspection?.sessions.length && !startingNewCandidate ? (
              <label className="tenkai-session-select">
                Delivery session
                <select
                  value={session?.id ?? ""}
                  onChange={(event) => {
                    setSelectedSessionId(event.target.value);
                    setStartingNewCandidate(false);
                    setPreview(null);
                    setMessage(null);
                    setError(null);
                  }}
                >
                  {inspection.sessions.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.candidate.release} · {item.state.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {session ? (
              <article className="tenkai-candidate-card">
                <header>
                  <div>
                    <span className={`tenkai-completeness ${session.completeness}`}>
                      {session.completeness}
                    </span>
                    <h3>{session.candidate.release}</h3>
                  </div>
                  <time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time>
                </header>
                <dl>
                  <div><dt>Candidate</dt><dd title={session.candidate.identity}><code>{compactIdentity(session.candidate.identity)}</code></dd></div>
                  <div><dt>Commit</dt><dd title={session.candidate.document.commit.oid}><code>{compactIdentity(session.candidate.document.commit.oid)}</code></dd></div>
                  <div><dt>Governance</dt><dd>{session.evaluation ? `${session.evaluation.decision} · ${compactIdentity(session.evaluation.operationId)}` : "Not evaluated"}</dd></div>
                  <div><dt>Release</dt><dd>{compactIdentity(session.tenkai.releaseId)}</dd></div>
                  <div><dt>Plan</dt><dd>{compactIdentity(session.tenkai.planId)}</dd></div>
                  <div><dt>Local</dt><dd>{session.tenkai.deployedVersion ?? "Not deployed"}{session.tenkai.health ? ` · health ${session.tenkai.health}` : ""}</dd></div>
                </dl>
                {session.error && <p className="domain-message error" role="alert">{session.error}</p>}
              </article>
            ) : (
              <div className="tenkai-manifest">
                <label htmlFor="tenkai-manifest-path">
                  Tenkai manifest
                  <span>Repository-relative · committed · software kind</span>
                </label>
                <Input
                  id="tenkai-manifest-path"
                  value={manifestPath}
                  onChange={(event) => setManifestPath(event.target.value)}
                  maxLength={1_024}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}

            {message && <p className="domain-message" role="status">{message}</p>}
            {error && <p className="domain-message error" role="alert">{error}</p>}

            {preview ? (
              <article className="tenkai-preview" aria-labelledby="tenkai-preview-title">
                <p className="eyebrow">Single-use confirmation · expires {new Date(preview.expiresAt).toLocaleTimeString()}</p>
                <h3 id="tenkai-preview-title">{preview.summary}</h3>
                <ul>
                  {preview.details.map((detail) => <li key={detail}>{detail}</li>)}
                </ul>
                <p>
                  Local confirmation authorizes only this adapter invocation. Chisei and Tenkai
                  independently retain governance, approval, delivery, and recovery authority.
                </p>
                <footer>
                  <Button type="button" onClick={() => setPreview(null)} disabled={busy}>Cancel</Button>
                  <Button type="button" variant="primary" onClick={() => void executePreview()} disabled={busy}>
                    {busy ? "Running…" : `Confirm ${actionLabel(preview.action)}`}
                  </Button>
                </footer>
              </article>
            ) : (
              <div className="tenkai-actions">
                {nextAction ? (
                  <Button
                    type="button"
                    variant="primary"
                    disabled={busy || !inspection || (nextAction === "prepare" && !manifestPath.trim())}
                    onClick={() => void preparePreview(nextAction)}
                  >
                    {busy ? "Inspecting…" : actionLabel(nextAction)}
                  </Button>
                ) : (
                  <p className="domain-message">
                    This candidate no longer matches the committed worktree. Start a new candidate.
                  </p>
                )}
                {session && ["failed", "unknown", "completed"].includes(session.state) && (
                  <div className="tenkai-rollback">
                    <label htmlFor="tenkai-rollback-reason">Rollback reason</label>
                    <Input
                      id="tenkai-rollback-reason"
                      value={rollbackReason}
                      onChange={(event) => setRollbackReason(event.target.value)}
                      maxLength={500}
                      placeholder="Why is local recovery required?"
                    />
                    <Button
                      type="button"
                      disabled={busy || !rollbackReason.trim()}
                      onClick={() => void preparePreview("rollback")}
                    >
                      Preview rollback
                    </Button>
                  </div>
                )}
                {session && (
                  <Button type="button" disabled={busy} onClick={() => void exportReceipt()}>
                    Export receipt
                  </Button>
                )}
                {inspection?.sessions.length && !startingNewCandidate && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setStartingNewCandidate(true);
                      setPreview(null);
                      setMessage(null);
                      setError(null);
                    }}
                  >
                    New candidate
                  </Button>
                )}
                {startingNewCandidate && (
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setStartingNewCandidate(false);
                      setPreview(null);
                    }}
                  >
                    Return to session
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <p className="tenkai-process-boundary">
        Build scripts and Tenkai deployment commands run with the local OS user’s authority.
        This workflow is not an operating-system sandbox and exposes no general terminal.
      </p>
    </section>
  );
}
