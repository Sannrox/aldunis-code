/** Shared workbench domain types (relocated from main.tsx). */
export type Product = "code" | "sekai" | "chisei" | "tenkai";
export type WorktreeState = "available" | "detached" | "missing" | "inaccessible";
export type WorktreeRecovery = "available" | "moved" | "missing" | "inaccessible";
export interface RepositoryMetadata {
  projectId: string;
  name: string;
  root: string;
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
export interface ForkPreview {
  sourceThreadId: string;
  sourceProvider: ProviderId;
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
  commands: Array<{ name: string; description: string }>;
  attachments: {
    maxCount: number;
    textMaxBytes: number;
    imageMaxBytes: number;
    imageTypes: string[];
  };
}
export interface ProviderSkill {
  name: string;
  description: string;
}
export type ProviderId = "claude-code" | "codex-cli" | "shikigami" | `adapter:${string}@${string}`;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ProviderDiscovery {
  id: ProviderId;
  installed: boolean;
  authenticated?: boolean;
  version?: string | null;
  name?: string;
  enabled?: boolean;
  /** Operator-facing reason when the provider is not run-ready. */
  detail?: string | null;
  models?: Array<{
    id: string;
    displayName: string;
    isDefault: boolean;
    reasoningEfforts?: ReasoningEffort[];
    defaultReasoningEffort?: ReasoningEffort;
  }>;
}
export interface ProviderAdapterManifest {
  schemaVersion: 1;
  id: string;
  publisher: { name: string };
  version: string;
  aldunis: { minimumVersion: string; maximumVersion: string };
  protocol: { kind: "acp"; minimumVersion: 1; maximumVersion: 1 };
  executable: { names: string[]; arguments: string[] };
  capabilities: { tools: boolean; images: boolean; sessionResume: boolean };
  environment: Array<{ name: string; required: boolean; sensitive: boolean }>;
  presentation: { name: string; description: string; website?: string };
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
export type ProviderState = "idle" | "starting" | "streaming" | "waiting_for_approval" | "cancelling" | "completed" | "cancelled" | "failed";
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
export type ProviderEvent =
  | { kind: "session_started"; sessionId: string; model: string | null }
  | { kind: "assistant_text"; text: string }
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
  | { kind: "tool_finished"; toolCallId: string; failed: boolean }
  | { kind: "turn_completed"; sessionId: string; costUsd: number | null }
  | { kind: "cancelled" }
  | {
    kind: "failed";
    message: string;
    code?: "unsupported_external_tool";
  };
export type ApprovalState = "pending" | "allowed_once" | "denied" | "cancelled" | "expired" | "provider_failed";
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
  | "branch"
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
