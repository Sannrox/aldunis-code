import React, { useEffect, useMemo, useState } from "react";
import type {
  ClaudeProfile,
  ConversationSummary,
  InteractionMode,
  RepositoryMetadata,
  WorktreeCreationPlan,
} from "../../types";
import { Button } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import { defaultWorktreeBase, worktreeBaseBranchOptions } from "../../lib/worktree-base";
import { worktreeLifecycle } from "../../lib/worktree-lifecycle";
import { OverlayDialog } from "./overlay-dialog";
import { ConversationTurnSessionModule } from "../../lib/conversation-turn-session";
import { BranchSuggestionInput } from "./branch-suggestion-input";

const conversationTurnSession = new ConversationTurnSessionModule();

type WorktreePolicy = "isolated" | "parent";

export function StartDelegatedConversationDialog({
  parent,
  repository,
  profiles,
  onClose,
  onCreated,
  onRepositoryChanged,
}: {
  parent: ConversationSummary;
  repository: RepositoryMetadata | null;
  profiles: ClaudeProfile[];
  onClose: () => void;
  onCreated: (threadId: string) => void;
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<InteractionMode>("ask");
  const [worktreePolicy, setWorktreePolicy] = useState<WorktreePolicy>("isolated");
  const [plan, setPlan] = useState<WorktreeCreationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch] = useState(
    () => `codex/child-${parent.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const taskId = `delegated-task-${parent.id}`;
  const modeId = `delegated-mode-${parent.id}`;
  const worktreeId = `delegated-worktree-${parent.id}`;
  const baseId = `delegated-base-${parent.id}`;
  const baseOptions = useMemo(() => {
    if (!repository) return [] as string[];
    const options = worktreeBaseBranchOptions(repository);
    const parentBranch = repository.worktrees
      .find((item) => item.path === parent.worktree)
      ?.branch?.trim();
    if (parentBranch && !options.includes(parentBranch)) options.push(parentBranch);
    return options.sort((left, right) => left.localeCompare(right));
  }, [parent.worktree, repository]);
  const initialBase = useMemo(() => {
    if (!repository) return "";
    const preferred =
      repository.defaultBranch?.trim() ||
      repository.worktrees.find((item) => item.path === parent.worktree)?.branch?.trim() ||
      defaultWorktreeBase(repository);
    return preferred;
  }, [parent.worktree, repository]);
  const [base, setBase] = useState(initialBase);
  useEffect(() => {
    setBase(initialBase);
    setPlan(null);
  }, [initialBase]);
  const claudeProfileId =
    parent.profileId ??
    profiles.find((profile) => profile.id === "default:claude-code")?.id ??
    profiles.find((profile) => profile.provider === "claude-code" || !profile.provider)?.id ??
    "";
  const shikigamiProfileId =
    parent.profileId ??
    profiles.find((profile) => profile.id === "default:shikigami")?.id ??
    profiles.find((profile) => profile.provider === "shikigami")?.id ??
    "";
  const claudeProfileMissing =
    parent.provider === "claude-code" &&
    (!claudeProfileId ||
      !profiles.some(
        (profile) =>
          profile.id === claudeProfileId &&
          (profile.provider === "claude-code" || !profile.provider),
      ));
  const shikigamiProfileMissing =
    parent.provider === "shikigami" &&
    (!shikigamiProfileId ||
      !profiles.some(
        (profile) => profile.id === shikigamiProfileId && profile.provider === "shikigami",
      ));
  const providerLabel = providerListLabel(parent.provider);
  const isolated = worktreePolicy === "isolated";

  const refreshRepository = async () => {
    if (!repository) return;
    try {
      onRepositoryChanged?.(
        await worktreeLifecycle.refreshRepository(
          { path: repository.root },
          "The parent repository could not be refreshed.",
        ),
      );
    } catch {
      // The original child-start error remains the actionable message.
    }
  };

  const cleanupCreatedWorktree = async (worktree: string) => {
    if (!repository) return;
    try {
      const preview = await worktreeLifecycle.previewRemoval(
        { root: repository.root, path: worktree },
        "The isolated child worktree could not be inspected for cleanup.",
      );
      await worktreeLifecycle.approveRemoval(
        preview.id,
        "The isolated child worktree could not be cleaned up.",
      );
      await refreshRepository();
    } catch {
      // Cleanup is best-effort; the host refuses removal if a child was persisted.
    }
  };

  const previewIsolatedWorktree = async () => {
    if (!repository) {
      setError("Open the parent project before starting a child conversation.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPlan(
        await worktreeLifecycle.previewCreation(
          {
            root: repository.root,
            base,
            branch,
          },
          "The isolated child worktree could not be prepared.",
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The isolated child worktree could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  };

  const startChild = async (worktree: string, createdWorktree = false) => {
    if (!repository || !prompt.trim()) return;
    if (mode === "build" && worktree === parent.worktree) {
      setError("A Build child needs an isolated worktree.");
      return;
    }
    if (parent.provider === "claude-code" && claudeProfileMissing) {
      setError(
        parent.profileId
          ? "The parent Claude Code profile is unavailable. Restore it before starting a child."
          : "Configure a Claude Code profile before starting a child.",
      );
      return;
    }
    if (parent.provider === "shikigami" && shikigamiProfileMissing) {
      setError(
        parent.profileId
          ? "The parent Shikigami profile is unavailable. Restore it before starting a child."
          : "Configure a Shikigami profile before starting a child.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    let childThreadId: string | null = null;
    try {
      const result = await conversationTurnSession.startDelegatedChild({
        providerName: providerLabel,
        onCreated: (threadId) => {
          childThreadId = threadId;
          onCreated(threadId);
        },
        body: {
          root: repository.root,
          worktree,
          prompt: prompt.trim(),
          mode,
          conversationId: crypto.randomUUID(),
          projectId: parent.projectId,
          parentThreadId: parent.id,
          provider: parent.provider,
          workspaceMode: isolated ? "aldunis-managed" : "shared",
          model: parent.model ?? "default",
          profileId:
            parent.provider === "claude-code"
              ? claudeProfileId
              : parent.provider === "shikigami"
                ? shikigamiProfileId
                : null,
          reasoningEffort: parent.reasoningEffort,
          contextPins: [],
        },
      });
      if (result.status === "failed") {
        throw new Error(result.message);
      }
    } catch (cause) {
      if (createdWorktree && !childThreadId) await cleanupCreatedWorktree(worktree);
      setError(
        cause instanceof Error ? cause.message : "The child conversation could not be started.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmIsolatedStart = async () => {
    if (!plan || !repository) return;
    setBusy(true);
    setError(null);
    try {
      const body = await worktreeLifecycle.approveCreation(
        plan.id,
        repository.projectId,
        "The isolated child worktree could not be created.",
      );
      onRepositoryChanged?.(body);
      await startChild(body.selectedWorktree, true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The isolated child worktree could not be created.",
      );
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    if (isolated) await previewIsolatedWorktree();
    else await startChild(parent.worktree);
  };

  return (
    <OverlayDialog
      title={`Start child conversation · ${providerLabel}`}
      onClose={onClose}
      dismissible={!busy}
    >
      <form className="delegated-start-dialog" onSubmit={(event) => void submit(event)}>
        <p className="delegated-start-help">
          The child gets its own conversation and provider session. The parent receives status and
          outcome projections only.
        </p>
        {!plan && (
          <>
            <label htmlFor={taskId}>Child task</label>
            <textarea
              id={taskId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the focused task for the child…"
              rows={5}
              disabled={busy}
              data-dialog-initial-focus
            />
            <label htmlFor={modeId}>Interaction mode</label>
            <select
              id={modeId}
              value={mode}
              onChange={(event) => setMode(event.target.value as InteractionMode)}
              disabled={busy}
            >
              <option value="ask">Ask · read-only</option>
              <option value="plan">Plan · mutations blocked</option>
              <option value="build" disabled={worktreePolicy === "parent"}>
                Build · isolated worktree and approvals
              </option>
            </select>
            <label htmlFor={worktreeId}>Child worktree</label>
            <select
              id={worktreeId}
              value={worktreePolicy}
              onChange={(event) => {
                const next = event.target.value as WorktreePolicy;
                setWorktreePolicy(next);
                if (next === "parent" && mode === "build") setMode("plan");
              }}
              disabled={busy}
            >
              <option value="isolated">New managed worktree · recommended</option>
              <option value="parent">Parent worktree · Ask/Plan only</option>
            </select>
            {isolated && (
              <>
                <label htmlFor={baseId}>Start from</label>
                <BranchSuggestionInput
                  id={baseId}
                  value={base}
                  options={baseOptions}
                  defaultBranch={repository?.defaultBranch}
                  branchCount={repository?.localBranchCount}
                  truncated={repository?.localBranchesTruncated}
                  onChange={(value) => {
                    setBase(value);
                    setPlan(null);
                  }}
                  disabled={busy}
                />
              </>
            )}
            <p className="delegated-start-note">
              {claudeProfileMissing || shikigamiProfileMissing
                ? parent.profileId
                  ? `The parent’s ${providerLabel} profile is unavailable; restore it before starting a child.`
                  : `Configure a ${providerLabel} profile before starting a child.`
                : isolated
                  ? base.trim()
                    ? `The child will branch from ${base} and use a new managed checkout.`
                    : "Choose a starting branch for the child worktree."
                  : "Shared worktrees are limited to read-only and planning children."}
            </p>
            <footer>
              <Button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  !prompt.trim() ||
                  claudeProfileMissing ||
                  shikigamiProfileMissing ||
                  (isolated && !base.trim())
                }
              >
                {busy ? "Starting…" : isolated ? "Preview isolated child" : "Start child"}
              </Button>
            </footer>
          </>
        )}
        {plan && (
          <section className="worktree-approval" aria-label="Approve child worktree creation">
            <strong>Create an isolated child worktree once?</strong>
            <dl>
              <div>
                <dt>Repository</dt>
                <dd title={plan.repository}>{plan.repository}</dd>
              </div>
              <div>
                <dt>Base</dt>
                <dd title={`${plan.base} · ${plan.baseRevision}`}>
                  {plan.base} · {plan.baseRevision}
                </dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd title={plan.branch}>{plan.branch}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd title={plan.path}>{plan.path}</dd>
              </div>
            </dl>
            <p>Approval is single-use. The child conversation will bind to the created checkout.</p>
            <footer>
              <Button type="button" onClick={() => setPlan(null)} disabled={busy}>
                Back
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void confirmIsolatedStart()}
                disabled={busy}
              >
                {busy ? "Starting…" : "Approve and start child"}
              </Button>
            </footer>
          </section>
        )}
        {error && (
          <p className="context-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </OverlayDialog>
  );
}
