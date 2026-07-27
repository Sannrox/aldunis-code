import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

export type AutomationSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "cron"; expression: string };

export interface AutomationItem {
  id: string;
  name: string;
  threadId: string;
  prompt: string;
  mode: "ask" | "plan" | "build";
  enabled: boolean;
  schedule: AutomationSchedule;
  lastRunAt: string | null;
  lastStatus: "ok" | "skipped_busy" | "error" | null;
  lastError: string | null;
}

export function AutomationsDialog({
  open,
  threads,
  onClose,
}: {
  open: boolean;
  threads: Array<{ id: string; title: string }>;
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

  const runNow = async (id: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/automations/run-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
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
              <option key={thread.id} value={thread.id}>{thread.title || thread.id}</option>
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
          <Field label="Every N minutes (≥ 1)" htmlFor="automation-interval-minutes">
            <Input
              id="automation-interval-minutes"
              name="automation-interval-minutes"
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(Number(event.target.value) || 1)}
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
                ? `every ${item.schedule.seconds}s`
                : `cron ${item.schedule.expression}`}
              {" · "}
              last: {item.lastStatus ?? "seed pending"}
              {item.lastError ? ` (${item.lastError})` : ""}
            </div>
            <div className="row gap-sm">
              <Button type="button" size="sm" onClick={() => void toggle(item)}>
                {item.enabled ? "Pause" : "Enable"}
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void runNow(item.id)}>
                Run now
              </Button>
              <Button type="button" size="sm" variant="danger" onClick={() => void remove(item.id)}>
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </OverlayDialog>
  );
}
