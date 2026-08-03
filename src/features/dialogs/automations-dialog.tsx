import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderId } from "../../types";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { OverlayDialog } from "./overlay-dialog";

export type AutomationSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "cron"; expression: string };

export interface AutomationFireSummary {
  id: string;
  key: string;
  kind: "scheduled" | "manual";
  scheduledAt: string | null;
  requestedAt: string;
  turnId: string | null;
  providerRunId: string | null;
  status: "started" | "completed" | "failed" | "skipped_busy" | "unknown";
  error: string | null;
}

export interface AutomationItem {
  id: string;
  name: string;
  threadId: string;
  prompt: string;
  mode: "ask" | "plan" | "build";
  enabled: boolean;
  schedule: AutomationSchedule;
  lastRunAt: string | null;
  lastStatus: "ok" | "skipped_busy" | "error" | "unknown" | null;
  lastError: string | null;
  lastFire: AutomationFireSummary | null;
}

export interface AutomationThreadOption {
  id: string;
  title: string;
  provider?: ProviderId;
  projectName?: string;
}

export function automationThreadBaseLabel(thread: AutomationThreadOption): string {
  const title = thread.title.trim() || thread.id;
  return [
    title,
    thread.projectName,
    thread.provider ? providerListLabel(thread.provider) : null,
  ].filter(Boolean).join(" · ");
}

export function automationThreadLabels(
  threads: AutomationThreadOption[],
): Map<string, string> {
  const groups = new Map<string, AutomationThreadOption[]>();
  for (const thread of threads) {
    const label = automationThreadBaseLabel(thread);
    groups.set(label, [...(groups.get(label) ?? []), thread]);
  }
  const labels = new Map<string, string>();
  for (const [label, group] of groups) {
    group.forEach((thread) => {
      labels.set(
        thread.id,
        group.length > 1 ? `${label} · Task ${thread.id.slice(0, 8)}` : label,
      );
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

export function formatAutomationLastStatus(
  status: AutomationItem["lastStatus"],
): string {
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
  const [items, setItems] = useState<AutomationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Recurring check");
  const [threadId, setThreadId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"ask" | "plan" | "build">("ask");
  const [scheduleKind, setScheduleKind] = useState<"interval" | "cron">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cron, setCron] = useState("0 * * * *");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/automations/list", { method: "POST" });
    if (!response.ok) {
      setError("Could not load automations.");
      return;
    }
    const body = await response.json() as { automations: AutomationItem[] };
    setItems(body.automations);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    if (!threadId && threads[0]) setThreadId(threads[0].id);
  }, [open, load, threadId, threads]);

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

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const schedule: AutomationSchedule = scheduleKind === "interval"
        ? { kind: "interval", seconds: Math.max(60, Math.floor(intervalMinutes) * 60) }
        : { kind: "cron", expression: cron.trim() };
      const response = await fetch("/api/automations/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, threadId, prompt, mode, schedule, enabled: true }),
      });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "Create failed.");
      }
      setPrompt("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (item: AutomationItem) => {
    const response = await fetch("/api/automations/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: item.id, enabled: !item.enabled }),
    });
    if (!response.ok) {
      const body = await response.json() as { error?: string };
      setError(body.error ?? "Update failed.");
      return;
    }
    await load();
  };

  const runNow = async (id: string, retryOf: string | null = null) => {
    setBusy(true);
    try {
      const response = await fetch("/api/automations/run-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          idempotencyKey: crypto.randomUUID(),
          ...(retryOf ? { retryOf } : {}),
        }),
      });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "Run failed.");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const response = await fetch("/api/automations/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) {
      const body = await response.json() as { error?: string };
      setError(body.error ?? "Delete failed.");
      return;
    }
    await load();
  };

  return (
    <OverlayDialog title="Automations" onClose={onClose}>
      <div className="automations-dialog-body">
        <p className="muted">
          Timer-only schedules for existing conversations. Evaluated while the local host is running.
          Mutating tools still require explicit approval.
        </p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="stack gap-sm">
        <Field label="Name" htmlFor="automation-name">
          <Input
            ref={nameRef}
            id="automation-name"
            name="automation-name"
            data-dialog-initial-focus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Conversation" htmlFor="automation-thread">
          <select
            id="automation-thread"
            name="automation-thread"
            className="ui-input"
            value={threadId}
            onChange={(event) => setThreadId(event.target.value)}
          >
            {threads.length === 0 && <option value="">No conversations yet</option>}
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>{threadLabels.get(thread.id)}</option>
            ))}
          </select>
        </Field>
        <Field label="Prompt" htmlFor="automation-prompt">
          <Textarea
            id="automation-prompt"
            name="automation-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
          />
        </Field>
        <Field label="Mode" htmlFor="automation-mode">
          <select
            id="automation-mode"
            name="automation-mode"
            className="ui-input"
            value={mode}
            onChange={(event) => setMode(event.target.value as typeof mode)}
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
            value={scheduleKind}
            onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}
          >
            <option value="interval">Interval</option>
            <option value="cron">Cron (UTC)</option>
          </select>
        </Field>
        {scheduleKind === "interval" ? (
          <Field label="Every N minutes (1–10080)" htmlFor="automation-interval-minutes">
            <Input
              id="automation-interval-minutes"
              name="automation-interval-minutes"
              type="number"
              min={1}
              max={10080}
              step={1}
              value={intervalMinutes}
              onChange={(event) => {
                const next = Number(event.target.value) || 1;
                setIntervalMinutes(Math.min(10080, Math.max(1, Math.floor(next))));
              }}
            />
          </Field>
        ) : (
          <Field label="5-field UTC cron" htmlFor="automation-cron">
            <Input
              id="automation-cron"
              name="automation-cron"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
            />
          </Field>
        )}
        <Button
          type="button"
          variant="primary"
          disabled={busy || !threadId || !prompt.trim() || !name.trim()}
          aria-label={name.trim() ? `Create automation ${name.trim()}` : "Create automation"}
          onClick={() => void create()}
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
                onClick={() => void toggle(item)}
              >
                {item.enabled ? "Pause" : "Enable"}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                aria-label={`Run automation ${item.name} now`}
                onClick={() => void runNow(
                  item.id,
                  item.lastFire?.status === "unknown" ? item.lastFire.id : null,
                )}
              >
                {item.lastFire?.status === "unknown" ? "Retry unknown" : "Run now"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                aria-label={`Delete automation ${item.name}`}
                onClick={() => void remove(item.id)}
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
