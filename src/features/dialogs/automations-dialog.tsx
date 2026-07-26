import React, { useCallback, useEffect, useState } from "react";
import type { ThreadMetadata } from "../../types";
import { Button, Input, Textarea } from "../../components/ui";
import { OverlayDialog } from "./overlay-dialog";

type Schedule =
  | { type: "interval"; secs: number }
  | { type: "cron"; expr: string };

type AutomationOutcome = {
  at: string;
  status: "ok" | "skipped_busy" | "error" | "seeded";
  message?: string;
  turnId?: string;
};

type AutomationListItem = {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  schedule: Schedule;
  threadId: string;
  lastRun: string | null;
  lastOutcome?: AutomationOutcome;
  createdAt: string;
  updatedAt: string;
  threadTitle: string | null;
  projectName: string | null;
  threadMissing: boolean;
};

function scheduleLabel(schedule: Schedule): string {
  if (schedule.type === "interval") {
    if (schedule.secs % 3600 === 0) return `every ${schedule.secs / 3600}h`;
    if (schedule.secs % 60 === 0) return `every ${schedule.secs / 60}m`;
    return `every ${schedule.secs}s`;
  }
  return `cron: ${schedule.expr}`;
}

function outcomeLabel(outcome?: AutomationOutcome): string {
  if (!outcome) return "Never run";
  switch (outcome.status) {
    case "ok":
      return `Ran ${outcome.at}`;
    case "seeded":
      return `Scheduled from ${outcome.at}`;
    case "skipped_busy":
      return `Skipped (busy) ${outcome.at}`;
    case "error":
      return `Error ${outcome.at}${outcome.message ? `: ${outcome.message}` : ""}`;
  }
}

type FormState = {
  name: string;
  prompt: string;
  scheduleKind: "interval" | "cron";
  intervalSecs: number;
  cronExpr: string;
  threadId: string;
  enabled: boolean;
};

const emptyForm = (threads: ThreadMetadata[]): FormState => ({
  name: "",
  prompt: "",
  scheduleKind: "interval",
  intervalSecs: 3600,
  cronExpr: "0 9 * * *",
  threadId: threads[0]?.id ?? "",
  enabled: true,
});

function formFromItem(item: AutomationListItem): FormState {
  return {
    name: item.name,
    prompt: item.prompt,
    scheduleKind: item.schedule.type === "cron" ? "cron" : "interval",
    intervalSecs: item.schedule.type === "interval" ? item.schedule.secs : 3600,
    cronExpr: item.schedule.type === "cron" ? item.schedule.expr : "0 9 * * *",
    threadId: item.threadId,
    enabled: item.enabled,
  };
}

export function AutomationsDialog({
  open,
  threads,
  onClose,
}: {
  open: boolean;
  threads: ThreadMetadata[];
  onClose: () => void;
}) {
  const [items, setItems] = useState<AutomationListItem[]>([]);
  const [recovered, setRecovered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AutomationListItem | "new" | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(threads));

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch("/api/automations/list", { method: "POST" });
      const body = await response.json() as {
        items?: AutomationListItem[];
        recovered?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not load automations.");
      setItems(body.items ?? []);
      setRecovered(Boolean(body.recovered));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load automations.");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (editing === "new") setForm(emptyForm(threads));
    else if (editing) setForm(formFromItem(editing));
  }, [editing, threads]);

  if (!open) return null;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const schedule = form.scheduleKind === "interval"
        ? { type: "interval" as const, secs: Math.floor(form.intervalSecs) }
        : { type: "cron" as const, expr: form.cronExpr.trim() };
      const payload = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule,
        threadId: form.threadId,
        enabled: form.enabled,
      };
      const response = await fetch(
        editing && editing !== "new" ? "/api/automations/update" : "/api/automations/create",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            editing && editing !== "new" ? { id: editing.id, ...payload } : payload,
          ),
        },
      );
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save automation.");
      setEditing(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save automation.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: AutomationListItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/automations/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, enabled: !item.enabled }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update automation.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update automation.");
    } finally {
      setBusy(false);
    }
  }

  async function runNow(item: AutomationListItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/automations/run-now", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not run automation.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not run automation.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: AutomationListItem) {
    if (busy) return;
    if (!window.confirm(`Delete automation "${item.name}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/automations/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not delete automation.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete automation.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = Boolean(form.name.trim())
    && Boolean(form.prompt.trim())
    && Boolean(form.threadId)
    && (form.scheduleKind !== "interval" || form.intervalSecs >= 60)
    && (form.scheduleKind !== "cron" || Boolean(form.cronExpr.trim()));

  return (
    <OverlayDialog title="Automations" onClose={onClose}>
      <div className="automations">
        {recovered && (
          <p className="recovery-note" role="status">
            Invalid automation data was recovered to an empty list.
          </p>
        )}
        {error && <p className="automations__error" role="alert">{error}</p>}

        {editing ? (
          <form
            className="automations__form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="automations__help">
              Durable prompt for an existing conversation. The host must stay running.
              Tool approvals still apply — scheduled turns are not auto-approved.
            </p>
            <label className="automations__field">
              <span>Name</span>
              <Input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                data-dialog-initial-focus
                required
              />
            </label>
            <label className="automations__field">
              <span>Prompt</span>
              <Textarea
                value={form.prompt}
                onChange={(event) => setForm((current) => ({ ...current, prompt: event.target.value }))}
                rows={5}
                required
                placeholder="What to do each run, what is worth reporting, and when to stop or ask."
              />
            </label>
            <label className="automations__field">
              <span>Conversation</span>
              <select
                value={form.threadId}
                onChange={(event) => setForm((current) => ({ ...current, threadId: event.target.value }))}
                required
              >
                {threads.length === 0 && <option value="">No conversations yet</option>}
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title} · {thread.projectName}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="automations__fieldset">
              <legend>Schedule</legend>
              <label className="automations__inline">
                <input
                  type="radio"
                  name="scheduleKind"
                  checked={form.scheduleKind === "interval"}
                  onChange={() => setForm((current) => ({ ...current, scheduleKind: "interval" }))}
                />
                Interval (seconds, min 60)
              </label>
              {form.scheduleKind === "interval" && (
                <Input
                  type="number"
                  min={60}
                  step={1}
                  value={form.intervalSecs}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    intervalSecs: Number(event.target.value),
                  }))}
                />
              )}
              <label className="automations__inline">
                <input
                  type="radio"
                  name="scheduleKind"
                  checked={form.scheduleKind === "cron"}
                  onChange={() => setForm((current) => ({ ...current, scheduleKind: "cron" }))}
                />
                Cron (5-field UTC: min hour dom mon dow)
              </label>
              {form.scheduleKind === "cron" && (
                <Input
                  value={form.cronExpr}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    cronExpr: event.target.value,
                  }))}
                  placeholder="0 9 * * 1-5"
                />
              )}
            </fieldset>
            <label className="automations__inline">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))}
              />
              Enabled
            </label>
            <div className="automations__actions">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !canSubmit}>
                {editing === "new" ? "Create" : "Save"}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="automations__toolbar">
              <p className="automations__help">
                Timer-only prompts into existing conversations. No event triggers.
                Schedules run only while the local host is up.
              </p>
              <Button
                type="button"
                onClick={() => setEditing("new")}
                disabled={busy || threads.length === 0}
              >
                New automation
              </Button>
            </div>
            {threads.length === 0 && (
              <p className="automations__empty">
                Open a conversation first, then attach an automation to it.
              </p>
            )}
            <ul className="automations__list">
              {items.map((item) => (
                <li key={item.id} className="automations__item">
                  <div className="automations__item-main">
                    <strong>{item.name}</strong>
                    <small>
                      {scheduleLabel(item.schedule)}
                      {" · "}
                      {item.threadMissing
                        ? "missing conversation"
                        : (item.threadTitle ?? item.threadId.slice(0, 8))}
                      {item.projectName ? ` · ${item.projectName}` : ""}
                      {item.enabled ? "" : " · paused"}
                    </small>
                    <small>{outcomeLabel(item.lastOutcome)}</small>
                  </div>
                  <div className="automations__item-actions">
                    <Button type="button" variant="ghost" size="sm" onClick={() => void toggle(item)} disabled={busy}>
                      {item.enabled ? "Pause" : "Enable"}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void runNow(item)} disabled={busy}>
                      Run now
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(item)} disabled={busy}>
                      Edit
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => void remove(item)} disabled={busy}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
              {items.length === 0 && threads.length > 0 && (
                <li className="automations__empty">
                  No automations yet. Create one to run a durable prompt on a schedule.
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </OverlayDialog>
  );
}
