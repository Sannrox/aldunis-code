import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RepositoryMetadata,
  ConversationSummary,
  ClaudeProfile,
  ChangedFile,
  ProviderId,
  DelegatedApprovalProjection,
  DelegatedInputProjection,
  DelegatedConversationOutcomeProjection,
  DelegatedConversationRelationship,
  ManagedAccount,
  BranchPrLookupResult,
  BranchPrStatus,
} from "../../types";
import { clampSplitPercent, normalizeSplitWorkspaceState } from "../../split-workspace";
import { CodeSidebar, type ProjectFilter } from "./sidebar";
import { UsagePage } from "./usage-page";
import { PaneConversation } from "./pane-conversation";
import { MissingConversation } from "./missing-conversation";
import { branchFromWorktree, conversationListFromProjection } from "./conversation-list";
import { isQuietDelegatedChild, summarizeDelegatedOutcomes } from "./delegated-outcomes";
import { Button, CloseButton } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import {
  DEFAULT_MOBILE_SIDEBAR_OPEN,
  DEFAULT_SIDEBAR_OPEN,
  MOBILE_SIDEBAR_OPEN_STORAGE_KEY,
  matchesSidebarToggleShortcut,
  readSidebarOpenPreference,
  SIDEBAR_OPEN_STORAGE_KEY,
  SIDEBAR_TOGGLE_SHORTCUT_LABEL,
  writeSidebarOpenPreference,
} from "../../lib/sidebar-state";
import {
  loadFreshLocalStateProjection,
  loadLocalStateProjection,
} from "../../lib/local-state-load";
import {
  createWorkbenchProjectionSynchronization,
  isThreadStatusEvent,
  reconcileWorkbenchConversations,
  type WorkbenchProjectionSnapshot,
  type WorkbenchStateProjection,
} from "./workbench-projection-sync";
import { loadChangedFiles, loadFreshChangedFiles } from "../../lib/changed-files-load";
import { DomainPage } from "../shell/domain-page";
import type { SavedProject } from "../dialogs/repository-dialog";
import { RenameConversationDialog } from "../dialogs/rename-conversation-dialog";
import { StartDelegatedConversationDialog } from "../dialogs/start-delegated-conversation-dialog";
import {
  DeleteConversationDialog,
  type ConversationDeletionPreview,
} from "../dialogs/delete-conversation-dialog";
import { ReleaseWorktreeDialog } from "../dialogs/release-worktree-dialog";
import { delegatedConversationLabels } from "./delegated-conversation-labels";
import { delegatedConversationAncestorIds } from "../../lib/delegated-conversation-graph";
import {
  BRANCH_PR_CLIENT_BATCH_LIMIT,
  chunkWorktreeRoots,
  indexBranchPrResults,
  uniqueWorktreeRoots,
} from "../../lib/branch-pr-status";

/** Pane tab label: title alone collides when dual-pane hosts same-titled forks. */
function paneConversationLabel(
  conversation: ConversationSummary | null | undefined,
  fallback: string,
): string {
  if (!conversation) return fallback;
  const title = conversation.title.trim() || "Conversation";
  if (!conversation.provider) return title;
  return `${title} · ${providerListLabel(conversation.provider)}`;
}

const PROJECT_FILTER_KEY = "aldunis.projectFilter";
const SIDEBAR_MOBILE_MEDIA_QUERY = "(max-width: 680px)";

function readNarrowViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDEBAR_MOBILE_MEDIA_QUERY).matches
  );
}

function readInitialSidebarOpen(): boolean {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_OPEN;
  try {
    const narrowViewport = readNarrowViewport();
    return readSidebarOpenPreference(
      window.localStorage,
      narrowViewport ? MOBILE_SIDEBAR_OPEN_STORAGE_KEY : SIDEBAR_OPEN_STORAGE_KEY,
      narrowViewport ? DEFAULT_MOBILE_SIDEBAR_OPEN : DEFAULT_SIDEBAR_OPEN,
    );
  } catch {
    return readNarrowViewport() ? DEFAULT_MOBILE_SIDEBAR_OPEN : DEFAULT_SIDEBAR_OPEN;
  }
}

function persistSidebarOpen(open: boolean, narrowViewport: boolean): void {
  if (typeof window === "undefined") return;
  try {
    writeSidebarOpenPreference(
      window.localStorage,
      open,
      narrowViewport ? MOBILE_SIDEBAR_OPEN_STORAGE_KEY : SIDEBAR_OPEN_STORAGE_KEY,
    );
  } catch {
    /* Ignore unavailable browser storage. */
  }
}

function isSidebarShortcutCaptured(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("[data-keybinding-capture]") !== null ||
    target.matches("input, textarea, select")
  );
}

export { isThreadStatusEvent };

export function DelegatedChildrenPanel({
  parent,
  repository = null,
  profiles = [],
  onRepositoryChanged,
  conversations,
  relationships,
  outcomes,
  approvals,
  inputs = [],
  onOpen,
  onChanged,
}: {
  parent: ConversationSummary;
  repository?: RepositoryMetadata | null;
  profiles?: ClaudeProfile[];
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
  conversations: ConversationSummary[];
  relationships: DelegatedConversationRelationship[];
  outcomes: DelegatedConversationOutcomeProjection[];
  approvals: DelegatedApprovalProjection[];
  inputs?: DelegatedInputProjection[];
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [selectedChildId, setSelectedChildId] = useState("");
  const [startOpen, setStartOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [approvalBusyId, setApprovalBusyId] = useState<string | null>(null);
  const [inputBusyId, setInputBusyId] = useState<string | null>(null);
  const [inputAnswers, setInputAnswers] = useState<Record<string, string>>({});
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const outcomeSummary = summarizeDelegatedOutcomes(parent.id, conversations, relationships);
  const approvalChildIds = new Set(
    approvals
      .filter(
        (item) => item.parentThreadId === parent.id && !resolvedApprovalIds.has(item.approval.id),
      )
      .map((item) => item.childThreadId),
  );
  const approvalCount = new Set([
    ...outcomeSummary.outcomes
      .filter(({ child }) => child.status === "pending_approval")
      .map(({ child }) => child.id),
    ...approvalChildIds,
  ]).size;
  const runningCount = outcomeSummary.outcomes.filter(
    ({ child }) => child.status === "running" && !approvalChildIds.has(child.id),
  ).length;
  const unavailableChildIds = new Set(relationships.map((item) => item.childThreadId));
  const ancestorIds = delegatedConversationAncestorIds(relationships, parent.id);
  const candidates = conversations.filter(
    (item) =>
      item.id !== parent.id &&
      !item.archivedAt &&
      !unavailableChildIds.has(item.id) &&
      !ancestorIds.has(item.id),
  );
  const candidateLabels = delegatedConversationLabels(candidates);
  const mutate = async (route: string, childThreadId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentThreadId: parent.id, childThreadId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Delegated conversation update failed.");
      setSelectedChildId("");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Delegated conversation update failed.");
    } finally {
      setBusy(false);
    }
  };
  const decideApproval = async (
    delegated: DelegatedApprovalProjection,
    decision: "allow_once" | "deny",
  ) => {
    setApprovalBusyId(delegated.approval.id);
    setError(null);
    try {
      const response = await fetch(`/api/provider/approvals/${delegated.approval.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: delegated.approval.runId,
          conversationId: delegated.approval.conversationId,
          repository: delegated.approval.repository,
          worktree: delegated.approval.worktree,
          toolCallId: delegated.approval.toolCallId,
          decision,
          parentThreadId: parent.id,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Approval decision failed.");
      setResolvedApprovalIds((current) => new Set(current).add(delegated.approval.id));
      try {
        await onChanged();
      } catch {
        setError("Approval resolved. Status refresh failed; reconnect to confirm child state.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval decision failed.");
    } finally {
      setApprovalBusyId(null);
    }
  };
  const answerInput = async (delegated: DelegatedInputProjection) => {
    const answer = (inputAnswers[delegated.request.id] ?? "").trim();
    if (!answer) return;
    setInputBusyId(delegated.request.id);
    setError(null);
    try {
      const response = await fetch(`/api/provider/input-requests/${delegated.request.id}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          childThreadId: delegated.childThreadId,
          parentThreadId: parent.id,
          answer,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Child input response failed.");
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Child input response failed.");
    } finally {
      setInputBusyId(null);
    }
  };
  return (
    <>
      <section className="delegated-children" aria-labelledby={`delegated-title-${parent.id}`}>
        <div className="delegated-children-header">
          <div>
            <h3 id={`delegated-title-${parent.id}`}>Delegated conversations</h3>
            <p>Quiet status summary. Child messages and provider context stay independent.</p>
            {outcomeSummary.outcomes.length > 0 && (
              <div className="delegated-counts" aria-live="polite" aria-atomic="true">
                <span>{runningCount} working</span>
                <span>{approvalCount} approval</span>
                <span>{outcomeSummary.inputs} input</span>
                <span>{outcomeSummary.failures} failed</span>
                <span>{outcomeSummary.completed} completed</span>
              </div>
            )}
          </div>
          <div className="delegated-link-control">
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => setStartOpen(true)}
              aria-label={`Start a child conversation from ${parent.title}`}
            >
              Start child
            </Button>
            <label className="sr-only" htmlFor={`delegated-child-${parent.id}`}>
              Existing conversation to link
            </label>
            <select
              id={`delegated-child-${parent.id}`}
              value={selectedChildId}
              disabled={busy || candidates.length === 0}
              onChange={(event) => setSelectedChildId(event.target.value)}
            >
              <option value="">Link existing…</option>
              {candidates.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidateLabels.get(candidate.id)}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={busy || !selectedChildId}
              onClick={() =>
                void mutate("/api/state/delegated-conversations/link", selectedChildId)
              }
            >
              Link
            </Button>
          </div>
        </div>
        {error && (
          <p className="delegated-error" role="alert">
            {error}
          </p>
        )}
        {outcomeSummary.outcomes.length === 0 ? (
          <p className="delegated-empty">No delegated conversations linked.</p>
        ) : (
          <ul className="delegated-list">
            {outcomeSummary.outcomes.map(({ relationship, child }) => {
              const childApprovals = approvals.filter(
                (item) =>
                  item.parentThreadId === parent.id &&
                  item.childThreadId === child.id &&
                  !resolvedApprovalIds.has(item.approval.id),
              );
              const childInputs = inputs.filter(
                (item) => item.parentThreadId === parent.id && item.childThreadId === child.id,
              );
              const status =
                childApprovals.length > 0
                  ? "pending_approval"
                  : childInputs.length > 0
                    ? "awaiting_input"
                    : (child.status ?? "idle");
              if (status === "completed") {
                const outcome = outcomes.find((item) => item.childThreadId === child.id);
                return (
                  <li key={relationship.id} className="delegated-outcome completed">
                    <details>
                      <summary>
                        <strong>{child.title}</strong>
                        <span>Completed · Review outcome</span>
                      </summary>
                      <div className="delegated-outcome-body">
                        <div className="delegated-summary">
                          <span>
                            {child.projectName ?? "Unknown project"} ·{" "}
                            {providerListLabel(child.provider)}
                          </span>
                          <span className="delegated-worktree">
                            {branchFromWorktree(child.worktree)} · {child.worktree}
                          </span>
                          <p className="delegated-result">
                            {outcome?.summary ?? "Outcome summary is loading…"}
                          </p>
                        </div>
                        <Button type="button" size="sm" onClick={() => onOpen(child.id)}>
                          Open child
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate("/api/state/delegated-conversations/unlink", child.id)
                          }
                        >
                          Detach
                        </Button>
                      </div>
                    </details>
                  </li>
                );
              }
              return (
                <li key={relationship.id} className={`delegated-outcome ${status}`}>
                  <div className="delegated-summary">
                    <strong>{child.title}</strong>
                    <span>
                      {child.projectName ?? "Unknown project"} · {providerListLabel(child.provider)}
                    </span>
                    <span className="delegated-worktree">
                      {branchFromWorktree(child.worktree)} · {child.worktree}
                    </span>
                  </div>
                  <span className={`delegated-status status-${status}`}>
                    {status.replaceAll("_", " ")}
                  </span>
                  <Button type="button" size="sm" onClick={() => onOpen(child.id)}>
                    Open child
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void mutate("/api/state/delegated-conversations/unlink", child.id)
                    }
                  >
                    Detach
                  </Button>
                  {childApprovals.map((delegatedApproval) => (
                    <section
                      className="delegated-approval-card"
                      key={delegatedApproval.approval.id}
                      aria-label={`Approval required for ${child.title}: ${delegatedApproval.approval.scope.summary}`}
                    >
                      <header>
                        <strong>{delegatedApproval.approval.scope.summary}</strong>
                        <span>{delegatedApproval.approval.toolName} · one action only</span>
                      </header>
                      <dl>
                        <div>
                          <dt>Conversation</dt>
                          <dd>{child.title}</dd>
                        </div>
                        <div>
                          <dt>Project</dt>
                          <dd>{child.projectName ?? "Unknown project"}</dd>
                        </div>
                        <div>
                          <dt>Worktree</dt>
                          <dd title={delegatedApproval.approval.worktree}>
                            {delegatedApproval.approval.worktree}
                          </dd>
                        </div>
                        <div>
                          <dt>Provider</dt>
                          <dd>{providerListLabel(delegatedApproval.approval.provider)}</dd>
                        </div>
                        <div>
                          <dt>Tool</dt>
                          <dd>{delegatedApproval.approval.toolName}</dd>
                        </div>
                        <div>
                          <dt>Target</dt>
                          <dd>{delegatedApproval.approval.scope.target}</dd>
                        </div>
                        <div>
                          <dt>Expires</dt>
                          <dd>{new Date(delegatedApproval.approval.expiresAt).toLocaleString()}</dd>
                        </div>
                      </dl>
                      {delegatedApproval.approval.scope.details.length > 0 && (
                        <ul>
                          {delegatedApproval.approval.scope.details.map((detail) => (
                            <li key={detail}>{detail}</li>
                          ))}
                        </ul>
                      )}
                      <footer>
                        <Button
                          type="button"
                          size="sm"
                          disabled={approvalBusyId === delegatedApproval.approval.id}
                          onClick={() => void decideApproval(delegatedApproval, "deny")}
                        >
                          Deny
                        </Button>
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={approvalBusyId === delegatedApproval.approval.id}
                          onClick={() => void decideApproval(delegatedApproval, "allow_once")}
                        >
                          Allow once
                        </Button>
                      </footer>
                    </section>
                  ))}
                  {childInputs.map((delegatedInput) => (
                    <section
                      className="delegated-input-card"
                      key={delegatedInput.request.id}
                      aria-label={`Input required for ${child.title}: ${delegatedInput.request.question}`}
                    >
                      <header>
                        <strong>{delegatedInput.request.question}</strong>
                        <span>
                          {delegatedInput.request.responseMode === "native_resume"
                            ? `Resume routes only to ${child.title} with a fresh approval scope`
                            : `Answer routes only to ${child.title}`}
                        </span>
                      </header>
                      {delegatedInput.request.responseMode === "native_resume" &&
                      delegatedInput.request.resumeState === "unavailable" ? (
                        <p className="provider-error-hint" role="alert">
                          {delegatedInput.request.resumeError ??
                            "Native Shikigami resume is unavailable. Start a new child run to continue."}
                        </p>
                      ) : (
                        <>
                          {delegatedInput.request.recommendation && (
                            <p>Recommendation: {delegatedInput.request.recommendation}</p>
                          )}
                          {delegatedInput.request.choices.length > 0 && (
                            <div className="delegated-input-choices">
                              {delegatedInput.request.choices.map((choice) => (
                                <Button
                                  type="button"
                                  size="sm"
                                  key={choice.id}
                                  title={choice.description ?? undefined}
                                  onClick={() =>
                                    setInputAnswers((current) => ({
                                      ...current,
                                      [delegatedInput.request.id]: choice.label,
                                    }))
                                  }
                                >
                                  {choice.label}
                                </Button>
                              ))}
                            </div>
                          )}
                          <label htmlFor={`delegated-input-${delegatedInput.request.id}`}>
                            Answer for {child.title}
                          </label>
                          <textarea
                            id={`delegated-input-${delegatedInput.request.id}`}
                            maxLength={4_000}
                            readOnly={!delegatedInput.request.allowFreeForm}
                            value={inputAnswers[delegatedInput.request.id] ?? ""}
                            onChange={(event) =>
                              setInputAnswers((current) => ({
                                ...current,
                                [delegatedInput.request.id]: event.target.value,
                              }))
                            }
                          />
                          <footer>
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              disabled={
                                inputBusyId === delegatedInput.request.id ||
                                !(inputAnswers[delegatedInput.request.id] ?? "").trim()
                              }
                              onClick={() => void answerInput(delegatedInput)}
                            >
                              Send to {child.title}
                            </Button>
                          </footer>
                        </>
                      )}
                    </section>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {startOpen && (
        <StartDelegatedConversationDialog
          parent={parent}
          repository={repository}
          profiles={profiles}
          onRepositoryChanged={onRepositoryChanged}
          onClose={() => setStartOpen(false)}
          onCreated={(threadId) => {
            setStartOpen(false);
            onOpen(threadId);
            void onChanged();
          }}
        />
      )}
    </>
  );
}

export function CodeWorkbench({
  product,
  onProductChange,
  productAvailability,
  repository,
  repositoryRestoring = false,
  projects = [],
  onAddProject,
  onSelectProject,
  profiles,
  onOpenProfiles,
  onOpenPalette,
  onSelectWorktree,
  onManageWorktrees,
  onSettings,
  onProjectsChanged,
  onRepositoryChanged,
  chiseiBindingAdministrationAvailable = true,
  orchestrationThreadsBeta = false,
  showThinking = false,
  conversationOpenScroll = "latest",
  managedWorktreeLimit: managedWorktreeLimitPreference = 10,
  managedMode = false,
  managedModel,
  managedAccount,
}: {
  product: import("../../types").Product;
  onProductChange: (product: import("../../types").Product) => void;
  productAvailability?: import("../../lib/product-availability").ProductAvailability;
  repository: RepositoryMetadata | null;
  /** True while boot is reopening the last project — avoid flashing empty inbox. */
  repositoryRestoring?: boolean;
  projects?: SavedProject[];
  /** Opens path picker only when registering a new project (T3 "Add project"). */
  onAddProject: () => void;
  /** Activates a registered project by id — no directory tree. */
  onSelectProject: (projectId: string) => void;
  profiles: ClaudeProfile[];
  onOpenProfiles: (provider?: ProviderId) => void;
  onOpenPalette: () => void;
  onSelectWorktree: (path: string) => void;
  onManageWorktrees: (path?: string) => void;
  onSettings: () => void;
  onProjectsChanged?: () => Promise<void>;
  onRepositoryChanged?: (repository: RepositoryMetadata) => void;
  chiseiBindingAdministrationAvailable?: boolean;
  orchestrationThreadsBeta?: boolean;
  showThinking?: boolean;
  conversationOpenScroll?: "latest" | "remember";
  /** Preferences soft limit for managed worktrees; null means unlimited. */
  managedWorktreeLimit?: number | null;
  managedMode?: boolean;
  managedModel?: string;
  managedAccount?: ManagedAccount | null;
}) {
  const [narrowViewport, setNarrowViewport] = useState(readNarrowViewport);
  const [sidebarOpen, setSidebarOpen] = useState(readInitialSidebarOpen);
  const sidebarOpenButtonReference = useRef<HTMLButtonElement>(null);
  const mainReference = useRef<HTMLElement>(null);
  const sidebarOpenReference = useRef(sidebarOpen);
  const sidebarFocusSourceReference = useRef<"user" | "responsive" | "navigation" | "dialog">(
    "user",
  );
  const narrowViewportReference = useRef(narrowViewport);
  const previousSidebarOpenReference = useRef(sidebarOpen);
  const updateSidebarOpen = useCallback(
    (open: boolean, source: "user" | "responsive" | "navigation" | "dialog") => {
      if (sidebarOpenReference.current === open) return;
      sidebarOpenReference.current = open;
      sidebarFocusSourceReference.current = source;
      setSidebarOpen(open);
    },
    [],
  );
  const toggleSidebar = useCallback(() => {
    updateSidebarOpen(!sidebarOpenReference.current, "user");
  }, [updateSidebarOpen]);
  const closeSidebar = useCallback(() => {
    updateSidebarOpen(false, "user");
  }, [updateSidebarOpen]);
  useEffect(() => {
    persistSidebarOpen(sidebarOpen, narrowViewport);
  }, [narrowViewport, sidebarOpen]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => {
      const nextNarrowViewport = readNarrowViewport();
      if (nextNarrowViewport === narrowViewportReference.current) return;
      narrowViewportReference.current = nextNarrowViewport;
      setNarrowViewport(nextNarrowViewport);
      let nextSidebarOpen: boolean;
      try {
        nextSidebarOpen = readSidebarOpenPreference(
          window.localStorage,
          nextNarrowViewport ? MOBILE_SIDEBAR_OPEN_STORAGE_KEY : SIDEBAR_OPEN_STORAGE_KEY,
          nextNarrowViewport ? DEFAULT_MOBILE_SIDEBAR_OPEN : DEFAULT_SIDEBAR_OPEN,
        );
      } catch {
        nextSidebarOpen = nextNarrowViewport ? DEFAULT_MOBILE_SIDEBAR_OPEN : DEFAULT_SIDEBAR_OPEN;
      }
      const sidebarStateChanged = sidebarOpenReference.current !== nextSidebarOpen;
      updateSidebarOpen(nextSidebarOpen, "responsive");
      /*
       * The focus effect below restores focus only for explicit user changes.
       * Breakpoint changes should never pull focus out of the active editor.
       */
      if (!sidebarStateChanged) {
        sidebarFocusSourceReference.current = "user";
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [updateSidebarOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!matchesSidebarToggleShortcut(event) || isSidebarShortcutCaptured(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };
    // Capture before focused editors consume Mod+B for formatting or browser actions.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggleSidebar]);
  useEffect(() => {
    const wasOpen = previousSidebarOpenReference.current;
    previousSidebarOpenReference.current = sidebarOpen;
    const focusSource = sidebarFocusSourceReference.current;
    sidebarFocusSourceReference.current = "user";
    if (wasOpen === sidebarOpen || focusSource === "dialog") return;
    /*
     * Responsive breakpoint changes must not yank focus out of the active
     * editor. When the sidebar auto-collapses while focus is still inside it,
     * though, leave the hidden region so aria-hidden/inert stay honest.
     */
    if (focusSource === "responsive") {
      if (sidebarOpen) return;
      const active = document.activeElement;
      const sidebar = document.getElementById("code-sidebar");
      if (!(active instanceof HTMLElement) || !sidebar?.contains(active)) return;
      const frame = window.requestAnimationFrame(() => {
        const expandToggle = document.querySelector<HTMLElement>("[data-sidebar-open-toggle]");
        if (expandToggle) {
          expandToggle.focus({ preventScroll: true });
          return;
        }
        mainReference.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }
    const frame = window.requestAnimationFrame(() => {
      if (focusSource === "navigation") {
        mainReference.current?.focus({ preventScroll: true });
        return;
      }
      const selector = sidebarOpen
        ? "[data-sidebar-collapse-toggle]"
        : "[data-sidebar-open-toggle]";
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sidebarOpen]);
  const [chiseiCorrelationId, setChiseiCorrelationId] = useState<string | null>(null);
  useEffect(() => {
    setChiseiCorrelationId(null);
  }, [repository?.projectId]);
  const previousProduct = useRef(product);
  useEffect(() => {
    if (previousProduct.current === "chisei" && product !== "chisei") {
      setChiseiCorrelationId(null);
    }
    previousProduct.current = product;
  }, [product]);
  const [usageOpen, setUsageOpen] = useState(false);
  useEffect(() => {
    if (product !== "code") setUsageOpen(false);
  }, [product]);
  useEffect(() => {
    const inspect = (event: Event) => {
      const correlationId = (event as CustomEvent<{ correlationId?: unknown }>).detail
        ?.correlationId;
      if (typeof correlationId !== "string") return;
      setChiseiCorrelationId(correlationId);
      onProductChange("chisei");
    };
    window.addEventListener("aldunis:inspect-chisei-operation", inspect);
    return () => window.removeEventListener("aldunis:inspect-chisei-operation", inspect);
  }, [onProductChange]);
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>(() => {
    if (typeof window === "undefined") return "all";
    try {
      return window.localStorage.getItem(PROJECT_FILTER_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [changes, setChanges] = useState<ChangedFile[]>([]);
  const changesRequestSequenceReference = useRef(0);
  const [primaryChangesSignal, setPrimaryChangesSignal] = useState(0);
  const [primaryChangesThreadId, setPrimaryChangesThreadId] = useState<string | null>(null);
  const [primaryChangesMode, setPrimaryChangesMode] = useState<"review" | "deliver">("review");
  const [primaryFilesSignal, setPrimaryFilesSignal] = useState(0);
  const [secondaryChangesSignal, setSecondaryChangesSignal] = useState(0);
  const [secondaryFilesSignal, setSecondaryFilesSignal] = useState(0);
  const [pendingWorkspaceAction, setPendingWorkspaceAction] = useState<{
    threadId: string;
    mode: "review" | "deliver";
  } | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [delegatedRelationships, setDelegatedRelationships] = useState<
    DelegatedConversationRelationship[]
  >([]);
  const [delegatedOutcomes, setDelegatedOutcomes] = useState<
    DelegatedConversationOutcomeProjection[]
  >([]);
  const [delegatedApprovals, setDelegatedApprovals] = useState<DelegatedApprovalProjection[]>([]);
  const [delegatedInputs, setDelegatedInputs] = useState<DelegatedInputProjection[]>([]);
  const [showingArchived, setShowingArchived] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    conversation: ConversationSummary;
    preview: ConversationDeletionPreview;
  } | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ConversationSummary | null>(null);
  const [bulkReleaseTargets, setBulkReleaseTargets] = useState<ConversationSummary[] | null>(null);
  const [managedWorktreeCount, setManagedWorktreeCount] = useState(0);
  const [managedWorktreePaths, setManagedWorktreePaths] = useState<string[]>([]);
  const [incompleteDeletionIds, setIncompleteDeletionIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryNewKey, setPrimaryNewKey] = useState(0);
  const primaryNewKeyReference = useRef(0);
  const [repairBrief, setRepairBrief] = useState<{ projectId: string; prompt: string } | null>(
    null,
  );
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitPercent, setSplitPercent] = useState(50);
  const renameReturnFocusReference = useRef<HTMLElement | null>(null);
  const deleteReturnFocusReference = useRef<HTMLElement | null>(null);
  const releaseReturnFocusReference = useRef<HTMLElement | null>(null);
  const [restoreState, setRestoreState] = useState<"idle" | "loading" | "ready" | "failed">(() =>
    repository ? "loading" : "idle",
  );
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const splitReference = useRef<HTMLDivElement>(null);
  const restoredProjectReference = useRef<string | null>(null);
  /** Last projectId we asked the host to open for the active primary thread (dedupes async switch). */
  const requestedProjectForPrimaryRef = useRef<string | null>(null);
  const primarySelectionReference = useRef("new:0");
  const secondaryIdReference = useRef<string | null>(null);
  const primaryPaneReference = useRef<HTMLDivElement>(null);
  const secondaryPaneReference = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const startRepair = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: unknown; prompt?: unknown }>).detail;
      if (
        typeof detail?.projectId !== "string" ||
        !detail.projectId ||
        typeof detail.prompt !== "string" ||
        !detail.prompt ||
        detail.prompt.length > 8_000
      )
        return;
      onSelectProject(detail.projectId);
      onProductChange("code");
      setRepairBrief({ projectId: detail.projectId, prompt: detail.prompt });
      const nextKey = primaryNewKeyReference.current + 1;
      primaryNewKeyReference.current = nextKey;
      primarySelectionReference.current = `new:${nextKey}`;
      setPrimaryId(null);
      setPrimaryNewKey(nextKey);
      setActivePane("primary");
    };
    window.addEventListener("aldunis:start-shikigami-repair", startRepair);
    return () => window.removeEventListener("aldunis:start-shikigami-repair", startRepair);
  }, [onProductChange, onSelectProject]);
  useEffect(() => {
    try {
      window.localStorage.setItem(PROJECT_FILTER_KEY, projectFilter);
    } catch {
      /* ignore */
    }
  }, [projectFilter]);

  // Drop stale project ids left in localStorage after projects were removed or
  // the host state was rebuilt, so the inbox does not look empty while labeled
  // "All projects".
  useEffect(() => {
    if (projectFilter === "all" || projects.length === 0) return;
    if (projects.some((project) => project.id === projectFilter)) return;
    setProjectFilter("all");
  }, [projectFilter, projects]);

  // Load the inbox once (and on explicit retry). Do not re-run when the active
  // repository changes — selecting a chat must not reshuffle or reselect.
  // One coalesced /api/state/load covers both the conversation list and lifecycle
  // fields so restore does not pay for a second sequential projection round-trip.
  useEffect(() => {
    let active = true;
    setRestoreState("loading");
    const restore = async () => {
      const projection = (await loadLocalStateProjection()) as WorkbenchStateProjection;
      if (!active) return;
      const available = conversationListFromProjection(projection, null);
      // Only apply stored selection on the first successful load.
      if (restoredProjectReference.current === null) {
        const parameters = new URLSearchParams(window.location.search);
        const preferredProjectId =
          repository?.projectId ?? parameters.get("project") ?? projects[0]?.id ?? null;
        const stored = preferredProjectId
          ? window.localStorage.getItem(`aldunis.split.${preferredProjectId}`)
          : null;
        let saved: {
          primaryId?: string | null;
          secondaryId?: string | null;
          splitPercent?: number;
        } = {};
        try {
          saved = stored ? (JSON.parse(stored) as typeof saved) : {};
        } catch {
          saved = {};
        }
        const urlConversation = parameters.get("conversation");
        const restored = normalizeSplitWorkspaceState(
          {
            primaryId: urlConversation ?? saved.primaryId,
            secondaryId: parameters.get("beside") ?? saved.secondaryId,
            splitPercent: saved.splitPercent,
          },
          available[0]?.id ?? null,
        );
        setPrimaryId(restored.primaryId);
        primarySelectionReference.current = restored.primaryId ?? `new:${primaryNewKey}`;
        setSecondaryId(restored.secondaryId);
        secondaryIdReference.current = restored.secondaryId;
        setSplitPercent(restored.splitPercent);
      }
      restoredProjectReference.current = repository?.projectId ?? "inbox";
      setRestoreState("ready");
    };
    void restore().catch(() => {
      if (!active) return;
      restoredProjectReference.current = null;
      setRestoreState("failed");
    });
    return () => {
      active = false;
    };
    // Mount/retry only; repo switches must not reshuffle.
  }, [restoreAttempt]);

  // Track the bound project for split persistence without resetting the inbox selection.
  useEffect(() => {
    if (!repository) return;
    restoredProjectReference.current = repository.projectId;
  }, [repository?.projectId]);
  useEffect(() => {
    if (!repository || restoredProjectReference.current !== repository.projectId) return;
    window.localStorage.setItem(
      `aldunis.split.${repository.projectId}`,
      JSON.stringify({
        primaryId,
        secondaryId,
        splitPercent,
      }),
    );
    const parameters = new URLSearchParams(window.location.search);
    parameters.set("project", repository.projectId);
    if (primaryId) parameters.set("conversation", primaryId);
    else parameters.delete("conversation");
    if (secondaryId) parameters.set("beside", secondaryId);
    else parameters.delete("beside");
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`,
    );
  }, [primaryId, repository?.projectId, secondaryId, splitPercent]);
  useEffect(() => {
    const moveFocus = (event: KeyboardEvent) => {
      if (!secondaryId || !event.altKey || !event.shiftKey) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActivePane("primary");
        primaryPaneReference.current?.focus();
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActivePane("secondary");
        secondaryPaneReference.current?.focus();
      }
    };
    window.addEventListener("keydown", moveFocus);
    return () => window.removeEventListener("keydown", moveFocus);
  }, [secondaryId]);
  const primary = conversations.find((conversation) => conversation.id === primaryId) ?? null;
  const secondary = conversations.find((conversation) => conversation.id === secondaryId) ?? null;
  useEffect(() => {
    if (
      !pendingWorkspaceAction ||
      pendingWorkspaceAction.threadId !== primaryId ||
      !primary ||
      !repository
    ) {
      return;
    }
    const activeProjectIds = new Set([
      repository.projectId,
      ...(projects.find((project) => project.id === repository.projectId)?.memberIds ?? []),
    ]);
    if (!activeProjectIds.has(primary.projectId)) return;
    const selectedWorktree = repository.worktrees.find(
      (worktree) => worktree.path === primary.worktree,
    );
    if (
      !selectedWorktree ||
      selectedWorktree.recovery !== "available" ||
      (selectedWorktree.state !== "available" && selectedWorktree.state !== "detached")
    ) {
      setPendingWorkspaceAction(null);
      setLifecycleError(
        "The conversation worktree is no longer available. Open the conversation to inspect its recovery state.",
      );
      return;
    }
    setPendingWorkspaceAction(null);
    setPrimaryChangesThreadId(primary.id);
    setPrimaryChangesMode(pendingWorkspaceAction.mode);
    setPrimaryChangesSignal((value) => value + 1);
  }, [pendingWorkspaceAction, primary, primaryId, projects, repository]);
  const initialRepairPrompt =
    !primary && repairBrief && repairBrief.projectId === repository?.projectId
      ? repairBrief.prompt
      : undefined;
  const quietPrimaryChild =
    orchestrationThreadsBeta &&
    isQuietDelegatedChild(
      primaryId,
      activePane === "secondary" ? secondaryId : null,
      delegatedRelationships,
    );
  const quietSecondaryChild =
    orchestrationThreadsBeta &&
    isQuietDelegatedChild(
      secondaryId,
      activePane === "primary" ? primaryId : null,
      delegatedRelationships,
    );
  // Full labels also used as title tooltips when ellipsis truncates narrow dual-pane tabs.
  const paneSwitcherPrimaryLabel = `Primary · ${paneConversationLabel(
    primary,
    primaryId ? "Replace conversation" : "New conversation",
  )}`;
  const paneSwitcherSecondaryLabel = secondaryId
    ? `Secondary · ${paneConversationLabel(
        secondary,
        secondaryId.startsWith("new:") ? "New conversation" : "Replace conversation",
      )}`
    : "";
  const primarySelectionKey = primaryId ?? `new:${primaryNewKey}`;
  const activeConversation = activePane === "secondary" ? secondary : primary;
  const acceptStateProjection = (snapshot: WorkbenchProjectionSnapshot) => {
    setConversations((current) => reconcileWorkbenchConversations(snapshot.conversations, current));
    setDelegatedRelationships(snapshot.delegatedRelationships);
    setDelegatedOutcomes(snapshot.delegatedOutcomes);
    setDelegatedApprovals(snapshot.delegatedApprovals);
    setDelegatedInputs(snapshot.delegatedInputs);
    setIncompleteDeletionIds(snapshot.incompleteDeletionIds);
    if (snapshot.managedWorktreeCount !== undefined) {
      setManagedWorktreeCount(snapshot.managedWorktreeCount);
    }
    if (snapshot.managedWorktreePaths !== undefined) {
      setManagedWorktreePaths(snapshot.managedWorktreePaths);
    }
  };
  const stateProjectionSynchronizationReference = useRef<ReturnType<
    typeof createWorkbenchProjectionSynchronization
  > | null>(null);
  const refreshStateProjection = () =>
    stateProjectionSynchronizationReference.current?.refresh() ?? Promise.resolve();
  useEffect(() => {
    const synchronization = createWorkbenchProjectionSynchronization({
      load: (fresh) =>
        (fresh
          ? loadFreshLocalStateProjection()
          : loadLocalStateProjection()) as Promise<WorkbenchStateProjection>,
      createEventSource: () => new EventSource("/api/state/events"),
      accept: acceptStateProjection,
    });
    stateProjectionSynchronizationReference.current = synchronization;
    synchronization.start();
    return () => {
      synchronization.dispose();
      if (stateProjectionSynchronizationReference.current === synchronization) {
        stateProjectionSynchronizationReference.current = null;
      }
    };
    // The host hides delegated relationships while disabled, and restore retry
    // must republish a projection after a transient startup failure.
  }, [orchestrationThreadsBeta, restoreAttempt]);
  const listedConversations = useMemo(() => {
    const selectedProject =
      projectFilter === "all"
        ? null
        : (projects.find((project) => project.id === projectFilter) ?? null);
    // Unknown filter ids are treated as the full inbox until they are cleared.
    const memberIds = selectedProject
      ? new Set(selectedProject.memberIds ?? [selectedProject.id])
      : null;
    return conversations.filter((conversation) => {
      if (memberIds && !memberIds.has(conversation.projectId)) return false;
      return showingArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt;
    });
  }, [conversations, projectFilter, projects, showingArchived]);
  const [prStatusByWorktree, setPrStatusByWorktree] = useState<Map<string, BranchPrStatus>>(
    () => new Map(),
  );
  // Stabilize the PR lookup set so conversation projection churn (timestamps,
  // delegated edges) does not re-issue slow /api/delivery/pr-status/batch calls.
  const prStatusLookupKey = useMemo(() => {
    const projectRootById = new Map(projects.map((project) => [project.id, project.root]));
    for (const project of projects) {
      if (!project.memberRoots) continue;
      for (const [memberId, root] of Object.entries(project.memberRoots)) {
        projectRootById.set(memberId, root);
      }
    }
    const items = uniqueWorktreeRoots(
      listedConversations.flatMap((conversation) => {
        const root = projectRootById.get(conversation.projectId);
        if (!root || !conversation.worktree) return [];
        return [{ root, worktree: conversation.worktree }];
      }),
      BRANCH_PR_CLIENT_BATCH_LIMIT * 4,
    );
    return JSON.stringify(items);
  }, [listedConversations, projects]);
  useEffect(() => {
    let cancelled = false;
    const items = JSON.parse(prStatusLookupKey) as Array<{ root: string; worktree: string }>;
    if (items.length === 0) {
      setPrStatusByWorktree(new Map());
      return;
    }
    const refresh = async () => {
      try {
        const results: BranchPrLookupResult[] = [];
        for (const batch of chunkWorktreeRoots(items, BRANCH_PR_CLIENT_BATCH_LIMIT)) {
          const response = await fetch("/api/delivery/pr-status/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: batch }),
          });
          if (!response.ok) continue;
          const body = (await response.json()) as {
            results?: BranchPrLookupResult[];
            error?: string;
          };
          if (Array.isArray(body.results)) results.push(...body.results);
        }
        if (cancelled) return;
        setPrStatusByWorktree(indexBranchPrResults(results));
      } catch {
        // Soft-fail: missing gh or network issues leave rows without PR chrome.
      }
    };
    // Debounce: restore can still settle the lookup key a few times; one delayed
    // batch is enough for sidebar PR chrome.
    const debounceTimer = window.setTimeout(() => void refresh(), 250);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      window.clearInterval(timer);
    };
  }, [prStatusLookupKey]);
  const worktreeLimit = managedWorktreeLimitPreference;
  const postLifecycle = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Conversation lifecycle action failed.");
    await refreshStateProjection();
    return result;
  };
  const manageConversation = async (
    conversation: ConversationSummary,
    action: "rename" | "pin" | "archive" | "restore" | "delete",
  ) => {
    setLifecycleError(null);
    try {
      if (action === "rename") {
        const active = document.activeElement;
        renameReturnFocusReference.current =
          active instanceof HTMLElement
            ? (active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null)
            : null;
        setRenameTarget(conversation);
      } else if (action === "pin") {
        await postLifecycle("/api/state/conversations/pin", {
          threadId: conversation.id,
          pinned: !conversation.pinnedAt,
        });
      } else if (action === "archive" || action === "restore") {
        await postLifecycle(`/api/state/conversations/${action}`, { threadId: conversation.id });
        if (action === "archive") {
          if (primaryId === conversation.id) setPrimaryId(null);
          if (secondaryId === conversation.id) setSecondaryId(null);
        }
      } else {
        const active = document.activeElement;
        deleteReturnFocusReference.current =
          active instanceof HTMLElement
            ? (active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null)
            : null;
        const previewResponse = await fetch("/api/state/conversations/delete/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: conversation.id }),
        });
        const preview = (await previewResponse.json()) as {
          affectedRecords?: Record<string, number>;
          excluded?: string[];
          error?: string;
        };
        if (!previewResponse.ok) throw new Error(preview.error ?? "Deletion preview failed.");
        setDeleteTarget({ conversation, preview });
      }
    } catch (error) {
      setLifecycleError(
        error instanceof Error ? error.message : "Conversation lifecycle action failed.",
      );
    }
  };
  const worktreeForActive = (() => {
    if (!repository) return null;
    const candidate = activeConversation?.worktree ?? repository.selectedWorktree;
    if (!candidate) return null;
    return repository.worktrees.some((worktree) => worktree.path === candidate)
      ? candidate
      : repository.selectedWorktree;
  })();
  const refresh = async (options: { fresh?: boolean } = {}) => {
    if (!repository || !worktreeForActive) {
      changesRequestSequenceReference.current += 1;
      setChanges([]);
      return;
    }
    const sequence = ++changesRequestSequenceReference.current;
    try {
      // Boot shares inflight with PaneConversation; explicit refreshes force-fresh
      // so post-mutation snapshots are not reused. Sequence drops stale completions.
      const load = options.fresh ? loadFreshChangedFiles : loadChangedFiles;
      const files = await load({
        root: repository.root,
        worktree: worktreeForActive,
      });
      if (sequence !== changesRequestSequenceReference.current) return;
      setChanges(files);
    } catch {
      if (sequence !== changesRequestSequenceReference.current) return;
      setChanges([]);
    }
  };
  useEffect(() => {
    void refresh();
  }, [worktreeForActive, repository?.root, repository?.selectedWorktree]);
  // URL/local restore can pair a conversation with the wrong open repository.
  // Activate the thread's project so runs/tools bind to the correct root.
  useEffect(() => {
    if (!primaryId || restoreState !== "ready") return;
    const thread = conversations.find((item) => item.id === primaryId);
    if (!thread) {
      requestedProjectForPrimaryRef.current = null;
      return;
    }
    const activeIds = new Set(
      [
        repository?.projectId,
        ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
      ].filter(Boolean) as string[],
    );
    if (activeIds.has(thread.projectId)) {
      requestedProjectForPrimaryRef.current = thread.projectId;
      return;
    }
    // Dedup: async openRepository does not update projectId immediately.
    if (requestedProjectForPrimaryRef.current === thread.projectId) return;
    requestedProjectForPrimaryRef.current = thread.projectId;
    onSelectProject(thread.projectId);
  }, [conversations, onSelectProject, primaryId, projects, repository?.projectId, restoreState]);
  const repositoryFor = (conversation: ConversationSummary | null) => {
    if (!repository) return null;
    if (!conversation?.worktree) return repository;
    // Never stamp a foreign worktree onto the open root — that causes /api/changes
    // 403s and a disabled composer while project switch is still in flight.
    const known = repository.worktrees.some((worktree) => worktree.path === conversation.worktree);
    if (!known) return repository;
    return {
      ...repository,
      selectedWorktree: conversation.worktree,
      name: conversation.projectName ?? repository.name,
    };
  };
  const repositoryForDelegatedStart = (conversation: ConversationSummary | null) => {
    if (!repository || !conversation) return null;
    const activeProjectIds = new Set([
      repository.projectId,
      ...(projects.find((project) => project.id === repository.projectId)?.memberIds ?? []),
    ]);
    if (!activeProjectIds.has(conversation.projectId)) return null;
    if (!repository.worktrees.some((worktree) => worktree.path === conversation.worktree))
      return null;
    return repositoryFor(conversation);
  };
  const openBeside = (id?: string) => {
    // Prefer an explicit id (thread-row Beside). Topbar Open beside should stay in the
    // active project — not open a random foreign-worktree thread that cannot send.
    const sameProjectIds = new Set(
      [
        repository?.projectId,
        ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
        primary?.projectId,
      ].filter(Boolean) as string[],
    );
    const sameProjectOther = conversations.find(
      (conversation) =>
        conversation.id !== primaryId &&
        !conversation.archivedAt &&
        !conversation.settledAt &&
        (sameProjectIds.size === 0 || sameProjectIds.has(conversation.projectId)),
    );
    const candidate = id ?? sameProjectOther?.id ?? `new:${crypto.randomUUID()}`;
    secondaryIdReference.current = candidate;
    setSecondaryId(candidate);
    setActivePane("secondary");
  };
  const openConversation = useCallback(
    (id: string, selectedConversation?: ConversationSummary) => {
      setPendingWorkspaceAction(null);
      setPrimaryChangesSignal(0);
      setPrimaryChangesThreadId(null);
      const thread =
        conversations.find((item) => item.id === id) ??
        (selectedConversation?.id === id ? selectedConversation : undefined);
      if (selectedConversation?.id === id) {
        setConversations((current) => {
          const existing = current.findIndex((item) => item.id === id);
          if (existing < 0) return [selectedConversation, ...current];
          return current.map((item, index) =>
            index === existing ? { ...item, ...selectedConversation } : item,
          );
        });
      }
      // Activate the thread's repository for runs/tools, but do not change the
      // project chip filter — inbox "All" must stay on All when clicking a chat.
      if (thread) {
        const activeIds = new Set(
          [
            repository?.projectId,
            ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
          ].filter(Boolean) as string[],
        );
        if (!activeIds.has(thread.projectId)) {
          onSelectProject(thread.projectId);
        }
      }
      primarySelectionReference.current = id;
      setPrimaryId(id);
      if (secondaryIdReference.current === id) {
        secondaryIdReference.current = null;
        setSecondaryId(null);
      }
      setActivePane("primary");
      // Patch visit locally — do not reload/resort the inbox on every selection.
      const visitedAt = new Date().toISOString();
      setConversations((current) =>
        current.map((item) => (item.id === id ? { ...item, lastVisitedAt: visitedAt } : item)),
      );
      void fetch("/api/state/conversations/visit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: id }),
      }).catch(() => undefined);
    },
    [conversations, onSelectProject, projects, repository?.projectId],
  );
  const consumePrimaryChangesRequest = useCallback(
    (signal: number) => {
      setPrimaryChangesSignal((current) => (current === signal ? 0 : current));
      setPrimaryChangesThreadId((current) => (current === primaryId ? null : current));
    },
    [primaryId],
  );
  // Thread search lives outside the workbench shell; open hits via shared event.
  useEffect(() => {
    const onOpenFromSearch = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          threadId?: string;
          conversation?: ConversationSummary;
          action?: "open" | "review_changes";
        }>
      ).detail;
      const threadId = detail?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) {
        openConversation(
          threadId,
          detail.conversation?.id === threadId ? detail.conversation : undefined,
        );
        if (detail.action === "review_changes") {
          setPendingWorkspaceAction({ threadId, mode: "review" });
        }
      }
    };
    window.addEventListener("aldunis:open-conversation", onOpenFromSearch);
    return () => window.removeEventListener("aldunis:open-conversation", onOpenFromSearch);
  }, [openConversation]);
  useEffect(() => {
    const showArchived = () => setShowingArchived(true);
    window.addEventListener("aldunis:show-archived", showArchived);
    return () => window.removeEventListener("aldunis:show-archived", showArchived);
  }, []);
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = splitReference.current;
    if (!element) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      setSplitPercent(clampSplitPercent(((pointer.clientX - bounds.left) / bounds.width) * 100));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  const closeSidebarAfterMobileNavigation = useCallback(() => {
    if (narrowViewport) updateSidebarOpen(false, "navigation");
  }, [narrowViewport, updateSidebarOpen]);
  const closeSidebarBeforeMobileDialog = useCallback(() => {
    if (narrowViewport) updateSidebarOpen(false, "dialog");
  }, [narrowViewport, updateSidebarOpen]);
  return (
    <>
      <div
        className="desktop-titlebar"
        data-sidebar-state={sidebarOpen ? "expanded" : "collapsed"}
        aria-hidden="true"
      />
      <CodeSidebar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onRequestClose={narrowViewport ? closeSidebar : undefined}
        product={product}
        onProductChange={(nextProduct) => {
          onProductChange(nextProduct);
          closeSidebarAfterMobileNavigation();
        }}
        productAvailability={productAvailability}
        repository={repository}
        repositoryRestoring={repositoryRestoring}
        projects={projects}
        projectFilter={projectFilter}
        onProjectFilterChange={(filter) => {
          setProjectFilter(filter);
          if (filter === "all") closeSidebarAfterMobileNavigation();
        }}
        onAddProject={() => {
          onAddProject();
          closeSidebarBeforeMobileDialog();
        }}
        onSelectProject={(projectId) => {
          onSelectProject(projectId);
          closeSidebarAfterMobileNavigation();
        }}
        changes={changes}
        onShowChanges={() => {
          void refresh({ fresh: true });
          if (activePane === "secondary") setSecondaryChangesSignal((value) => value + 1);
          else setPrimaryChangesSignal((value) => value + 1);
          closeSidebarAfterMobileNavigation();
        }}
        onBrowseFiles={() => {
          if (activePane === "secondary") setSecondaryFilesSignal((value) => value + 1);
          else setPrimaryFilesSignal((value) => value + 1);
          closeSidebarAfterMobileNavigation();
        }}
        onOpenPalette={() => {
          onOpenPalette();
          closeSidebarBeforeMobileDialog();
        }}
        onShowUsage={() => {
          setUsageOpen(true);
          closeSidebarAfterMobileNavigation();
        }}
        conversations={listedConversations}
        prStatusByWorktree={prStatusByWorktree}
        primaryConversationId={primaryId}
        secondaryConversationId={secondaryId}
        onOpenConversation={(id) => {
          setUsageOpen(false);
          openConversation(id);
          closeSidebarAfterMobileNavigation();
        }}
        onOpenBeside={(id) => {
          setUsageOpen(false);
          openBeside(id);
          closeSidebarAfterMobileNavigation();
        }}
        onNewConversation={() => {
          setUsageOpen(false);
          if (!repository && projects.length === 0) closeSidebarBeforeMobileDialog();
          else closeSidebarAfterMobileNavigation();
          // New thread uses the active/filter project for runs — never opens a path tree,
          // and never rewrites the chip filter (especially "All").
          if (projectFilter !== "all") {
            onSelectProject(projectFilter);
          } else if (!repository) {
            if (projects[0]) onSelectProject(projects[0].id);
            else {
              onAddProject();
              return;
            }
          }
          const nextPrimaryKey = primaryNewKey + 1;
          primaryNewKeyReference.current = nextPrimaryKey;
          primarySelectionReference.current = `new:${nextPrimaryKey}`;
          setRepairBrief(null);
          setPrimaryId(null);
          setPrimaryNewKey(nextPrimaryKey);
          if (secondaryId?.startsWith("new:")) {
            secondaryIdReference.current = null;
            setSecondaryId(null);
          }
          setActivePane("primary");
        }}
        onSelectWorktree={(path) => {
          onSelectWorktree(path);
          closeSidebarAfterMobileNavigation();
        }}
        onManageWorktrees={(path) => {
          onManageWorktrees(path);
          closeSidebarBeforeMobileDialog();
        }}
        showingArchived={showingArchived}
        onToggleArchived={() => setShowingArchived((value) => !value)}
        onConversationAction={(conversation, action) => {
          void manageConversation(conversation, action);
        }}
        onSettle={(conversation) => {
          void postLifecycle("/api/state/conversations/settle", {
            threadId: conversation.id,
          }).catch((error: unknown) =>
            setLifecycleError(error instanceof Error ? error.message : "Settle failed."),
          );
        }}
        onSnooze={(conversation, preset) => {
          void postLifecycle("/api/state/conversations/snooze", {
            threadId: conversation.id,
            snoozedUntil: preset.snoozedUntil,
          }).catch((error: unknown) =>
            setLifecycleError(error instanceof Error ? error.message : "Snooze failed."),
          );
        }}
        onUnsettle={(conversation) => {
          void postLifecycle("/api/state/conversations/unsettle", {
            threadId: conversation.id,
          }).catch((error: unknown) =>
            setLifecycleError(error instanceof Error ? error.message : "Unsettle failed."),
          );
        }}
        onUnsnooze={(conversation) => {
          void postLifecycle("/api/state/conversations/unsnooze", {
            threadId: conversation.id,
          }).catch((error: unknown) =>
            setLifecycleError(error instanceof Error ? error.message : "Unsnooze failed."),
          );
        }}
        onReleaseWorktree={(conversation) => {
          const active = document.activeElement;
          releaseReturnFocusReference.current = active instanceof HTMLElement ? active : null;
          setBulkReleaseTargets(null);
          setReleaseTarget(conversation);
        }}
        onReleaseSettledWorktrees={(conversations) => {
          if (conversations.length === 0) return;
          const active = document.activeElement;
          releaseReturnFocusReference.current = active instanceof HTMLElement ? active : null;
          setReleaseTarget(null);
          setBulkReleaseTargets(conversations);
        }}
        worktreeLimit={worktreeLimit}
        managedWorktreeCount={managedWorktreeCount}
        managedWorktreePaths={managedWorktreePaths}
        managedAccount={managedAccount}
        onSettings={() => {
          onSettings();
          closeSidebarBeforeMobileDialog();
        }}
      />
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={closeSidebar}
        />
      )}
      {!sidebarOpen && (
        <button
          ref={sidebarOpenButtonReference}
          type="button"
          className="sidebar-toggle sidebar-toggle--open"
          data-sidebar-open-toggle
          aria-controls="code-sidebar"
          aria-expanded={sidebarOpen}
          aria-keyshortcuts="Meta+B Control+B"
          aria-label="Expand sidebar"
          title={`Expand sidebar (${SIDEBAR_TOGGLE_SHORTCUT_LABEL})`}
          onClick={toggleSidebar}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
            <path d="M19 5v14" />
          </svg>
        </button>
      )}
      <main
        ref={mainReference}
        className="main"
        data-sidebar-state={sidebarOpen ? "expanded" : "collapsed"}
        inert={narrowViewport && sidebarOpen}
        tabIndex={-1}
      >
        {product !== "code" ? (
          <DomainPage
            product={product as Exclude<import("../../types").Product, "code">}
            projects={projects}
            selectedProjectId={repository?.projectId ?? null}
            onProjectsChanged={onProjectsChanged}
            chiseiBindingAdministrationAvailable={chiseiBindingAdministrationAvailable}
            chiseiCorrelationId={chiseiCorrelationId}
            repository={repository}
          />
        ) : usageOpen ? (
          <UsagePage onBack={() => setUsageOpen(false)} />
        ) : (
          <div
            className="code-view conversation-workspace"
            data-active-pane={activePane}
            aria-label="Conversation workspace"
          >
            {lifecycleError && (
              <div className="workspace-state error" role="alert">
                <span>{lifecycleError}</span>
                <CloseButton
                  onClick={() => setLifecycleError(null)}
                  label="Dismiss lifecycle error"
                />
              </div>
            )}
            {incompleteDeletionIds.map((threadId) => {
              // Prefer title · provider over a raw UUID in the recovery banner.
              const conversation = conversations.find((item) => item.id === threadId);
              const deletionLabel = conversation
                ? paneConversationLabel(conversation, "conversation")
                : `conversation ${threadId.slice(0, 8)}`;
              return (
                <div className="workspace-state error" role="alert" key={threadId}>
                  <span>Deletion of “{deletionLabel}” is incomplete.</span>
                  <Button
                    type="button"
                    size="sm"
                    aria-label={`Retry incomplete deletion of ${deletionLabel}`}
                    onClick={() => {
                      void postLifecycle("/api/state/conversations/delete", {
                        threadId,
                        confirm: true,
                      })
                        .then(() =>
                          setIncompleteDeletionIds((ids) => ids.filter((id) => id !== threadId)),
                        )
                        .catch((error: unknown) =>
                          setLifecycleError(
                            error instanceof Error
                              ? error.message
                              : "Conversation deletion retry failed.",
                          ),
                        );
                    }}
                  >
                    Retry deletion
                  </Button>
                </div>
              );
            })}
            {restoreState === "loading" && (
              <div className="workspace-state" role="status">
                Restoring local conversations…
              </div>
            )}
            {restoreState === "failed" && (
              <div className="workspace-state failed" role="alert">
                <span>Local conversation history could not be loaded.</span>
                <Button
                  type="button"
                  size="sm"
                  aria-label="Retry loading local conversation history"
                  onClick={() => setRestoreAttempt((value) => value + 1)}
                >
                  Retry
                </Button>
              </div>
            )}
            {(restoreState === "ready" || !repository) && (
              <>
                {secondaryId && (
                  <nav className="pane-switcher" aria-label="Visible conversation pane">
                    <button
                      type="button"
                      className={activePane === "primary" ? "active" : ""}
                      aria-current={activePane === "primary" ? "true" : undefined}
                      title={paneSwitcherPrimaryLabel}
                      onClick={() => setActivePane("primary")}
                    >
                      {paneSwitcherPrimaryLabel}
                    </button>
                    <button
                      type="button"
                      className={activePane === "secondary" ? "active" : ""}
                      aria-current={activePane === "secondary" ? "true" : undefined}
                      title={paneSwitcherSecondaryLabel}
                      onClick={() => setActivePane("secondary")}
                    >
                      {paneSwitcherSecondaryLabel}
                    </button>
                  </nav>
                )}
                <div
                  className={`split-workspace ${secondaryId ? "split" : ""}`}
                  ref={splitReference}
                  style={
                    secondaryId
                      ? { gridTemplateColumns: `${splitPercent}% 6px minmax(0, 1fr)` }
                      : undefined
                  }
                >
                  <div
                    className="conversation-pane primary-pane"
                    tabIndex={-1}
                    ref={primaryPaneReference}
                    onFocusCapture={() => setActivePane("primary")}
                  >
                    {primaryId && !primary ? (
                      <MissingConversation
                        pane="primary"
                        conversations={conversations.filter((item) => item.id !== secondaryId)}
                        onReplace={(id) => {
                          primarySelectionReference.current = id ?? `new:${primaryNewKey + 1}`;
                          setPrimaryId(id);
                        }}
                      />
                    ) : (
                      <>
                        {orchestrationThreadsBeta && primary && (
                          <DelegatedChildrenPanel
                            parent={primary}
                            repository={repositoryForDelegatedStart(primary)}
                            profiles={profiles}
                            onRepositoryChanged={onRepositoryChanged}
                            conversations={conversations}
                            relationships={delegatedRelationships}
                            outcomes={delegatedOutcomes}
                            approvals={delegatedApprovals}
                            inputs={delegatedInputs}
                            onOpen={openConversation}
                            onChanged={refreshStateProjection}
                          />
                        )}
                        <PaneConversation
                          key={primaryId ?? `new-primary:${primaryNewKey}`}
                          repository={repositoryFor(primary)}
                          conversation={primary}
                          pane="primary"
                          active={activePane === "primary"}
                          quietDelegatedChild={quietPrimaryChild}
                          projects={projects}
                          projectConversations={conversations}
                          promptStashOperatorKey={
                            managedAccount
                              ? [
                                  managedAccount.tenantId,
                                  managedAccount.displayName,
                                  managedAccount.sessionExpiresAt ?? "",
                                  managedAccount.assertionExpiresAt,
                                ].join("\0")
                              : null
                          }
                          onAddProject={onAddProject}
                          onSelectProject={onSelectProject}
                          profiles={profiles}
                          showThinking={showThinking}
                          conversationOpenScroll={conversationOpenScroll}
                          managedMode={managedMode}
                          managedModel={managedModel}
                          initialPrompt={initialRepairPrompt}
                          initialProvider={initialRepairPrompt ? "shikigami" : undefined}
                          onOpenRepository={onAddProject}
                          onOpenProfiles={onOpenProfiles}
                          onRepositoryChanged={onRepositoryChanged}
                          onSelectWorktree={onSelectWorktree}
                          onManageWorktrees={onManageWorktrees}
                          onOpenBeside={() => openBeside()}
                          showOpenBeside={!secondaryId}
                          showChangesSignal={primaryChangesSignal}
                          showChangesThreadId={primaryChangesThreadId}
                          onChangesRequestConsumed={consumePrimaryChangesRequest}
                          showChangesMode={primaryChangesMode}
                          showFilesSignal={primaryFilesSignal}
                          onConversationAvailable={(id) => {
                            if (primarySelectionReference.current === primarySelectionKey) {
                              primarySelectionReference.current = id;
                              setPrimaryId(id);
                              setRepairBrief(null);
                            }
                            void refreshStateProjection().catch(() => {});
                          }}
                        />
                      </>
                    )}
                  </div>
                  {secondaryId && (
                    <>
                      <div
                        className="split-divider"
                        role="separator"
                        aria-label="Resize conversation panes"
                        aria-orientation="vertical"
                        aria-valuemin={30}
                        aria-valuemax={70}
                        aria-valuenow={Math.round(splitPercent)}
                        aria-valuetext={`${Math.round(splitPercent)} percent primary width`}
                        tabIndex={0}
                        onPointerDown={resize}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowLeft")
                            setSplitPercent((value) => Math.max(30, value - 5));
                          if (event.key === "ArrowRight")
                            setSplitPercent((value) => Math.min(70, value + 5));
                        }}
                      />
                      <div
                        className="conversation-pane secondary-pane"
                        tabIndex={-1}
                        ref={secondaryPaneReference}
                        onFocusCapture={() => setActivePane("secondary")}
                      >
                        {!secondary && !secondaryId.startsWith("new:") ? (
                          <MissingConversation
                            pane="secondary"
                            conversations={conversations.filter((item) => item.id !== primaryId)}
                            onReplace={setSecondaryId}
                            onClose={() => setSecondaryId(null)}
                          />
                        ) : (
                          <>
                            {orchestrationThreadsBeta && secondary && (
                              <DelegatedChildrenPanel
                                parent={secondary}
                                repository={repositoryForDelegatedStart(secondary)}
                                profiles={profiles}
                                onRepositoryChanged={onRepositoryChanged}
                                conversations={conversations}
                                relationships={delegatedRelationships}
                                outcomes={delegatedOutcomes}
                                approvals={delegatedApprovals}
                                inputs={delegatedInputs}
                                onOpen={openConversation}
                                onChanged={refreshStateProjection}
                              />
                            )}
                            <PaneConversation
                              key={secondaryId}
                              repository={repositoryFor(secondary)}
                              conversation={secondary}
                              pane="secondary"
                              active={activePane === "secondary"}
                              quietDelegatedChild={quietSecondaryChild}
                              projects={projects}
                              projectConversations={conversations}
                              promptStashOperatorKey={
                                managedAccount
                                  ? [
                                      managedAccount.tenantId,
                                      managedAccount.displayName,
                                      managedAccount.sessionExpiresAt ?? "",
                                      managedAccount.assertionExpiresAt,
                                    ].join("\0")
                                  : null
                              }
                              onAddProject={onAddProject}
                              onSelectProject={onSelectProject}
                              profiles={profiles}
                              showThinking={showThinking}
                              conversationOpenScroll={conversationOpenScroll}
                              managedMode={managedMode}
                              managedModel={managedModel}
                              onOpenRepository={onAddProject}
                              onOpenProfiles={onOpenProfiles}
                              onRepositoryChanged={onRepositoryChanged}
                              onSelectWorktree={onSelectWorktree}
                              onManageWorktrees={onManageWorktrees}
                              onOpenBeside={() => openBeside()}
                              onClosePane={() => {
                                secondaryIdReference.current = null;
                                setSecondaryId(null);
                                setActivePane("primary");
                              }}
                              showChangesSignal={secondaryChangesSignal}
                              showFilesSignal={secondaryFilesSignal}
                              onConversationAvailable={(id) => {
                                if (secondaryIdReference.current !== secondaryId) return;
                                secondaryIdReference.current = id;
                                setSecondaryId(id);
                                void refreshStateProjection().catch(() => {});
                              }}
                            />
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>
      {renameTarget && (
        <RenameConversationDialog
          conversation={renameTarget}
          onClose={() => {
            setRenameTarget(null);
            const returnFocus = renameReturnFocusReference.current;
            renameReturnFocusReference.current = null;
            window.requestAnimationFrame(() => returnFocus?.focus());
          }}
          onRename={async (title) => {
            await postLifecycle("/api/state/conversations/rename", {
              threadId: renameTarget.id,
              title,
            });
          }}
        />
      )}
      {deleteTarget && (
        <DeleteConversationDialog
          conversation={deleteTarget.conversation}
          preview={deleteTarget.preview}
          onClose={() => {
            setDeleteTarget(null);
            const returnFocus = deleteReturnFocusReference.current;
            deleteReturnFocusReference.current = null;
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => returnFocus?.focus());
            });
          }}
          onDelete={async () => {
            const conversation = deleteTarget.conversation;
            const response = await fetch("/api/state/conversations/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ threadId: conversation.id, confirm: true }),
            });
            const result = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(result.error ?? "Conversation deletion failed.");
            if (primaryId === conversation.id) setPrimaryId(null);
            if (secondaryId === conversation.id) setSecondaryId(null);
            setConversations((current) => current.filter((item) => item.id !== conversation.id));
            void refreshStateProjection().catch(() =>
              setLifecycleError(
                "Conversation deleted, but the conversation list could not be refreshed.",
              ),
            );
          }}
        />
      )}
      {releaseTarget && (
        <ReleaseWorktreeDialog
          title={releaseTarget.title}
          provider={
            releaseTarget.provider ? providerListLabel(releaseTarget.provider) : "Unknown provider"
          }
          worktree={releaseTarget.worktree}
          onClose={() => {
            setReleaseTarget(null);
            const returnFocus = releaseReturnFocusReference.current;
            releaseReturnFocusReference.current = null;
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() => returnFocus?.focus()),
            );
          }}
          onConfirm={async () => {
            await postLifecycle("/api/state/conversations/release-worktree", {
              threadId: releaseTarget.id,
              confirm: true,
            });
          }}
        />
      )}
      {bulkReleaseTargets && bulkReleaseTargets.length > 0 && (
        <ReleaseWorktreeDialog
          title={`${bulkReleaseTargets.length} settled conversations`}
          provider="Aldunis-managed worktrees"
          bulkCount={bulkReleaseTargets.length}
          onClose={() => {
            setBulkReleaseTargets(null);
            const returnFocus = releaseReturnFocusReference.current;
            releaseReturnFocusReference.current = null;
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() => returnFocus?.focus()),
            );
          }}
          onConfirm={async () => {
            const targets = bulkReleaseTargets;
            const failures: string[] = [];
            let released = 0;
            for (const conversation of targets) {
              try {
                const response = await fetch("/api/state/conversations/release-worktree", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ threadId: conversation.id, confirm: true }),
                });
                const result = (await response.json()) as {
                  error?: string;
                  released?: boolean;
                  managedWorktreeCount?: number;
                };
                if (!response.ok) {
                  throw new Error(result.error ?? "Managed worktree release failed.");
                }
                if (result.released) released += 1;
                if (typeof result.managedWorktreeCount === "number") {
                  setManagedWorktreeCount(result.managedWorktreeCount);
                }
              } catch (reason: unknown) {
                const message =
                  reason instanceof Error ? reason.message : "Managed worktree release failed.";
                failures.push(`${conversation.title}: ${message}`);
              }
            }
            try {
              await refreshStateProjection();
            } catch {
              /* meter already updated from release responses when available */
            }
            if (failures.length > 0) {
              const preview = failures.slice(0, 3).join("; ");
              const more = failures.length > 3 ? ` (+${failures.length - 3} more)` : "";
              throw new Error(`Released ${released} of ${targets.length}. ${preview}${more}`);
            }
          }}
        />
      )}
    </>
  );
}
