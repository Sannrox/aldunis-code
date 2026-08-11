import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ProviderId } from "../../types";
import { Button, Field, Input, Textarea } from "../../components/ui";
import {
  ConversationAutomationSessionModule,
  type AutomationItem,
} from "../../lib/automation-session";
import { providerListLabel } from "../../lib/provider-readiness";
import { OverlayDialog } from "./overlay-dialog";

export interface AutomationThreadOption {
  id: string;
  title: string;
  provider?: ProviderId;
  projectName?: string;
}

export function automationThreadBaseLabel(thread: AutomationThreadOption): string {
  const title = thread.title.trim() || thread.id;
  return [title, thread.projectName, thread.provider ? providerListLabel(thread.provider) : null]
    .filter(Boolean)
    .join(" · ");
}

export function automationThreadLabels(threads: AutomationThreadOption[]): Map<string, string> {
  const groups = new Map<string, AutomationThreadOption[]>();
  for (const thread of threads) {
    const label = automationThreadBaseLabel(thread);
    groups.set(label, [...(groups.get(label) ?? []), thread]);
  }
  const labels = new Map<string, string>();
  for (const [label, group] of groups) {
    group.forEach((thread) => {
      labels.set(thread.id, group.length > 1 ? `${label} · Task ${thread.id.slice(0, 8)}` : label);
    });
  }
  return labels;
}

export function formatAutomationInterval(seconds: number): string {
  const units = [
    { seconds: 86_400, label: "day" },
    { seconds: 3_600, label: "hour" },
    { seconds: 60, label: "minute" },
  ];
  for (const unit of units) {
    if (seconds >= unit.seconds && seconds % unit.seconds === 0) {
      const count = seconds / unit.seconds;
      return `every ${count} ${unit.label}${count === 1 ? "" : "s"}`;
    }
  }
  return `every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function formatAutomationLastStatus(status: AutomationItem["lastStatus"]): string {
  switch (status) {
    case "ok":
      return "Last run succeeded";
    case "skipped_busy":
      return "Last run skipped — conversation was busy";
    case "error":
      return "Last run failed";
    case "unknown":
      return "Outcome unknown — explicit retry required";
    default:
      return "Not run yet";
  }
}

export function AutomationsDialog({
  open,
  threads,
  onClose,
}: {
  open: boolean;
  threads: AutomationThreadOption[];
  onClose: () => void;
}) {
  const session = useMemo(
    () =>
      new ConversationAutomationSessionModule({
        request: async (path, body) => {
          const response = await fetch(path, {
            method: "POST",
            ...(body
              ? {
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                }
              : {}),
          });
          const payload = (await response.json()) as { error?: string };
          if (!response.ok) throw new Error(payload.error ?? "Automation request failed.");
          return payload;
        },
        randomUUID: () => crypto.randomUUID(),
      }),
    [],
  );
  const { items, draft, busy, error } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) session.open(threads.map((thread) => thread.id));
    else session.close();
    return () => session.close();
  }, [open, session, threads]);

  useEffect(() => {
    if (!open) return;
    const focusName = () => nameRef.current?.focus();
    // Dialog focus trap may land on Close; reclaim the primary form field.
    focusName();
    const frame = window.requestAnimationFrame(focusName);
    const timer = window.setTimeout(focusName, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;
  const threadLabels = automationThreadLabels(threads);

  return (
    <OverlayDialog title="Automations" onClose={onClose}>
      <div className="automations-dialog-body">
        <p className="muted">
          Timer-only schedules for existing conversations. Evaluated while the local host is
          running. Mutating tools still require explicit approval.
        </p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="stack gap-sm">
          <Field label="Name" htmlFor="automation-name">
            <Input
              ref={nameRef}
              id="automation-name"
              name="automation-name"
              data-dialog-initial-focus
              value={draft.name}
              onChange={(event) => session.updateDraft({ name: event.target.value })}
            />
          </Field>
          <Field label="Conversation" htmlFor="automation-thread">
            <select
              id="automation-thread"
              name="automation-thread"
              className="ui-input"
              value={draft.threadId}
              onChange={(event) => session.updateDraft({ threadId: event.target.value })}
            >
              {threads.length === 0 && <option value="">No conversations yet</option>}
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {threadLabels.get(thread.id)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prompt" htmlFor="automation-prompt">
            <Textarea
              id="automation-prompt"
              name="automation-prompt"
              value={draft.prompt}
              onChange={(event) => session.updateDraft({ prompt: event.target.value })}
              rows={3}
            />
          </Field>
          <Field label="Mode" htmlFor="automation-mode">
            <select
              id="automation-mode"
              name="automation-mode"
              className="ui-input"
              value={draft.mode}
              onChange={(event) =>
                session.updateDraft({ mode: event.target.value as typeof draft.mode })
              }
            >
              <option value="ask">Ask</option>
              <option value="plan">Plan</option>
              <option value="build">Build</option>
            </select>
          </Field>
          <Field label="Schedule" htmlFor="automation-schedule-kind">
            <select
              id="automation-schedule-kind"
              name="automation-schedule-kind"
              className="ui-input"
              value={draft.scheduleKind}
              onChange={(event) =>
                session.updateDraft({
                  scheduleKind: event.target.value as typeof draft.scheduleKind,
                })
              }
            >
              <option value="interval">Interval</option>
              <option value="cron">Cron (UTC)</option>
            </select>
          </Field>
          {draft.scheduleKind === "interval" ? (
            <Field label="Every N minutes (1–10080)" htmlFor="automation-interval-minutes">
              <Input
                id="automation-interval-minutes"
                name="automation-interval-minutes"
                type="number"
                min={1}
                max={10080}
                step={1}
                value={draft.intervalMinutes}
                onChange={(event) =>
                  session.updateDraft({ intervalMinutes: Number(event.target.value) })
                }
              />
            </Field>
          ) : (
            <Field label="5-field UTC cron" htmlFor="automation-cron">
              <Input
                id="automation-cron"
                name="automation-cron"
                value={draft.cron}
                onChange={(event) => session.updateDraft({ cron: event.target.value })}
              />
            </Field>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={busy || !draft.threadId || !draft.prompt.trim() || !draft.name.trim()}
            aria-label={
              draft.name.trim() ? `Create automation ${draft.name.trim()}` : "Create automation"
            }
            onClick={() => void session.execute({ kind: "create" })}
          >
            Create automation
          </Button>
        </div>
        <hr />
        <ul className="stack gap-sm" aria-label="Saved automations">
          {items.length === 0 && <li className="muted">No automations yet.</li>}
          {items.map((item) => (
            <li key={item.id} className="card muted-border">
              <div className="row gap-sm" style={{ justifyContent: "space-between" }}>
                <strong>{item.name}</strong>
                <span className="muted">{item.enabled ? "enabled" : "paused"}</span>
              </div>
              <div className="muted">
                {item.schedule.kind === "interval"
                  ? formatAutomationInterval(item.schedule.seconds)
                  : `cron ${item.schedule.expression}`}
                {" · "}
                {formatAutomationLastStatus(item.lastStatus)}
                {item.lastError ? ` (${item.lastError})` : ""}
              </div>
              {item.lastFire && (
                <div className="muted">
                  Fire {item.lastFire.key}
                  {" · "}
                  {item.lastFire.scheduledAt ?? item.lastFire.requestedAt}
                  {" · "}
                  {item.lastFire.turnId ? `Turn ${item.lastFire.turnId}` : "No turn bound"}
                  {" · "}
                  {item.lastFire.status}
                  {item.lastFire.error ? ` (${item.lastFire.error})` : ""}
                </div>
              )}
              <div className="row gap-sm">
                <Button
                  type="button"
                  size="sm"
                  aria-label={`${item.enabled ? "Pause" : "Enable"} automation ${item.name}`}
                  disabled={busy}
                  onClick={() =>
                    void session.execute({
                      kind: "set_enabled",
                      id: item.id,
                      enabled: !item.enabled,
                    })
                  }
                >
                  {item.enabled ? "Pause" : "Enable"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  aria-label={`Run automation ${item.name} now`}
                  onClick={() =>
                    void session.execute({
                      kind: "run",
                      id: item.id,
                      ...(item.lastFire?.status === "unknown" ? { retryOf: item.lastFire.id } : {}),
                    })
                  }
                >
                  {item.lastFire?.status === "unknown" ? "Retry unknown" : "Run now"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  aria-label={`Delete automation ${item.name}`}
                  disabled={busy}
                  onClick={() => void session.execute({ kind: "delete", id: item.id })}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </OverlayDialog>
  );
}
