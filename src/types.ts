/** Shared workbench domain types (relocated from main.tsx). */
export type Product = "code" | "sekai" | "chisei" | "tenkai";
export type WorktreeState = "available" | "detached" | "missing" | "inaccessible";
export type WorktreeRecovery = "available" | "moved" | "missing" | "inaccessible";
/** How a conversation owns or shares the workspace it is bound to. */
export type WorkspaceMode = "shared" | "aldunis-managed" | "provider-native";

export interface WorkspaceCapabilities {
  shared: boolean;
  aldunisManaged: boolean;
  providerNative: boolean;
  providerNativeDetail: string | null;
}

export interface RepositoryMetadata {
  projectId: string;
  name: string;
  root: string;
  managedRepositoryId?: string;
  selectedWorktree: string;
  worktrees: Array<{
    path: string;
    head: string | null;
    branch: string | null;
    state: WorktreeState;
    ownership: "aldunis" | "user";
    recovery: WorktreeRecovery;
    originalPath: string | null;
  }>;
}
export interface ManagedAccount {
  displayName: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  assertionExpiresAt: string;
  sessionExpiresAt: string | null;
  logoutUrl: string | null;
}
export interface HostCapabilities {
  mode: "local" | "remote" | "managed";
  managed: boolean;
  tenantScoped: boolean;
  singleTenantAlpha?: boolean;
  account?: ManagedAccount | null;
  provider?: {
    id: ProviderId;
    name: string;
    execution: string;
    model: string;
    modelAdapter: string;
    governanceAdapter: string;
  };
  capabilities: {
    providerSelection: boolean;
    profileAdministration: boolean;
    adapterAdministration: boolean;
    modelSelection: boolean;
    modeSelection: boolean;
    arbitraryRepositorySelection: boolean;
    directoryBrowsing: boolean;
  };
  repositories?: Array<{ id: string; name: string }>;
  state?: {
    policy: string;
    restart: string;
    loss: string;
  };
}
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  truncated: boolean;
  limits: {
    maxDepth: number;
    maxEntries: number;
    timeoutMs: number;
    maxConcurrent: number;
  };
}
export interface WorktreeCreationPlan {
  id: string;
  action: "create";
  repository: string;
  base: string;
  baseRevision: string;
  branch: string;
  path: string;
  expiresAt: string;
}
export interface WorktreeRemovalPlan {
  id: string;
  action: "remove";
  repository: string;
  branch: string;
  path: string;
  expiresAt: string;
}
export interface ThreadMetadata {
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  workspaceMode?: WorkspaceMode;
  updatedAt: string;
  projectName: string;
  /** Provider id when present so search hits for the same title can be told apart. */
  provider?: ProviderId;
  pinnedAt: string | null;
  archivedAt: string | null;
}
export type ThreadStatus =
  | "pending_approval"
  | "awaiting_input"
  | "running"
  | "failed"
  | "completed"
  | "idle";

export interface ThreadStatusProjection {
  threadId: string;
  status: ThreadStatus;
  since: string;
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  workspaceMode?: WorkspaceMode;
  provider: ProviderId;
  parentThreadId?: string;
  profileId?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort;
  updatedAt: string;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  settledAt?: string | null;
  wokeAt?: string | null;
  lastVisitedAt?: string | null;
  /** Derived server-side; attached by loadConversationList. */
  status?: ThreadStatus;
  statusSince?: string;
  projectName?: string;
}
export interface DelegatedConversationRelationship {
  id: string;
  parentThreadId: string;
  childThreadId: string;
  createdAt: string;
}
export interface DelegatedConversationOutcomeProjection {
  childThreadId: string;
  completedAt: string;
  summary: string;
}
export interface ForkPreview {
  sourceThreadId: string;
  sourceProvider: ProviderId;
  workspaceMode: WorkspaceMode;
  worktree: string;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string }>;
  annotations: Array<{ id: string; path: string; text: string; capturedContext: string }>;
  files: [];
  summaries: [];
  byteCount: number;
  digest: string;
  excluded: string[];
  contextPackage: ContextReceipt;
}
export interface ContextPin {
  path: string;
  kind: "file" | "folder";
}
export type ContextReceiptSource =
  | "aldunis_attachment"
  | "aldunis_folder"
  | "provider_managed_instruction";
export interface ContextReceiptEntry {
  path: string;
  type: "text" | "image" | "folder" | "instruction" | "unsupported";
  source: ContextReceiptSource;
  bytes: number | null;
  truncated: boolean;
  digest: string | null;
  omissionReason: string | null;
}
export interface ContextReceipt {
  id?: string;
  threadId?: string;
  turnId?: string;
  pins: ContextPin[];
  entries: ContextReceiptEntry[];
  totalBytes: number;
  estimatedTokens: number;
  digest: string;
  createdAt?: string;
}
export type ChangeState = "added" | "modified" | "deleted" | "renamed" | "binary" | "oversized";
export interface ChangedFile {
  path: string;
  previousPath: string | null;
  state: ChangeState;
  additions: number | null;
  deletions: number | null;
}
export interface FileDiff extends ChangedFile {
  identity: string;
  lines: Array<{
    index: number;
    side: "context" | "addition" | "deletion" | "metadata";
    oldLine: number | null;
    newLine: number | null;
    content: string;
  }>;
  patch: string | null;
  message: string | null;
}
export interface DiffAnnotation {
  id: string;
  threadId: string;
  checkpointId: string | null;
  diffIdentity: string;
  path: string;
  previousPath: string | null;
  targetState: ChangeState;
  scope: "file" | "line";
  side: "addition" | "deletion" | "context" | null;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  capturedContext: string;
  resolution: "unresolved" | "resolved";
  stale: boolean;
  staleReason: string | null;
}
export interface RepositoryFileResult {
  path: string;
  kind: "text" | "image" | "binary" | "oversized" | "inaccessible";
  size: number | null;
  match: "name" | "content" | null;
}
export interface RepositoryFilePreview extends RepositoryFileResult {
  mediaType: string | null;
  content: string | null;
  imageData: string | null;
  truncated: boolean;
  encoding: "utf-8" | "binary" | "image" | "unavailable";
  message: string | null;
  attachable: boolean;
}
export interface ProviderCapabilities {
  provider: "claude-code";
  commands: ProviderCommand[];
  attachments: {
    maxCount: number;
    textMaxBytes: number;
    imageMaxBytes: number;
    imageTypes: string[];
  };
  workspace: WorkspaceCapabilities;
}
export interface ProviderCommand {
  name: string;
  description: string;
}
export interface ProviderSkill {
  name: string;
  description: string;
}
export type ProviderId = "claude-code" | "codex-cli" | "shikigami" | `adapter:${string}@${string}`;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ProviderModelDiscovery {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}
export interface ProviderProfileDiscovery {
  profileId: string;
  installed: boolean;
  authenticated?: boolean;
  version?: string | null;
  detail?: string | null;
  models?: ProviderModelDiscovery[];
}
export interface ProviderDiscovery {
  id: ProviderId;
  installed: boolean;
  authenticated?: boolean;
  version?: string | null;
  name?: string;
  enabled?: boolean;
  /** Operator-facing reason when the provider is not run-ready. */
  detail?: string | null;
  models?: ProviderModelDiscovery[];
  /** Profile-specific readiness, currently populated for Shikigami. */
  profileDiscoveries?: ProviderProfileDiscovery[];
}
export interface ProviderAdapterManifest {
  schemaVersion: 1;
  id: string;
  publisher: { name: string };
  version: string;
  aldunis: { minimumVersion: string; maximumVersion: string };
  protocol: { kind: "acp"; minimumVersion: 1; maximumVersion: 1 };
  executable: { names: string[]; arguments: string[] };
  capabilities: {
    tools: boolean;
    images: boolean;
    browserObservation?: boolean;
    browserAutomation?: boolean;
    sessionResume: boolean;
  };
  environment: Array<{ name: string; required: boolean; sensitive: boolean }>;
  presentation: { name: string; description: string; website?: string };
}

export type BrowserSessionState = "awaiting_view" | "ready" | "closed" | "failed";
export type BrowserController = "none" | "human" | "agent";
export interface BrowserSessionSnapshot {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  origin: string;
  partition: string;
  state: BrowserSessionState;
  agentControl: boolean;
  controller: BrowserController;
  url: string | null;
  title: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface InstalledProviderAdapter {
  schemaVersion: 1;
  source: string;
  digest: string;
  enabled: boolean;
  installedAt: string;
  manifest: ProviderAdapterManifest;
}
export interface ReviewedAdapterCatalogEntry {
  slug: string;
  id: string;
  name: string;
  description: string;
  website: string | null;
  version: string;
  digest: string;
  source: string;
  executableNames: string[];
  executableFound: boolean;
  executablePath: string | null;
  installed: boolean;
  installedVersion: string | null;
  installedDigest: string | null;
  enabled: boolean | null;
  action: "install" | "update" | "reinstall-same" | "current";
  installLabel: string;
  requiresCliHint: string;
  package: {
    source: string;
    digest: string;
    manifest: ProviderAdapterManifest;
  } | null;
}
export type ProfileProbeKind = "availability" | "version" | "authentication" | "models";
export interface ProfileProbe {
  state: "unknown" | "refreshing" | "ready" | "unavailable";
  checkedAt: string | null;
  detail: string | null;
  authenticated?: boolean;
  models?: string[];
}
export interface ClaudeProfile {
  schemaVersion: 1;
  id: string;
  /**
   * Owning provider (`claude-code` | `codex-cli` | `shikigami` | `adapter:…`).
   * Legacy rows without this field are treated as `claude-code`.
   */
  provider: string;
  name: string;
  binaryPath: string;
  homePath: string;
  configPath: string;
  environment: Array<{
    name: string;
    sensitive: boolean;
    value?: string;
    valueSet?: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
  probes: Record<ProfileProbeKind, ProfileProbe>;
}
export type DeliveryAction = "stage" | "commit" | "push" | "pull_request";
export interface DeliveryContext {
  repository: string;
  worktree: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  remotes: Array<{ name: string; url: string }>;
  staged: string[];
  unstaged: string[];
}
export interface DeliveryPlan {
  id: string;
  action: DeliveryAction;
  summary: string;
  repository: string;
  worktree: string;
  branch: string;
  remote: string | null;
  destination: string | null;
  details: string[];
  expiresAt: string;
}

export type ReleaseWorkflowAction =
  | "prepare"
  | "evaluate"
  | "publish"
  | "promote"
  | "plan"
  | "apply"
  | "reconcile"
  | "rollback";

export interface ReleaseDeliveryPlan {
  id: string;
  action: ReleaseWorkflowAction;
  sessionId: string | null;
  summary: string;
  details: string[];
  expiresAt: string;
}

export interface ReleaseDeliverySession {
  schemaVersion: 1;
  id: string;
  projectId: string;
  candidate: {
    identity: string;
    product: string;
    version: string;
    release: string;
    manifestPath: string;
    document: {
      commit: { oid: string };
      source_tree_digest: string;
      manifest: { digest: string };
      artifacts: Array<{ digest: string }>;
      build_definition_digest: string;
    };
  };
  state: string;
  completeness: "complete" | "partial" | "stale" | "unknown";
  buildEvidence: {
    digest: string;
    commands: Array<{ id: "install" | "build" | "test"; status: "passed" }>;
    observedAt: string;
  };
  evaluation: {
    decision: "allow" | "deny" | "unavailable" | "unknown";
    operationId: string;
    receiptSchema: string;
    receiptDigest: string;
    fresh: boolean;
    observedAt: string;
  } | null;
  tenkai: {
    releaseId: string | null;
    provenanceDigest: string | null;
    channelId: string | null;
    planId: string | null;
    environmentId: string | null;
    planState: string | null;
    deployedVersion: string | null;
    health: string | null;
    rollbackPlanId: string | null;
    provenanceExpiresAt: string | null;
    observedAt: string | null;
  };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export type PreviewState = "approval_pending" | "starting" | "running" | "stopping" | "stopped" | "failed";
export interface PreviewSnapshot {
  id: string;
  repository: string;
  worktree: string;
  command: string;
  origin: string;
  state: PreviewState;
  approvalExpiresAt: string | null;
  message: string | null;
}
export interface ElementReference {
  selector: string;
  tag: string;
  role: string | null;
  name: string | null;
  text: string | null;
  screenshot: string | null;
}
export type ProviderState = "idle" | "starting" | "streaming" | "waiting_for_approval" | "waiting_for_input" | "cancelling" | "completed" | "cancelled" | "failed";
export type ProviderPlanStepStatus = "pending" | "active" | "completed" | "neutral";
export interface ProviderPlanStep {
  content: string;
  status: ProviderPlanStepStatus;
}
export interface ProviderPlanArtifact {
  id: string;
  provider: ProviderId;
  title?: string;
  body?: string;
  steps?: ProviderPlanStep[];
  updatedAt?: string;
}
export type ProviderBrowserObservationMediaType = "image/jpeg" | "image/png" | "image/webp";
export interface ProviderBrowserObservation {
  provider: ProviderId;
  observationId: string;
  imageData: string;
  mediaType: ProviderBrowserObservationMediaType;
  toolCallId?: string;
  title?: string;
  url?: string;
}
export type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | {
    kind: "governance_correlation";
    governance: "sekai-chisei";
    runId: string;
    operationId: string;
    correlationId?: string;
  }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | {
    kind: "plan_updated";
    artifact: ProviderPlanArtifact;
    bodyMode?: "replace" | "append";
  }
  | { kind: "tool_started"; toolCallId: string; name: string }
  | {
    kind: "approval_pending";
    id: string;
    runId: string;
    conversationId: string;
    repository: string;
    worktree: string;
    provider: string;
    toolCallId: string;
    toolName: string;
    scope: { summary: string; target: string; details: string[] };
    state: ApprovalState;
    expiresAt: string;
  }
  | { kind: "approval_resolved"; id: string; state: ApprovalState }
  | ({ kind: "input_requested" } & ChildInputRequest)
  | { kind: "input_resolved"; id: string; state: "answered" | "cancelled" }
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | ({ kind: "browser_observation" } & ProviderBrowserObservation)
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | {
    kind: "failed";
    message: string;
    sessionId?: string;
    code?: "unsupported_external_tool";
  };
export type ApprovalState = "pending" | "allowed_once" | "denied" | "cancelled" | "expired" | "provider_failed";
export interface DelegatedApprovalProjection {
  parentThreadId: string;
  childThreadId: string;
  approval: Omit<Extract<ProviderEvent, { kind: "approval_pending" }>, "kind">;
}
export interface ChildInputRequest {
  id: string;
  threadId: string;
  question: string;
  choices: Array<{ id: string; label: string; description: string | null }>;
  recommendation: string | null;
  responseMode: "native_resume" | "child_follow_up";
  state: "pending" | "answered" | "cancelled";
  createdAt: string;
  expiresAt: string | null;
  allowFreeForm: boolean;
}
export interface DelegatedInputProjection {
  parentThreadId: string;
  childThreadId: string;
  request: ChildInputRequest;
}
export type InteractionMode = "ask" | "plan" | "build";
export type CheckpointState = "baseline" | "completed" | "failed" | "superseded" | "unavailable";
export interface TurnCheckpoint {
  id: string;
  turnId: string;
  worktree: string;
  baselineIdentity: string | null;
  baselineIndexIdentity: string | null;
  completedIdentity: string | null;
  completedIndexIdentity: string | null;
  state: CheckpointState;
  message: string | null;
}
export interface CheckpointFile {
  path: string;
  state: "added" | "modified" | "deleted" | "renamed" | "binary";
  previousPath: string | null;
}
export type IconName =
  | "code"
  | "computer"
  | "branch"
  | "folder"
  | "message"
  | "diff"
  | "spark"
  | "shield"
  | "route"
  | "rocket"
  | "plus"
  | "search"
  | "settings"
  | "chevron";
