import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { RepositoryMetadata } from "../../types";
import type { SavedProject } from "./repository-dialog";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";
import {
  AutonomyLedgerSessionModule,
  type AutonomyHookEvent,
} from "../../lib/autonomy-ledger-session";

function formatAge(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return date.toLocaleString();
}

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0)
    return `every ${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `every ${Math.max(1, Math.round(seconds / 60))} minute${seconds < 120 ? "" : "s"}`;
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function AutonomyDialog({
  open,
  repository,
  projects,
  managed = false,
  onClose,
}: {
  open: boolean;
  repository: RepositoryMetadata | null;
  projects: SavedProject[];
  managed?: boolean;
  onClose: () => void;
}) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const session = useMemo(
    () =>
      new AutonomyLedgerSessionModule({
        managed: Boolean(managed),
        visibility: document,
        timers: window,
        request: async (path, body) => {
          const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          const result = (await response.json().catch(() => ({}))) as { error?: string };
          if (!response.ok) throw new Error(result.error ?? "Autonomy operation failed.");
          return result;
        },
      }),
    [managed],
  );
  const sessionSnapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const { ledger: snapshot, tab, draft, busy, error, loadError } = sessionSnapshot;
  const {
    projectId,
    worktree,
    goal,
    heartbeatName,
    heartbeatGoal,
    heartbeatMinutes,
    heartbeatFlowId,
    orderName,
    orderInstruction,
    orderScope,
    hookName,
    hookEvent,
    hookFlowId,
    hookCooldown,
  } = draft;

  useEffect(() => {
    if (!open) return;
    const focus = () => firstFieldRef.current?.focus();
    focus();
    const frame = window.requestAnimationFrame(focus);
    session.open({
      projectId: repository?.projectId,
      worktree: repository?.selectedWorktree,
    });
    return () => {
      window.cancelAnimationFrame(frame);
      session.close();
    };
  }, [open, repository?.projectId, repository?.selectedWorktree, session]);

  const projectOptions = useMemo(() => {
    const entries = new Map<string, { id: string; label: string; root: string }>();
    for (const project of projects)
      entries.set(project.id, { id: project.id, label: project.name, root: project.root });
    if (repository)
      entries.set(repository.projectId, {
        id: repository.projectId,
        label: repository.name,
        root: repository.root,
      });
    return [...entries.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [projects, repository]);

  const displayedError = error ?? loadError;
  const visibleInventory =
    tab === "heartbeats"
      ? snapshot.configurationInventory?.heartbeatMonitors
      : tab === "orders"
        ? snapshot.configurationInventory?.standingOrders
        : tab === "hooks"
          ? snapshot.configurationInventory?.hooks
          : undefined;

  const currentProjectLabel =
    projectOptions.find((project) => project.id === projectId)?.label ?? "No project selected";

  if (!open) return null;
  return (
    <OverlayDialog title="Autonomy" onClose={onClose}>
      <div className="autonomy-dialog-body">
        <p className="muted">
          Durable runs, heartbeats, hooks, standing orders, and the nightly gardener live in the
          local ledger. The built-in workflows are read-only; source and provider mutations still
          require the existing approval flow.
        </p>
        {managed && (
          <p className="muted">Managed mode is inspect-only for this local autonomy surface.</p>
        )}
        {displayedError && (
          <p role="alert" className="error-text">
            {displayedError}
          </p>
        )}
        <nav className="autonomy-tabs" aria-label="Autonomy sections">
          {(["runs", "heartbeats", "orders", "hooks"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={tab === item ? "active" : undefined}
              onClick={() => session.selectTab(item)}
            >
              {item === "orders" ? "Standing orders" : item[0].toLocaleUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        {visibleInventory?.truncated && (
          <p role="status" className="muted">
            Showing the {snapshot.configurationInventory?.limitPerKind} most recently updated of{" "}
            {visibleInventory.total} records. Delete visible records to reveal older entries.
          </p>
        )}

        {tab === "runs" && (
          <div className="stack gap-sm">
            <div className="autonomy-panel">
              <h3>Nightly maintenance gardener</h3>
              <p className="muted">
                Inspect bounded repository signals and produce a report. It never edits files or
                launches a provider.
              </p>
              <Field label="Project" htmlFor="autonomy-project">
                <select
                  id="autonomy-project"
                  className="ui-input"
                  value={projectId}
                  onChange={(event) => session.updateDraft({ projectId: event.target.value })}
                >
                  <option value="">Select a project</option>
                  {projectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label} · {project.root}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Worktree" htmlFor="autonomy-worktree">
                <Input
                  id="autonomy-worktree"
                  value={worktree}
                  onChange={(event) => session.updateDraft({ worktree: event.target.value })}
                  placeholder="Repository worktree"
                />
              </Field>
              <Field label="Goal" htmlFor="autonomy-goal">
                <Textarea
                  id="autonomy-goal"
                  rows={2}
                  value={goal}
                  onChange={(event) => session.updateDraft({ goal: event.target.value })}
                />
              </Field>
              <Button
                type="button"
                variant="primary"
                disabled={busy || managed || !projectId}
                onClick={() => void session.command({ kind: "start_gardener" })}
              >
                Start gardener
              </Button>
            </div>
            <h3>Recent runs</h3>
            {snapshot.runs.length === 0 && <p className="muted">No autonomy runs yet.</p>}
            {snapshot.runs.map((run) => {
              const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
              return (
                <article key={run.id} className="autonomy-card">
                  <div className="row gap-sm" style={{ justifyContent: "space-between" }}>
                    <strong>{run.name}</strong>
                    <span className="muted">{statusLabel(run.status)}</span>
                  </div>
                  <div className="muted">
                    {run.trigger} · {formatAge(run.updatedAt)} ·{" "}
                    {run.projectId === projectId
                      ? currentProjectLabel
                      : (run.projectId ?? "awareness")}
                  </div>
                  <p>{run.result?.summary ?? run.error ?? run.goal}</p>
                  {run.result && (
                    <div className="muted">
                      {run.result.findings.length} finding
                      {run.result.findings.length === 1 ? "" : "s"} · {run.result.filesScanned}{" "}
                      files scanned · {run.result.changedFiles} changed
                    </div>
                  )}
                  {run.result?.findings.slice(0, 4).map((item) => (
                    <div key={item.id} className="autonomy-finding">
                      <span className={`severity severity-${item.severity}`}>{item.severity}</span>
                      <span>
                        {item.path ? `${item.path}: ` : ""}
                        {item.summary}
                      </span>
                    </div>
                  ))}
                  <div className="muted">
                    {tasks
                      .map(
                        (task) =>
                          `${task.title}: ${statusLabel(task.status)} (${task.attempt}/${task.maxAttempts})`,
                      )
                      .join(" · ")}
                  </div>
                  <div className="row gap-sm">
                    {!managed && !["succeeded", "failed", "cancelled"].includes(run.status) && (
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void session.command({ kind: "cancel_run", runId: run.id })}
                      >
                        Cancel
                      </Button>
                    )}
                    {!managed && ["lost", "failed", "blocked", "waiting"].includes(run.status) && (
                      <Button
                        size="sm"
                        type="button"
                        onClick={() => void session.command({ kind: "resume_run", runId: run.id })}
                      >
                        Resume
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {tab === "heartbeats" && (
          <div className="stack gap-sm">
            <div className="autonomy-panel">
              <h3>Periodic awareness</h3>
              <Field label="Name" htmlFor="heartbeat-name">
                <Input
                  ref={firstFieldRef}
                  id="heartbeat-name"
                  value={heartbeatName}
                  onChange={(event) => session.updateDraft({ heartbeatName: event.target.value })}
                />
              </Field>
              <Field label="Goal" htmlFor="heartbeat-goal">
                <Textarea
                  id="heartbeat-goal"
                  rows={2}
                  value={heartbeatGoal}
                  onChange={(event) => session.updateDraft({ heartbeatGoal: event.target.value })}
                />
              </Field>
              <Field label="Workflow" htmlFor="heartbeat-flow">
                <select
                  id="heartbeat-flow"
                  className="ui-input"
                  value={heartbeatFlowId}
                  onChange={(event) => session.updateDraft({ heartbeatFlowId: event.target.value })}
                >
                  <option value="heartbeat-awareness.v1">Awareness check</option>
                  <option value="maintenance-gardener.v1">Nightly maintenance gardener</option>
                </select>
              </Field>
              <Field label="Every minutes" htmlFor="heartbeat-minutes">
                <Input
                  id="heartbeat-minutes"
                  type="number"
                  min={1}
                  max={10080}
                  value={heartbeatMinutes}
                  onChange={(event) =>
                    session.updateDraft({
                      heartbeatMinutes: Math.min(
                        10080,
                        Math.max(1, Number(event.target.value) || 1),
                      ),
                    })
                  }
                />
              </Field>
              <Button
                type="button"
                variant="primary"
                disabled={busy || managed || !heartbeatName.trim() || !heartbeatGoal.trim()}
                onClick={() => void session.command({ kind: "create_heartbeat" })}
              >
                Add heartbeat
              </Button>
            </div>
            {snapshot.heartbeatMonitors.length === 0 && (
              <p className="muted">No heartbeats configured.</p>
            )}
            {snapshot.heartbeatMonitors.map((monitor) => (
              <article key={monitor.id} className="autonomy-card">
                <div className="row gap-sm" style={{ justifyContent: "space-between" }}>
                  <strong>{monitor.name}</strong>
                  <span className="muted">{monitor.enabled ? "enabled" : "paused"}</span>
                </div>
                <p>{monitor.goal}</p>
                <div className="muted">
                  {monitor.flowId === "maintenance-gardener.v1" ? "nightly gardener" : "awareness"}{" "}
                  · {formatInterval(monitor.everySeconds)} · last {formatAge(monitor.lastRunAt)} ·{" "}
                  {monitor.lastStatus ? statusLabel(monitor.lastStatus) : "not run"}
                </div>
                <div className="row gap-sm">
                  {!managed && (
                    <>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() =>
                          void session.command({
                            kind: "set_heartbeat_enabled",
                            id: monitor.id,
                            enabled: !monitor.enabled,
                          })
                        }
                      >
                        {monitor.enabled ? "Pause" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() =>
                          void session.command({ kind: "run_heartbeat", id: monitor.id })
                        }
                      >
                        Run now
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        type="button"
                        onClick={() =>
                          void session.command({ kind: "delete_heartbeat", id: monitor.id })
                        }
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {tab === "orders" && (
          <div className="stack gap-sm">
            <div className="autonomy-panel">
              <h3>Standing orders</h3>
              <p className="muted">
                Persistent preferences for bounded autonomy. They do not grant provider, filesystem,
                or approval authority.
              </p>
              <Field label="Name" htmlFor="order-name">
                <Input
                  ref={firstFieldRef}
                  id="order-name"
                  value={orderName}
                  onChange={(event) => session.updateDraft({ orderName: event.target.value })}
                />
              </Field>
              <Field label="Scope" htmlFor="order-scope">
                <select
                  id="order-scope"
                  className="ui-input"
                  value={orderScope}
                  onChange={(event) =>
                    session.updateDraft({ orderScope: event.target.value as typeof orderScope })
                  }
                >
                  <option value="project">Current project</option>
                  <option value="global">All projects</option>
                </select>
              </Field>
              <Field label="Instruction" htmlFor="order-instruction">
                <Textarea
                  id="order-instruction"
                  rows={3}
                  value={orderInstruction}
                  onChange={(event) =>
                    session.updateDraft({ orderInstruction: event.target.value })
                  }
                  placeholder="Example: Prefer small, verifiable maintenance suggestions."
                />
              </Field>
              <Button
                type="button"
                variant="primary"
                disabled={
                  busy ||
                  managed ||
                  !orderName.trim() ||
                  !orderInstruction.trim() ||
                  (orderScope === "project" && !projectId)
                }
                onClick={() => void session.command({ kind: "create_order" })}
              >
                Save standing order
              </Button>
            </div>
            {snapshot.standingOrders.length === 0 && (
              <p className="muted">No standing orders configured.</p>
            )}
            {snapshot.standingOrders.map((order) => (
              <article key={order.id} className="autonomy-card">
                <div className="row gap-sm" style={{ justifyContent: "space-between" }}>
                  <strong>{order.name}</strong>
                  <span className="muted">{order.enabled ? "enabled" : "paused"}</span>
                </div>
                <p>{order.instruction}</p>
                <div className="muted">
                  {order.scope} · {order.projectId ?? "global"}
                </div>
                <div className="row gap-sm">
                  {!managed && (
                    <>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() =>
                          void session.command({
                            kind: "set_order_enabled",
                            id: order.id,
                            enabled: !order.enabled,
                          })
                        }
                      >
                        {order.enabled ? "Pause" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        type="button"
                        onClick={() => void session.command({ kind: "delete_order", id: order.id })}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        {tab === "hooks" && (
          <div className="stack gap-sm">
            <div className="autonomy-panel">
              <h3>Internal event hooks</h3>
              <p className="muted">
                Hooks react to local lifecycle events. They can start only the built-in read-only
                workflows.
              </p>
              <Field label="Name" htmlFor="hook-name">
                <Input
                  ref={firstFieldRef}
                  id="hook-name"
                  value={hookName}
                  onChange={(event) => session.updateDraft({ hookName: event.target.value })}
                />
              </Field>
              <Field label="Event" htmlFor="hook-event">
                <select
                  id="hook-event"
                  className="ui-input"
                  value={hookEvent}
                  onChange={(event) =>
                    session.updateDraft({ hookEvent: event.target.value as AutonomyHookEvent })
                  }
                >
                  <option value="turn_completed">Turn completed</option>
                  <option value="turn_failed">Turn failed</option>
                  <option value="automation_completed">Automation completed</option>
                  <option value="heartbeat_tick">Heartbeat tick</option>
                  <option value="task_completed">Task completed</option>
                </select>
              </Field>
              <Field label="Workflow" htmlFor="hook-flow">
                <select
                  id="hook-flow"
                  className="ui-input"
                  value={hookFlowId}
                  onChange={(event) => session.updateDraft({ hookFlowId: event.target.value })}
                >
                  {snapshot.flows
                    .filter((flow) => flow.readOnly)
                    .map((flow) => (
                      <option key={flow.id} value={flow.id}>
                        {flow.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Cooldown seconds" htmlFor="hook-cooldown">
                <Input
                  id="hook-cooldown"
                  type="number"
                  min={0}
                  max={86400}
                  value={hookCooldown}
                  onChange={(event) =>
                    session.updateDraft({
                      hookCooldown: Math.min(86400, Math.max(0, Number(event.target.value) || 0)),
                    })
                  }
                />
              </Field>
              <Button
                type="button"
                variant="primary"
                disabled={busy || managed || !hookName.trim()}
                onClick={() => void session.command({ kind: "create_hook" })}
              >
                Add hook
              </Button>
            </div>
            {snapshot.hooks.length === 0 && <p className="muted">No hooks configured.</p>}
            {snapshot.hooks.map((hook) => (
              <article key={hook.id} className="autonomy-card">
                <div className="row gap-sm" style={{ justifyContent: "space-between" }}>
                  <strong>{hook.name}</strong>
                  <span className="muted">{hook.enabled ? "enabled" : "paused"}</span>
                </div>
                <div className="muted">
                  {statusLabel(hook.event)} ·{" "}
                  {snapshot.flows.find((flow) => flow.id === hook.flowId)?.name ?? hook.flowId} ·
                  cooldown {hook.cooldownSeconds}s
                </div>
                <div className="row gap-sm">
                  {!managed && (
                    <>
                      <Button
                        size="sm"
                        type="button"
                        onClick={() =>
                          void session.command({
                            kind: "set_hook_enabled",
                            id: hook.id,
                            enabled: !hook.enabled,
                          })
                        }
                      >
                        {hook.enabled ? "Pause" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        type="button"
                        onClick={() => void session.command({ kind: "delete_hook", id: hook.id })}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </OverlayDialog>
  );
}
