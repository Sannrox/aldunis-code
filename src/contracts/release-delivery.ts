/** Transport-safe release-delivery contracts shared by the host and workbench. */
export type ReleaseWorkflowAction =
  "prepare" | "evaluate" | "publish" | "promote" | "plan" | "apply" | "reconcile" | "rollback";

export type ReleaseCompleteness = "complete" | "partial" | "stale" | "unknown";

export type ReleaseWorkflowState =
  | "candidate_ready"
  | "governance_allowed"
  | "governance_denied"
  | "governance_unavailable"
  | "governance_unknown"
  | "published"
  | "publication_unknown"
  | "promoted"
  | "planned"
  | "applying"
  | "recovered"
  | "completed"
  | "failed"
  | "unknown"
  | "stale";

export interface ReleaseEvaluationReference {
  kind: string;
  reference: string;
  contentDigest: string;
  observedAt: string;
}

export interface ReleaseCandidateProjection {
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
}

export interface ReleaseDeliverySession {
  schemaVersion: 1;
  id: string;
  projectId: string;
  candidate: ReleaseCandidateProjection;
  state: ReleaseWorkflowState;
  completeness: ReleaseCompleteness;
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
    references: ReleaseEvaluationReference[];
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

export type TenkaiTerminalOutcomeState =
  | "deployment_succeeded"
  | "deployment_failed"
  | "automatic_rollback_succeeded"
  | "rollback_succeeded"
  | "rollback_failed"
  | "execution_cancelled"
  | "unknown_reconciled";

export type TenkaiTerminalOutcomeDeliveryState = "pending" | "in_flight" | "retrying" | "delivered";

export interface TenkaiTerminalOutcomeProjection {
  eventId: string;
  schema: "tenkai.terminal_outcome.v1";
  deploymentId: string;
  planId: string;
  releaseId: string;
  product: string;
  environmentId: string;
  configurationId: string;
  terminalState: TenkaiTerminalOutcomeState;
  observedAt: string;
  bindingDigest: string;
  releaseDigest: string;
  planDigest: string;
  configurationDigest: string;
  deliveryState: TenkaiTerminalOutcomeDeliveryState;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  claimUntil: string | null;
  deliveryLagMs: number;
}

export interface TenkaiTerminalOutcomeInspection {
  authority: "tenkai";
  state: "live" | "unavailable" | "unknown";
  outcomes: TenkaiTerminalOutcomeProjection[];
  warning: string | null;
}

export interface ReleaseDeliveryPlan {
  id: string;
  action: ReleaseWorkflowAction;
  sessionId: string | null;
  summary: string;
  details: string[];
  expiresAt: string;
}
