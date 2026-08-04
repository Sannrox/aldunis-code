import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../../types";
import { clampSplitPercent, normalizeSplitWorkspaceState } from "../../split-workspace";
import { CodeSidebar, type ProjectFilter } from "./sidebar";
import { PaneConversation } from "./pane-conversation";
import { MissingConversation } from "./missing-conversation";
import {
  branchFromWorktree,
  conversationListFromProjection,
  loadConversationList,
  type ConversationListProjection,
} from "./conversation-list";
import {
  isQuietDelegatedChild,
  summarizeDelegatedOutcomes,
} from "./delegated-outcomes";
import { Icon } from "../../components/icon";
import { Button, CloseButton } from "../../components/ui";
import { providerListLabel } from "../../lib/provider-readiness";
import {
  DEFAULT_SIDEBAR_OPEN,
  matchesSidebarToggleShortcut,
  readSidebarOpenPreference,
  SIDEBAR_TOGGLE_SHORTCUT_LABEL,
  writeSidebarOpenPreference,
} from "../../lib/sidebar-state";
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

function readInitialSidebarOpen(): boolean {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_OPEN;
  try {
    return readSidebarOpenPreference(window.localStorage);
  } catch {
    return DEFAULT_SIDEBAR_OPEN;
  }
}

function persistSidebarOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    writeSidebarOpenPreference(window.localStorage, open);
  } catch {
    /* Ignore unavailable browser storage. */
  }
}

function isSidebarShortcutCaptured(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target.closest("[data-keybinding-capture]") !== null
    || target.matches("input, textarea, select");
}

export function isThreadStatusEvent(value: unknown): value is {
  threadId: string;
  status: string;
  at: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.threadId === "string"
    && typeof event.status === "string"
    && typeof event.at === "string";
}

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
  const [resolvedApprovalIds, setResolvedApprovalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const outcomeSummary = summarizeDelegatedOutcomes(parent.id, conversations, relationships);
  const approvalChildIds = new Set(
    approvals
      .filter((item) => (
        item.parentThreadId === parent.id
        && !resolvedApprovalIds.has(item.approval.id)
      ))
      .map((item) => item.childThreadId),
  );
  const approvalCount = new Set([
    ...outcomeSummary.outcomes
      .filter(({ child }) => child.status === "pending_approval")
      .map(({ child }) => child.id),
    ...approvalChildIds,
  ]).size;
  const runningCount = outcomeSummary.outcomes.filter(({ child }) => (
    child.status === "running" && !approvalChildIds.has(child.id)
  )).length;
  const unavailableChildIds = new Set(relationships.map((item) => item.childThreadId));
  const ancestorIds = delegatedConversationAncestorIds(relationships, parent.id);
  const candidates = conversations.filter((item) => (
    item.id !== parent.id
    && !item.archivedAt
    && !unavailableChildIds.has(item.id)
    && !ancestorIds.has(item.id)
  ));
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
      const body = await response.json() as { error?: string };
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
      const response = await fetch(
        `/api/provider/approvals/${delegated.approval.id}/decide`,
        {
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
        },
      );
      const body = await response.json() as { error?: string };
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
      const response = await fetch(
        `/api/provider/input-requests/${delegated.request.id}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            childThreadId: delegated.childThreadId,
            parentThreadId: parent.id,
            answer,
          }),
        },
      );
      const body = await response.json() as { error?: string };
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
            onClick={() => void mutate(
              "/api/state/delegated-conversations/link",
              selectedChildId,
            )}
          >
            Link
          </Button>
        </div>
      </div>
      {error && <p className="delegated-error" role="alert">{error}</p>}
      {outcomeSummary.outcomes.length === 0 ? (
        <p className="delegated-empty">No delegated conversations linked.</p>
      ) : (
        <ul className="delegated-list">
          {outcomeSummary.outcomes.map(({ relationship, child }) => {
            const childApprovals = approvals.filter((item) => (
              item.parentThreadId === parent.id
              && item.childThreadId === child.id
              && !resolvedApprovalIds.has(item.approval.id)
            ));
            const childInputs = inputs.filter((item) => (
              item.parentThreadId === parent.id && item.childThreadId === child.id
            ));
            const status = childApprovals.length > 0
              ? "pending_approval"
              : childInputs.length > 0
                ? "awaiting_input"
              : child.status ?? "idle";
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
                        <span>{child.projectName ?? "Unknown project"} · {providerListLabel(child.provider)}</span>
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
                        onClick={() => void mutate(
                          "/api/state/delegated-conversations/unlink",
                          child.id,
                        )}
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
                  <span>{child.projectName ?? "Unknown project"} · {providerListLabel(child.provider)}</span>
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
                  onClick={() => void mutate(
                    "/api/state/delegated-conversations/unlink",
                    child.id,
                  )}
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
                      <div><dt>Conversation</dt><dd>{child.title}</dd></div>
                      <div><dt>Project</dt><dd>{child.projectName ?? "Unknown project"}</dd></div>
                      <div><dt>Worktree</dt><dd title={delegatedApproval.approval.worktree}>{delegatedApproval.approval.worktree}</dd></div>
                      <div><dt>Provider</dt><dd>{providerListLabel(delegatedApproval.approval.provider)}</dd></div>
                      <div><dt>Tool</dt><dd>{delegatedApproval.approval.toolName}</dd></div>
                      <div><dt>Target</dt><dd>{delegatedApproval.approval.scope.target}</dd></div>
                      <div><dt>Expires</dt><dd>{new Date(delegatedApproval.approval.expiresAt).toLocaleString()}</dd></div>
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
                    {delegatedInput.request.responseMode === "native_resume"
                      && delegatedInput.request.resumeState === "unavailable" ? (
                        <p className="provider-error-hint" role="alert">
                          {delegatedInput.request.resumeError
                            ?? "Native Shikigami resume is unavailable. Start a new child run to continue."}
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
                                  onClick={() => setInputAnswers((current) => ({
                                    ...current,
                                    [delegatedInput.request.id]: choice.label,
                                  }))}
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
                            onChange={(event) => setInputAnswers((current) => ({
                              ...current,
                              [delegatedInput.request.id]: event.target.value,
                            }))}
                          />
                          <footer>
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              disabled={
                                inputBusyId === delegatedInput.request.id
                                || !(inputAnswers[delegatedInput.request.id] ?? "").trim()
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
  managedMode?: boolean;
  managedModel?: string;
  managedAccount?: ManagedAccount | null;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(readInitialSidebarOpen);
  const sidebarOpenButtonReference = useRef<HTMLButtonElement>(null);
  const previousSidebarOpenReference = useRef(sidebarOpen);
  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  useEffect(() => {
    persistSidebarOpen(sidebarOpen);
  }, [sidebarOpen]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || !matchesSidebarToggleShortcut(event)
        || isSidebarShortcutCaptured(event.target)
      ) return;
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
    if (wasOpen === sidebarOpen) return;
    const frame = window.requestAnimationFrame(() => {
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
  useEffect(() => {
    const inspect = (event: Event) => {
      const correlationId = (event as CustomEvent<{ correlationId?: unknown }>).detail?.correlationId;
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
  const [primaryChangesSignal, setPrimaryChangesSignal] = useState(0);
  const [primaryFilesSignal, setPrimaryFilesSignal] = useState(0);
  const [secondaryChangesSignal, setSecondaryChangesSignal] = useState(0);
  const [secondaryFilesSignal, setSecondaryFilesSignal] = useState(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [delegatedRelationships, setDelegatedRelationships] = useState<
    DelegatedConversationRelationship[]
  >([]);
  const [delegatedOutcomes, setDelegatedOutcomes] = useState<
    DelegatedConversationOutcomeProjection[]
  >([]);
  const [delegatedApprovals, setDelegatedApprovals] = useState<
    DelegatedApprovalProjection[]
  >([]);
  const [delegatedInputs, setDelegatedInputs] = useState<DelegatedInputProjection[]>([]);
  const [showingArchived, setShowingArchived] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ConversationSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    conversation: ConversationSummary;
    preview: ConversationDeletionPreview;
  } | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<ConversationSummary | null>(null);
  const [incompleteDeletionIds, setIncompleteDeletionIds] = useState<string[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [primaryNewKey, setPrimaryNewKey] = useState(0);
  const primaryNewKeyReference = useRef(0);
  const [repairBrief, setRepairBrief] = useState<{ projectId: string; prompt: string } | null>(null);
  const [secondaryId, setSecondaryId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<"primary" | "secondary">("primary");
  const [splitPercent, setSplitPercent] = useState(50);
  const renameReturnFocusReference = useRef<HTMLElement | null>(null);
  const deleteReturnFocusReference = useRef<HTMLElement | null>(null);
  const releaseReturnFocusReference = useRef<HTMLElement | null>(null);
  const [restoreState, setRestoreState] = useState<"idle" | "loading" | "ready" | "failed">(
    () => (repository ? "loading" : "idle"),
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
  const stateProjectionRequestReference = useRef(0);
  useEffect(() => {
    const startRepair = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: unknown; prompt?: unknown }>).detail;
      if (
        typeof detail?.projectId !== "string"
        || !detail.projectId
        || typeof detail.prompt !== "string"
        || !detail.prompt
        || detail.prompt.length > 8_000
      ) return;
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

  // Load the inbox once (and on explicit retry). Do not re-run when the active
  // repository changes — selecting a chat must not reshuffle or reselect.
  useEffect(() => {
    let active = true;
    setRestoreState("loading");
    const restore = async () => {
      const available = await loadConversationList(null);
      if (!active) return;
      setConversations(available);
      const requestSequence = ++stateProjectionRequestReference.current;
      const lifecycleResponse = await fetch("/api/state/load", { method: "POST" });
      const lifecycleProjection = await lifecycleResponse.json() as {
        conversationDeletions?: Array<{ threadId: string; status: string }>;
        delegatedOutcomes?: DelegatedConversationOutcomeProjection[];
        delegatedApprovals?: DelegatedApprovalProjection[];
        delegatedInputs?: DelegatedInputProjection[];
        delegatedRelationships?: DelegatedConversationRelationship[];
      };
      if (requestSequence === stateProjectionRequestReference.current) {
        setDelegatedRelationships(lifecycleProjection.delegatedRelationships ?? []);
        setDelegatedOutcomes(lifecycleProjection.delegatedOutcomes ?? []);
        setDelegatedApprovals(lifecycleProjection.delegatedApprovals ?? []);
        setDelegatedInputs(lifecycleProjection.delegatedInputs ?? []);
      }
      setIncompleteDeletionIds(
        (lifecycleProjection.conversationDeletions ?? [])
          .filter((deletion) => deletion.status !== "completed")
          .map((deletion) => deletion.threadId),
      );
      // Only apply stored selection on the first successful load.
      if (restoredProjectReference.current === null) {
        const parameters = new URLSearchParams(window.location.search);
        const preferredProjectId = repository?.projectId
          ?? parameters.get("project")
          ?? projects[0]?.id
          ?? null;
        const stored = preferredProjectId
          ? window.localStorage.getItem(`aldunis.split.${preferredProjectId}`)
          : null;
        let saved: { primaryId?: string | null; secondaryId?: string | null; splitPercent?: number } = {};
        try { saved = stored ? JSON.parse(stored) as typeof saved : {}; } catch { saved = {}; }
        const urlConversation = parameters.get("conversation");
        const restored = normalizeSplitWorkspaceState({
          primaryId: urlConversation ?? saved.primaryId,
          secondaryId: parameters.get("beside") ?? saved.secondaryId,
          splitPercent: saved.splitPercent,
        }, available[0]?.id ?? null);
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
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/retry only; repo switches must not reshuffle
  }, [restoreAttempt]);

  // Track the bound project for split persistence without resetting the inbox selection.
  useEffect(() => {
    if (!repository) return;
    restoredProjectReference.current = repository.projectId;
  }, [repository?.projectId]);
  useEffect(() => {
    if (!repository || restoredProjectReference.current !== repository.projectId) return;
    window.localStorage.setItem(`aldunis.split.${repository.projectId}`, JSON.stringify({
      primaryId,
      secondaryId,
      splitPercent,
    }));
    const parameters = new URLSearchParams(window.location.search);
    parameters.set("project", repository.projectId);
    if (primaryId) parameters.set("conversation", primaryId); else parameters.delete("conversation");
    if (secondaryId) parameters.set("beside", secondaryId); else parameters.delete("beside");
    window.history.replaceState(null, "", `${window.location.pathname}${parameters.size ? `?${parameters}` : ""}${window.location.hash}`);
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
  const initialRepairPrompt = !primary
    && repairBrief
    && repairBrief.projectId === repository?.projectId
    ? repairBrief.prompt
    : undefined;
  const quietPrimaryChild = orchestrationThreadsBeta && isQuietDelegatedChild(
    primaryId,
    activePane === "secondary" ? secondaryId : null,
    delegatedRelationships,
  );
  const quietSecondaryChild = orchestrationThreadsBeta && isQuietDelegatedChild(
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
  const loadStateProjection = async () => {
    const response = await fetch("/api/state/load", { method: "POST" });
    const body = await response.json() as ConversationListProjection & {
      delegatedOutcomes?: DelegatedConversationOutcomeProjection[];
      delegatedApprovals?: DelegatedApprovalProjection[];
      delegatedInputs?: DelegatedInputProjection[];
      delegatedRelationships?: DelegatedConversationRelationship[];
      error?: string;
    };
    if (!response.ok) throw new Error(body.error ?? "Local conversation state could not be loaded.");
    return body;
  };
  const applyStateProjection = (body: Awaited<ReturnType<typeof loadStateProjection>>) => {
    const projected = conversationListFromProjection(body);
    setConversations((current) => {
      const currentById = new Map(current.map((conversation) => [conversation.id, conversation]));
      return projected.map((conversation) => {
        const optimisticVisit = currentById.get(conversation.id)?.lastVisitedAt;
        return optimisticVisit && (!conversation.lastVisitedAt || optimisticVisit > conversation.lastVisitedAt)
          ? { ...conversation, lastVisitedAt: optimisticVisit }
          : conversation;
      });
    });
    setDelegatedRelationships(body.delegatedRelationships ?? []);
    setDelegatedOutcomes(body.delegatedOutcomes ?? []);
    setDelegatedApprovals(body.delegatedApprovals ?? []);
    setDelegatedInputs(body.delegatedInputs ?? []);
  };
  const refreshStateProjection = async () => {
    const requestSequence = ++stateProjectionRequestReference.current;
    const body = await loadStateProjection();
    if (requestSequence !== stateProjectionRequestReference.current) return;
    applyStateProjection(body);
  };
  useEffect(() => {
    let active = true;
    const synchronize = () => {
      const requestSequence = ++stateProjectionRequestReference.current;
      void loadStateProjection().then((projection) => {
        if (
          !active
          || requestSequence !== stateProjectionRequestReference.current
        ) return;
        applyStateProjection(projection);
      }).catch(() => undefined);
    };
    synchronize();
    const events = new EventSource("/api/state/events");
    events.addEventListener("open", synchronize);
    events.addEventListener("thread_status", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as unknown;
        if (!isThreadStatusEvent(update)) return;
        synchronize();
      } catch {
        /* malformed status events do not replace the last valid projection */
      }
    });
    return () => {
      active = false;
      events.close();
    };
    // The host hides delegated relationships while disabled, so enable performs a fresh load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestrationThreadsBeta]);
  const listedConversations = useMemo(() => {
    const memberIds = projectFilter === "all"
      ? null
      : new Set(
        projects.find((project) => project.id === projectFilter)?.memberIds
          ?? [projectFilter],
      );
    return conversations.filter((conversation) => {
      if (memberIds && !memberIds.has(conversation.projectId)) return false;
      return showingArchived ? Boolean(conversation.archivedAt) : !conversation.archivedAt;
    });
  }, [conversations, projectFilter, projects, showingArchived]);
  const worktreeLimit = 10;
  const managedWorktreeCount = repository?.worktrees.filter((wt) => wt.ownership === "aldunis").length ?? 0;
  const postLifecycle = async (route: string, body: Record<string, unknown>) => {
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
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
        renameReturnFocusReference.current = active instanceof HTMLElement
          ? active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null
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
        deleteReturnFocusReference.current = active instanceof HTMLElement
          ? active.closest(".row-menu")?.querySelector<HTMLElement>(".row-more") ?? null
          : null;
        const previewResponse = await fetch("/api/state/conversations/delete/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: conversation.id }),
        });
        const preview = await previewResponse.json() as {
          affectedRecords?: Record<string, number>;
          excluded?: string[];
          error?: string;
        };
        if (!previewResponse.ok) throw new Error(preview.error ?? "Deletion preview failed.");
        setDeleteTarget({ conversation, preview });
      }
    } catch (error) {
      setLifecycleError(error instanceof Error ? error.message : "Conversation lifecycle action failed.");
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
  const refresh = async () => {
    if (!repository || !worktreeForActive) {
      setChanges([]);
      return;
    }
    try {
      const response = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          root: repository.root,
          worktree: worktreeForActive,
        }),
      });
      const body = await response.json() as { files?: ChangedFile[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Changed files could not be inspected.");
      setChanges(body.files ?? []);
    } catch {
      setChanges([]);
    }
  };
  useEffect(() => { void refresh(); }, [worktreeForActive, repository?.root, repository?.selectedWorktree]);
  // URL/local restore can pair a conversation with the wrong open repository.
  // Activate the thread's project so runs/tools bind to the correct root.
  useEffect(() => {
    if (!primaryId || restoreState !== "ready") return;
    const thread = conversations.find((item) => item.id === primaryId);
    if (!thread) {
      requestedProjectForPrimaryRef.current = null;
      return;
    }
    const activeIds = new Set([
      repository?.projectId,
      ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
    ].filter(Boolean) as string[]);
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
    if (!repository.worktrees.some((worktree) => worktree.path === conversation.worktree)) return null;
    return repositoryFor(conversation);
  };
  const openBeside = (id?: string) => {
    // Prefer an explicit id (thread-row Beside). Topbar Open beside should stay in the
    // active project — not open a random foreign-worktree thread that cannot send.
    const sameProjectIds = new Set([
      repository?.projectId,
      ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
      primary?.projectId,
    ].filter(Boolean) as string[]);
    const sameProjectOther = conversations.find((conversation) => (
      conversation.id !== primaryId
      && !conversation.archivedAt
      && !conversation.settledAt
      && (sameProjectIds.size === 0 || sameProjectIds.has(conversation.projectId))
    ));
    const candidate = id
      ?? sameProjectOther?.id
      ?? `new:${crypto.randomUUID()}`;
    secondaryIdReference.current = candidate;
    setSecondaryId(candidate);
    setActivePane("secondary");
  };
  const openConversation = useCallback((id: string) => {
    const thread = conversations.find((item) => item.id === id);
    // Activate the thread's repository for runs/tools, but do not change the
    // project chip filter — inbox "All" must stay on All when clicking a chat.
    if (thread) {
      const activeIds = new Set([
        repository?.projectId,
        ...(projects.find((project) => project.id === repository?.projectId)?.memberIds ?? []),
      ].filter(Boolean) as string[]);
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
    setConversations((current) => current.map((item) => (
      item.id === id ? { ...item, lastVisitedAt: visitedAt } : item
    )));
    void fetch("/api/state/conversations/visit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: id }),
    }).catch(() => undefined);
  }, [conversations, onSelectProject, projects, repository?.projectId]);
  // Thread search lives outside the workbench shell; open hits via shared event.
  useEffect(() => {
    const onOpenFromSearch = (event: Event) => {
      const threadId = (event as CustomEvent<{ threadId?: string }>).detail?.threadId;
      if (typeof threadId === "string" && threadId.length > 0) openConversation(threadId);
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
        product={product}
        onProductChange={onProductChange}
        productAvailability={productAvailability}
        repository={repository}
        repositoryRestoring={repositoryRestoring}
        projects={projects}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onAddProject={onAddProject}
        onSelectProject={onSelectProject}
        changes={changes}
        onShowChanges={() => {
          void refresh();
          if (activePane === "secondary") setSecondaryChangesSignal((value) => value + 1);
          else setPrimaryChangesSignal((value) => value + 1);
        }}
        onBrowseFiles={() => (
          activePane === "secondary"
            ? setSecondaryFilesSignal((value) => value + 1)
            : setPrimaryFilesSignal((value) => value + 1)
        )}
        conversations={listedConversations}
        primaryConversationId={primaryId}
        secondaryConversationId={secondaryId}
        onOpenConversation={openConversation}
        onOpenBeside={openBeside}
        onNewConversation={() => {
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
        onOpenPalette={onOpenPalette}
        onSelectWorktree={onSelectWorktree}
        onManageWorktrees={onManageWorktrees}
        showingArchived={showingArchived}
        onToggleArchived={() => setShowingArchived((value) => !value)}
        onConversationAction={(conversation, action) => { void manageConversation(conversation, action); }}
        onSettle={(conversation) => {
          void postLifecycle("/api/state/conversations/settle", { threadId: conversation.id })
            .catch((error: unknown) => setLifecycleError(
              error instanceof Error ? error.message : "Settle failed.",
            ));
        }}
        onUnsettle={(conversation) => {
          void postLifecycle("/api/state/conversations/unsettle", { threadId: conversation.id })
            .catch((error: unknown) => setLifecycleError(
              error instanceof Error ? error.message : "Unsettle failed.",
            ));
        }}
        onReleaseWorktree={(conversation) => {
          const active = document.activeElement;
          releaseReturnFocusReference.current = active instanceof HTMLElement ? active : null;
          setReleaseTarget(conversation);
        }}
        worktreeLimit={worktreeLimit}
        managedWorktreeCount={managedWorktreeCount}
        managedAccount={managedAccount}
        onSettings={onSettings}
      />
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
      <main className="main" data-sidebar-state={sidebarOpen ? "expanded" : "collapsed"}>
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
      ) : (
      <div className="code-view conversation-workspace" data-active-pane={activePane} aria-label="Conversation workspace">
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
                void postLifecycle("/api/state/conversations/delete", { threadId, confirm: true })
                  .then(() => setIncompleteDeletionIds((ids) => ids.filter((id) => id !== threadId)))
                  .catch((error: unknown) => setLifecycleError(
                    error instanceof Error ? error.message : "Conversation deletion retry failed.",
                  ));
              }}
            >
              Retry deletion
            </Button>
          </div>
          );
        })}
        {restoreState === "loading" && <div className="workspace-state" role="status">Restoring local conversations…</div>}
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
        {(restoreState === "ready" || !repository) && <>
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
          style={secondaryId ? { gridTemplateColumns: `${splitPercent}% 6px minmax(0, 1fr)` } : undefined}
        >
          <div className="conversation-pane primary-pane" tabIndex={-1} ref={primaryPaneReference} onFocusCapture={() => setActivePane("primary")}>
            {primaryId && !primary
              ? <MissingConversation pane="primary" conversations={conversations.filter((item) => item.id !== secondaryId)} onReplace={(id) => {
                  primarySelectionReference.current = id ?? `new:${primaryNewKey + 1}`;
                  setPrimaryId(id);
                }} />
              : <>
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
                <PaneConversation key={primaryId ?? `new-primary:${primaryNewKey}`} repository={repositoryFor(primary)} conversation={primary} pane="primary" active={activePane === "primary"} quietDelegatedChild={quietPrimaryChild} projects={projects} onAddProject={onAddProject} onSelectProject={onSelectProject} profiles={profiles} showThinking={showThinking} managedMode={managedMode} managedModel={managedModel} initialPrompt={initialRepairPrompt} initialProvider={initialRepairPrompt ? "shikigami" : undefined} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onRepositoryChanged={onRepositoryChanged} onSelectWorktree={onSelectWorktree} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} showOpenBeside={!secondaryId} showChangesSignal={primaryChangesSignal} showFilesSignal={primaryFilesSignal} onConversationAvailable={(id) => {
                  if (primarySelectionReference.current === primarySelectionKey) {
                    primarySelectionReference.current = id;
                    setPrimaryId(id);
                    setRepairBrief(null);
                  }
                  void refreshStateProjection().catch(() => {});
                }} />
              </>}
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
                  if (event.key === "ArrowLeft") setSplitPercent((value) => Math.max(30, value - 5));
                  if (event.key === "ArrowRight") setSplitPercent((value) => Math.min(70, value + 5));
                }}
              />
              <div className="conversation-pane secondary-pane" tabIndex={-1} ref={secondaryPaneReference} onFocusCapture={() => setActivePane("secondary")}>
                {!secondary && !secondaryId.startsWith("new:")
                  ? <MissingConversation pane="secondary" conversations={conversations.filter((item) => item.id !== primaryId)} onReplace={setSecondaryId} onClose={() => setSecondaryId(null)} />
                  : <>
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
                    <PaneConversation key={secondaryId} repository={repositoryFor(secondary)} conversation={secondary} pane="secondary" active={activePane === "secondary"} quietDelegatedChild={quietSecondaryChild} projects={projects} onAddProject={onAddProject} onSelectProject={onSelectProject} profiles={profiles} showThinking={showThinking} managedMode={managedMode} managedModel={managedModel} onOpenRepository={onAddProject} onOpenProfiles={onOpenProfiles} onRepositoryChanged={onRepositoryChanged} onSelectWorktree={onSelectWorktree} onManageWorktrees={onManageWorktrees} onOpenBeside={() => openBeside()} onClosePane={() => {
                      secondaryIdReference.current = null;
                      setSecondaryId(null);
                      setActivePane("primary");
                    }} showChangesSignal={secondaryChangesSignal} showFilesSignal={secondaryFilesSignal} onConversationAvailable={(id) => {
                      if (secondaryIdReference.current !== secondaryId) return;
                      secondaryIdReference.current = id;
                      setSecondaryId(id);
                      void refreshStateProjection().catch(() => {});
                    }} />
                  </>}
              </div>
            </>
          )}
        </div>
        </>}
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
            const result = await response.json() as { error?: string };
            if (!response.ok) throw new Error(result.error ?? "Conversation deletion failed.");
            if (primaryId === conversation.id) setPrimaryId(null);
            if (secondaryId === conversation.id) setSecondaryId(null);
            setConversations((current) => current.filter((item) => item.id !== conversation.id));
            void refreshStateProjection()
              .catch(() => setLifecycleError(
                "Conversation deleted, but the conversation list could not be refreshed.",
              ));
          }}
        />
      )}
      {releaseTarget && (
        <ReleaseWorktreeDialog
          title={releaseTarget.title}
          provider={releaseTarget.provider ? providerListLabel(releaseTarget.provider) : "Unknown provider"}
          worktree={releaseTarget.worktree}
          onClose={() => {
            setReleaseTarget(null);
            const returnFocus = releaseReturnFocusReference.current;
            releaseReturnFocusReference.current = null;
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => returnFocus?.focus()));
          }}
          onConfirm={async () => {
            await postLifecycle("/api/state/conversations/release-worktree", {
              threadId: releaseTarget.id,
              confirm: true,
            });
          }}
        />
      )}
    </>
  );
}
