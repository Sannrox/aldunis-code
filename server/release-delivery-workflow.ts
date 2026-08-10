import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  deliveryCandidateIdentity,
  prepareReleaseCandidate,
  type PreparedReleaseCandidate,
} from "./release-candidate.ts";
import { RepositoryError } from "./repository.ts";
import type {
  ReleaseCompleteness,
  ReleaseDeliveryPlan,
  ReleaseDeliverySession as PublicReleaseDeliverySession,
  ReleaseWorkflowAction,
  ReleaseWorkflowState,
  TenkaiTerminalOutcomeDeliveryState,
  TenkaiTerminalOutcomeInspection,
  TenkaiTerminalOutcomeProjection,
  TenkaiTerminalOutcomeState,
} from "../src/contracts/release-delivery.ts";

export type {
  ReleaseCompleteness,
  ReleaseDeliveryPlan,
  ReleaseEvaluationReference,
  ReleaseWorkflowAction,
  ReleaseWorkflowState,
  TenkaiTerminalOutcomeDeliveryState,
  TenkaiTerminalOutcomeInspection,
  TenkaiTerminalOutcomeProjection,
  TenkaiTerminalOutcomeState,
} from "../src/contracts/release-delivery.ts";

const PLAN_TTL_MS = 5 * 60_000;
const MAX_SESSIONS = 50;
const MAX_OUTPUT = 256 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
const WORKFLOW_STATES: ReleaseWorkflowState[] = [
  "candidate_ready",
  "governance_allowed",
  "governance_denied",
  "governance_unavailable",
  "governance_unknown",
  "published",
  "publication_unknown",
  "promoted",
  "planned",
  "applying",
  "recovered",
  "completed",
  "failed",
  "unknown",
  "stale",
];
const COMPLETENESS_VALUES: ReleaseCompleteness[] = ["complete", "partial", "stale", "unknown"];
const TERMINAL_OUTCOME_STATES = [
  "deployment_succeeded",
  "deployment_failed",
  "automatic_rollback_succeeded",
  "rollback_succeeded",
  "rollback_failed",
  "execution_cancelled",
  "unknown_reconciled",
] as const;
const TERMINAL_OUTCOME_DELIVERY_STATES = ["pending", "in_flight", "retrying", "delivered"] as const;

export interface ReleaseDeliverySession extends PublicReleaseDeliverySession {
  repository: string;
  worktree: string;
  candidate: PreparedReleaseCandidate;
}

interface PendingReleasePlan extends ReleaseDeliveryPlan {
  repository: string;
  worktree: string;
  projectId: string;
  namespace: string;
  candidate: PreparedReleaseCandidate;
  reason: string | null;
  sessionBinding: string | null;
  used: boolean;
}

export interface ReleaseDeliveryInspection {
  configuration: {
    chisei: boolean;
    tenkai: boolean;
    localOnly: true;
  };
  sessions: Array<Omit<ReleaseDeliverySession, "repository" | "worktree">>;
  terminalOutcomes: TenkaiTerminalOutcomeInspection;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export type ReleaseCommandRunner = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

interface MachineResult {
  schema: "tenkai.command-result/v1";
  command: string;
  outcome: "succeeded" | "failed" | "awaiting_approval" | "unknown";
  retry: "not_needed" | "correct_request" | "reconcile_before_retry" | "not_safe";
  resources: Array<{ kind: string; id: string }>;
  counts?: { steps?: number; items?: number };
  error?: { code: string; message: string };
}

interface EnvironmentInspection {
  name: string;
  id: string;
  subscriptions: Array<{
    product: string;
    channel: string;
    head: string;
    deployed: string | null;
    health: string | null;
    error: string | null;
    state: string;
  }>;
  latest_plan: {
    id: string;
    state: string;
    step_count: number;
    steps_truncated: boolean;
    steps: Array<{
      product: string;
      to: string | null;
      release_id: string;
    }>;
  } | null;
  terminalOutcomes: TenkaiTerminalOutcomeProjection[];
}

interface ReleaseInspection {
  release_id: string;
  product: string;
  version: string;
  status: string;
  manifest_digest: string;
  artifact_digest: string;
  governance_provenance: Array<{
    profile: string;
    issuer: string;
    subject: string;
    envelope_digest: string;
    decision: string;
    receipt_schema: string;
    receipt_digest: string;
    observed_at: string;
    expires_at: string;
  }>;
}

interface PersistedReleaseSessions {
  schema: "aldunis.release-delivery-sessions/v1";
  sessions: ReleaseDeliverySession[];
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:gh[opsu]_|github_pat_|sk-)[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/[A-Za-z]:\\[^\s]+|\/(?:Users|home)\/[^\s]+/g, "[local path]")
    .trim()
    .slice(0, 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new RepositoryError(`${label} contains an incompatible field.`, 502);
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) {
    throw new RepositoryError(`${label} is incompatible.`, 502);
  }
  return value;
}

function parseMachineResult(output: string, expectedCommand: string): MachineResult {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    throw new RepositoryError("Tenkai returned an unknown machine result.", 502);
  }
  if (!isRecord(value))
    throw new RepositoryError("Tenkai returned an incompatible machine result.", 502);
  exactKeys(
    value,
    ["schema", "command", "outcome", "retry", "resources", "counts", "error"],
    "The Tenkai result",
  );
  if (value.schema !== "tenkai.command-result/v1" || value.command !== expectedCommand) {
    throw new RepositoryError("Tenkai returned an incompatible command result.", 502);
  }
  if (!["succeeded", "failed", "awaiting_approval", "unknown"].includes(String(value.outcome))) {
    throw new RepositoryError("Tenkai returned an incompatible outcome.", 502);
  }
  if (
    !["not_needed", "correct_request", "reconcile_before_retry", "not_safe"].includes(
      String(value.retry),
    )
  ) {
    throw new RepositoryError("Tenkai returned incompatible retry guidance.", 502);
  }
  if (!Array.isArray(value.resources) || value.resources.length > 8) {
    throw new RepositoryError("Tenkai returned incompatible resource references.", 502);
  }
  const resources = value.resources.map((resource) => {
    if (!isRecord(resource))
      throw new RepositoryError("Tenkai returned an incompatible resource.", 502);
    exactKeys(resource, ["kind", "id"], "A Tenkai resource");
    const kind = boundedString(resource.kind, "A Tenkai resource kind", 64);
    const id = boundedString(resource.id, "A Tenkai resource identity", 512);
    if (!OPAQUE_ID.test(kind) || !OPAQUE_ID.test(id)) {
      throw new RepositoryError("Tenkai returned an invalid resource reference.", 502);
    }
    return { kind, id };
  });
  return {
    schema: "tenkai.command-result/v1",
    command: expectedCommand,
    outcome: value.outcome as MachineResult["outcome"],
    retry: value.retry as MachineResult["retry"],
    resources,
    ...(isRecord(value.counts) ? { counts: value.counts as MachineResult["counts"] } : {}),
    ...(isRecord(value.error) ? { error: value.error as MachineResult["error"] } : {}),
  };
}

function parseEpochMillis(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RepositoryError(`${label} is incompatible.`, 502);
  }
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) {
    throw new RepositoryError(`${label} is incompatible.`, 502);
  }
  return date.toISOString();
}

function parseTerminalOutcome(value: unknown): TenkaiTerminalOutcomeProjection {
  if (!isRecord(value))
    throw new RepositoryError("Tenkai returned an incompatible terminal outcome.", 502);
  exactKeys(
    value,
    [
      "event_id",
      "schema",
      "deployment_id",
      "plan_id",
      "release_id",
      "product",
      "environment_id",
      "configuration_id",
      "terminal_state",
      "observed_at",
      "binding_digest",
      "release_digest",
      "plan_digest",
      "configuration_digest",
      "delivery_state",
      "attempts",
      "next_attempt_at",
      "delivered_at",
      "claim_until",
      "delivery_lag_ms",
    ],
    "A Tenkai terminal outcome",
  );
  const eventId = boundedString(value.event_id, "A Tenkai terminal outcome event identity");
  if (!OPAQUE_ID.test(eventId))
    throw new RepositoryError("Tenkai returned an invalid terminal outcome identity.", 502);
  if (value.schema !== "tenkai.terminal_outcome.v1") {
    throw new RepositoryError("Tenkai returned an incompatible terminal outcome schema.", 502);
  }
  const terminalState = value.terminal_state;
  if (!TERMINAL_OUTCOME_STATES.includes(terminalState as TenkaiTerminalOutcomeState)) {
    throw new RepositoryError("Tenkai returned an incompatible terminal outcome state.", 502);
  }
  const deliveryState = value.delivery_state;
  if (
    !TERMINAL_OUTCOME_DELIVERY_STATES.includes(deliveryState as TenkaiTerminalOutcomeDeliveryState)
  ) {
    throw new RepositoryError(
      "Tenkai returned an incompatible terminal outcome delivery state.",
      502,
    );
  }
  const attempts = value.attempts;
  if (!Number.isSafeInteger(attempts) || Number(attempts) < 0 || Number(attempts) > 1_000_000) {
    throw new RepositoryError("Tenkai returned incompatible terminal outcome attempts.", 502);
  }
  const deliveryLagMs = value.delivery_lag_ms;
  if (!Number.isSafeInteger(deliveryLagMs) || Number(deliveryLagMs) < 0) {
    throw new RepositoryError("Tenkai returned incompatible terminal outcome delivery lag.", 502);
  }
  const identities = [
    value.deployment_id,
    value.plan_id,
    value.release_id,
    value.product,
    value.environment_id,
    value.configuration_id,
  ].map((item, index) => boundedString(item, `A Tenkai terminal outcome identity ${index + 1}`));
  if (identities.some((item) => !OPAQUE_ID.test(item))) {
    throw new RepositoryError("Tenkai returned an invalid terminal outcome reference.", 502);
  }
  const digests = [
    value.binding_digest,
    value.release_digest,
    value.plan_digest,
    value.configuration_digest,
  ].map((item, index) => boundedString(item, `A Tenkai terminal outcome digest ${index + 1}`, 71));
  if (digests.some((item) => !SHA256.test(item))) {
    throw new RepositoryError("Tenkai returned invalid terminal outcome digests.", 502);
  }
  return {
    eventId,
    schema: "tenkai.terminal_outcome.v1",
    deploymentId: identities[0]!,
    planId: identities[1]!,
    releaseId: identities[2]!,
    product: identities[3]!,
    environmentId: identities[4]!,
    configurationId: identities[5]!,
    terminalState: terminalState as TenkaiTerminalOutcomeState,
    observedAt: parseEpochMillis(value.observed_at, "A Tenkai terminal outcome observation time")!,
    bindingDigest: digests[0]!,
    releaseDigest: digests[1]!,
    planDigest: digests[2]!,
    configurationDigest: digests[3]!,
    deliveryState: deliveryState as TenkaiTerminalOutcomeDeliveryState,
    attempts: Number(attempts),
    // Tenkai's TerminalOutcomeProjection contract defines next_attempt_at as
    // a required i64 even after delivery; only delivered_at and claim_until
    // are nullable.
    nextAttemptAt: parseEpochMillis(value.next_attempt_at, "A Tenkai next-attempt time")!,
    deliveredAt: parseEpochMillis(
      value.delivered_at,
      "A Tenkai delivery acknowledgement time",
      true,
    ),
    claimUntil: parseEpochMillis(value.claim_until, "A Tenkai delivery claim time", true),
    deliveryLagMs: Number(deliveryLagMs),
  };
}

function parseEnvironmentInspection(output: string): EnvironmentInspection {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new RepositoryError("Tenkai environment reconciliation returned incompatible data.", 502);
  }
  if (!isRecord(value)) throw new RepositoryError("Tenkai environment reconciliation failed.", 502);
  exactKeys(
    value,
    [
      "name",
      "id",
      "description",
      "subscriptions",
      "facts",
      "lease",
      "latest_plan",
      "terminal_outcomes",
      "execution_note",
    ],
    "The Tenkai environment",
  );
  const name = boundedString(value.name, "The Tenkai environment name", 128);
  const id = boundedString(value.id, "The Tenkai environment identity", 512);
  if (!Array.isArray(value.subscriptions) || value.subscriptions.length > 100) {
    throw new RepositoryError("Tenkai returned incompatible environment subscriptions.", 502);
  }
  const subscriptions = value.subscriptions.map((item) => {
    if (!isRecord(item))
      throw new RepositoryError("Tenkai returned an incompatible subscription.", 502);
    exactKeys(
      item,
      ["product", "channel", "head", "deployed", "health", "error", "state"],
      "A Tenkai subscription",
    );
    return {
      product: boundedString(item.product, "A Tenkai product", 128),
      channel: boundedString(item.channel, "A Tenkai channel", 128),
      head: boundedString(item.head, "A Tenkai channel head", 128),
      deployed:
        item.deployed === null ? null : boundedString(item.deployed, "A deployed version", 128),
      health: item.health === null ? null : boundedString(item.health, "Tenkai health", 128),
      error:
        item.error === null ? null : boundedString(item.error, "A Tenkai error reference", 500),
      state: boundedString(item.state, "A Tenkai subscription state", 64),
    };
  });
  let latestPlan: EnvironmentInspection["latest_plan"] = null;
  if (value.latest_plan !== null) {
    if (!isRecord(value.latest_plan))
      throw new RepositoryError("Tenkai returned an incompatible latest plan.", 502);
    exactKeys(
      value.latest_plan,
      ["id", "state", "created_at", "step_count", "status_detail", "steps", "steps_truncated"],
      "The latest Tenkai plan",
    );
    if (!Array.isArray(value.latest_plan.steps) || value.latest_plan.steps.length > 256) {
      throw new RepositoryError("Tenkai returned incompatible plan steps.", 502);
    }
    if (
      !Number.isSafeInteger(value.latest_plan.step_count) ||
      Number(value.latest_plan.step_count) < 0 ||
      typeof value.latest_plan.steps_truncated !== "boolean" ||
      (value.latest_plan.steps_truncated === false &&
        value.latest_plan.step_count !== value.latest_plan.steps.length)
    ) {
      throw new RepositoryError("Tenkai returned inconsistent plan step metadata.", 502);
    }
    latestPlan = {
      id: boundedString(value.latest_plan.id, "The latest Tenkai plan identity", 512),
      state: boundedString(value.latest_plan.state, "The latest Tenkai plan state", 64),
      step_count: value.latest_plan.step_count,
      steps_truncated: value.latest_plan.steps_truncated,
      steps: value.latest_plan.steps.map((step) => {
        if (!isRecord(step))
          throw new RepositoryError("Tenkai returned an incompatible plan step.", 502);
        exactKeys(
          step,
          ["id", "order", "product", "action", "from", "to", "release_id"],
          "A Tenkai plan step",
        );
        return {
          product: boundedString(step.product, "A planned product", 128),
          to: step.to === null ? null : boundedString(step.to, "A planned version", 128),
          release_id: boundedString(step.release_id, "A planned release", 512),
        };
      }),
    };
  }
  let terminalOutcomes: TenkaiTerminalOutcomeProjection[] = [];
  if (value.terminal_outcomes !== undefined) {
    if (!Array.isArray(value.terminal_outcomes) || value.terminal_outcomes.length > 100) {
      throw new RepositoryError("Tenkai returned incompatible terminal outcomes.", 502);
    }
    terminalOutcomes = value.terminal_outcomes.map(parseTerminalOutcome);
  }
  return { name, id, subscriptions, latest_plan: latestPlan, terminalOutcomes };
}

function parseReleaseInspection(output: string): ReleaseInspection {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new RepositoryError("Tenkai release reconciliation returned incompatible data.", 502);
  }
  if (!isRecord(value)) throw new RepositoryError("Tenkai release reconciliation failed.", 502);
  exactKeys(
    value,
    [
      "release_id",
      "product",
      "version",
      "status",
      "algorithm",
      "signer_identity",
      "signer_key_id",
      "manifest_digest",
      "artifact_digest",
      "statement_digest",
      "provenance",
      "governance_provenance",
    ],
    "The Tenkai release",
  );
  if (!Array.isArray(value.governance_provenance) || value.governance_provenance.length > 4) {
    throw new RepositoryError("Tenkai returned incompatible governance provenance.", 502);
  }
  return {
    release_id: boundedString(value.release_id, "The Tenkai release identity", 512),
    product: boundedString(value.product, "The Tenkai release product", 128),
    version: boundedString(value.version, "The Tenkai release version", 128),
    status: boundedString(value.status, "The Tenkai release status", 64),
    manifest_digest: boundedString(value.manifest_digest, "The Tenkai manifest digest", 64),
    artifact_digest: boundedString(value.artifact_digest, "The Tenkai artifact digest", 64),
    governance_provenance: value.governance_provenance.map((item) => {
      if (!isRecord(item)) {
        throw new RepositoryError("Tenkai returned incompatible governance provenance.", 502);
      }
      exactKeys(
        item,
        [
          "profile",
          "issuer",
          "issuer_key_id",
          "subject",
          "envelope_digest",
          "decision",
          "receipt_schema",
          "receipt_digest",
          "governed_references",
          "observed_at_unix_ms",
          "expires_at_unix_ms",
        ],
        "Tenkai governance provenance",
      );
      const envelopeDigest = boundedString(
        item.envelope_digest,
        "A provenance envelope digest",
        71,
      );
      const receiptDigest = boundedString(item.receipt_digest, "A provenance receipt digest", 71);
      if (!SHA256.test(envelopeDigest) || !SHA256.test(receiptDigest)) {
        throw new RepositoryError("Tenkai returned invalid governance provenance digests.", 502);
      }
      const observedAt = Number(item.observed_at_unix_ms);
      const expiresAt = Number(item.expires_at_unix_ms);
      if (
        !Number.isSafeInteger(observedAt) ||
        !Number.isSafeInteger(expiresAt) ||
        observedAt <= 0 ||
        expiresAt <= observedAt
      ) {
        throw new RepositoryError("Tenkai returned an invalid governance provenance window.", 502);
      }
      return {
        profile: boundedString(item.profile, "A provenance profile", 128),
        issuer: boundedString(item.issuer, "A provenance issuer", 128),
        subject: boundedString(item.subject, "A provenance subject", 512),
        envelope_digest: envelopeDigest,
        decision: boundedString(item.decision, "A provenance decision", 32),
        receipt_schema: boundedString(item.receipt_schema, "A provenance receipt schema", 128),
        receipt_digest: receiptDigest,
        observed_at: new Date(observedAt).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      };
    }),
  };
}

async function defaultRunner(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const failure = error as
          (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        resolveResult({
          stdout,
          stderr,
          exitCode: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
          timedOut: Boolean(failure?.killed && failure.signal === "SIGTERM"),
          aborted: options.signal?.aborted ?? false,
        });
      },
    );
  });
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

function publicSession(
  session: ReleaseDeliverySession,
): Omit<ReleaseDeliverySession, "repository" | "worktree"> {
  const { repository: _repository, worktree: _worktree, ...projection } = session;
  return projection;
}

function outcomesForSessions(
  outcomes: TenkaiTerminalOutcomeProjection[],
  sessions: ReleaseDeliverySession[],
): TenkaiTerminalOutcomeProjection[] {
  const references = new Set(
    sessions
      .flatMap((session) => [
        session.tenkai.releaseId,
        session.tenkai.planId,
        session.tenkai.rollbackPlanId,
      ])
      .filter((value): value is string => value !== null),
  );
  const products = new Set(sessions.map((session) => session.candidate.product));
  if (references.size === 0) return [];
  return outcomes
    .filter(
      (outcome) =>
        products.has(outcome.product) &&
        (references.has(outcome.releaseId) || references.has(outcome.planId)),
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
    .slice(0, 32);
}

function persistedCandidate(candidate: PreparedReleaseCandidate): PreparedReleaseCandidate {
  return {
    ...candidate,
    build: {
      ...candidate.build,
      commands: candidate.build.commands.map((command) => ({
        ...command,
        declared: "[omitted from local history]",
      })),
    },
  };
}

function exactShape(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function validText(value: unknown, maximum = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function validOptionalText(value: unknown, maximum = 512): value is string | null {
  return value === null || validText(value, maximum);
}

function validOpaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function validOptionalOpaque(value: unknown): value is string | null {
  return value === null || validOpaque(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validCandidate(value: unknown): value is PreparedReleaseCandidate {
  if (
    !isRecord(value) ||
    !exactShape(value, [
      "identity",
      "document",
      "chisei",
      "product",
      "version",
      "release",
      "manifestPath",
      "build",
    ]) ||
    !SHA256.test(String(value.identity)) ||
    !validText(value.product, 128) ||
    !validText(value.version, 128) ||
    value.release !== `${value.product}@${value.version}` ||
    !validText(value.manifestPath, 1_024) ||
    value.manifestPath.startsWith("/") ||
    value.manifestPath.split("/").some((part) => !part || part === "." || part === "..") ||
    !isRecord(value.document) ||
    !exactShape(value.document, [
      "schema",
      "repository",
      "commit",
      "source_tree_digest",
      "manifest",
      "artifacts",
      "build_definition_digest",
    ]) ||
    value.document.schema !== "aldunis.delivery-candidate/v1" ||
    !isRecord(value.document.repository) ||
    !exactShape(value.document.repository, ["authority", "id"]) ||
    value.document.repository.authority !== "git" ||
    !validText(value.document.repository.id, 2_048) ||
    !isRecord(value.document.commit) ||
    !exactShape(value.document.commit, ["algorithm", "oid"]) ||
    !["sha1", "sha256"].includes(String(value.document.commit.algorithm)) ||
    typeof value.document.commit.oid !== "string" ||
    !(
      (value.document.commit.algorithm === "sha1" &&
        /^[0-9a-f]{40}$/.test(value.document.commit.oid)) ||
      (value.document.commit.algorithm === "sha256" &&
        /^[0-9a-f]{64}$/.test(value.document.commit.oid))
    ) ||
    !SHA256.test(String(value.document.source_tree_digest)) ||
    !isRecord(value.document.manifest) ||
    !exactShape(value.document.manifest, ["path", "digest"]) ||
    value.document.manifest.path !== value.manifestPath ||
    !SHA256.test(String(value.document.manifest.digest)) ||
    !Array.isArray(value.document.artifacts) ||
    value.document.artifacts.length < 1 ||
    value.document.artifacts.length > 64 ||
    value.document.artifacts.some(
      (artifact) =>
        !isRecord(artifact) ||
        !exactShape(artifact, ["media_type", "size", "digest", "location_class"]) ||
        !validText(artifact.media_type, 256) ||
        !Number.isSafeInteger(artifact.size) ||
        Number(artifact.size) < 0 ||
        !SHA256.test(String(artifact.digest)) ||
        !["local", "oci"].includes(String(artifact.location_class)),
    ) ||
    !SHA256.test(String(value.document.build_definition_digest)) ||
    !isRecord(value.chisei) ||
    !exactShape(value.chisei, [
      "revision",
      "source_tree_digest",
      "manifest_digest",
      "artifact_reference",
      "artifact_digest",
      "build_definition_digest",
    ]) ||
    value.chisei.revision !== value.document.commit.oid ||
    value.chisei.source_tree_digest !== value.document.source_tree_digest ||
    value.chisei.manifest_digest !== value.document.manifest.digest ||
    value.chisei.artifact_digest !== value.document.artifacts[0]?.digest ||
    value.chisei.build_definition_digest !== value.document.build_definition_digest ||
    !validText(value.chisei.artifact_reference, 512) ||
    !isRecord(value.build) ||
    !exactShape(value.build, ["adapter", "commands", "definitionDigest"]) ||
    value.build.adapter !== "npm" ||
    value.build.definitionDigest !== value.document.build_definition_digest ||
    !Array.isArray(value.build.commands) ||
    value.build.commands.length !== 3
  )
    return false;
  const commandIds = ["install", "build", "test"];
  if (
    value.build.commands.some(
      (command, index) =>
        !isRecord(command) ||
        !exactShape(command, ["id", "executable", "args", "declared"]) ||
        command.id !== commandIds[index] ||
        command.executable !== "npm" ||
        !Array.isArray(command.args) ||
        command.args.length > 8 ||
        command.args.some((argument) => !validText(argument, 128)) ||
        !validText(command.declared, 512),
    )
  )
    return false;
  try {
    return (
      value.identity ===
      deliveryCandidateIdentity(value.document as PreparedReleaseCandidate["document"])
    );
  } catch {
    return false;
  }
}

function validSession(value: unknown): value is ReleaseDeliverySession {
  if (
    !isRecord(value) ||
    !exactShape(value, [
      "schemaVersion",
      "id",
      "projectId",
      "repository",
      "worktree",
      "candidate",
      "state",
      "completeness",
      "buildEvidence",
      "evaluation",
      "tenkai",
      "error",
      "createdAt",
      "updatedAt",
    ]) ||
    value.schemaVersion !== 1 ||
    !validOpaque(value.id) ||
    !validOpaque(value.projectId) ||
    !validText(value.repository, 4_096) ||
    !validText(value.worktree, 4_096) ||
    resolve(value.repository) !== value.repository ||
    resolve(value.worktree) !== value.worktree ||
    !validCandidate(value.candidate) ||
    !WORKFLOW_STATES.includes(value.state as ReleaseWorkflowState) ||
    !COMPLETENESS_VALUES.includes(value.completeness as ReleaseCompleteness) ||
    !isRecord(value.buildEvidence) ||
    !exactShape(value.buildEvidence, ["digest", "commands", "observedAt"]) ||
    !SHA256.test(String(value.buildEvidence.digest)) ||
    !Array.isArray(value.buildEvidence.commands) ||
    value.buildEvidence.commands.length !== 3 ||
    value.buildEvidence.commands.some(
      (command, index) =>
        !isRecord(command) ||
        !exactShape(command, ["id", "status"]) ||
        command.id !== ["install", "build", "test"][index] ||
        command.status !== "passed",
    ) ||
    !validTimestamp(value.buildEvidence.observedAt) ||
    value.buildEvidence.digest !==
      sha256(
        JSON.stringify({
          schema: "aldunis.build-evidence/v1",
          candidate: value.candidate.identity,
          commands: value.buildEvidence.commands.map((command) => ({
            id: (command as Record<string, unknown>).id,
            status: (command as Record<string, unknown>).status,
          })),
        }),
      )
  )
    return false;
  if (value.evaluation !== null) {
    if (
      !isRecord(value.evaluation) ||
      !exactShape(value.evaluation, [
        "decision",
        "operationId",
        "receiptSchema",
        "receiptDigest",
        "references",
        "fresh",
        "observedAt",
      ]) ||
      !["allow", "deny", "unavailable", "unknown"].includes(String(value.evaluation.decision)) ||
      !validOpaque(value.evaluation.operationId) ||
      value.evaluation.receiptSchema !== "chisei.governed-subject-receipt/v1" ||
      !SHA256.test(String(value.evaluation.receiptDigest)) ||
      typeof value.evaluation.fresh !== "boolean" ||
      !validTimestamp(value.evaluation.observedAt) ||
      !Array.isArray(value.evaluation.references) ||
      value.evaluation.references.length > 16 ||
      value.evaluation.references.some(
        (reference) =>
          !isRecord(reference) ||
          !exactShape(reference, ["kind", "reference", "contentDigest", "observedAt"]) ||
          !validText(reference.kind, 64) ||
          !validText(reference.reference) ||
          !SHA256.test(String(reference.contentDigest)) ||
          !validTimestamp(reference.observedAt),
      )
    )
      return false;
    const expectedReferences = new Map([
      [
        "source_tree",
        {
          reference: value.candidate.chisei.source_tree_digest,
          digest: value.candidate.chisei.source_tree_digest,
        },
      ],
      [
        "manifest",
        {
          reference: value.candidate.chisei.manifest_digest,
          digest: value.candidate.chisei.manifest_digest,
        },
      ],
      [
        "artifact",
        {
          reference: value.candidate.chisei.artifact_reference,
          digest: value.candidate.chisei.artifact_digest,
        },
      ],
      [
        "build_definition",
        {
          reference: value.candidate.chisei.build_definition_digest,
          digest: value.candidate.chisei.build_definition_digest,
        },
      ],
    ]);
    if (
      value.evaluation.references.length !== expectedReferences.size ||
      value.evaluation.references.some((reference) => {
        if (!isRecord(reference)) return true;
        const expected = expectedReferences.get(String(reference.kind));
        return (
          !expected ||
          reference.reference !== expected.reference ||
          reference.contentDigest !== expected.digest
        );
      }) ||
      new Set(
        value.evaluation.references.map((reference) =>
          isRecord(reference) ? reference.kind : null,
        ),
      ).size !== expectedReferences.size
    )
      return false;
  }
  if (
    !isRecord(value.tenkai) ||
    !exactShape(value.tenkai, [
      "releaseId",
      "provenanceDigest",
      "channelId",
      "planId",
      "environmentId",
      "planState",
      "deployedVersion",
      "health",
      "rollbackPlanId",
      "provenanceExpiresAt",
      "observedAt",
    ]) ||
    !validOptionalOpaque(value.tenkai.releaseId) ||
    !(
      value.tenkai.provenanceDigest === null || SHA256.test(String(value.tenkai.provenanceDigest))
    ) ||
    !validOptionalOpaque(value.tenkai.channelId) ||
    !validOptionalOpaque(value.tenkai.planId) ||
    !validOptionalOpaque(value.tenkai.environmentId) ||
    !validOptionalText(value.tenkai.planState, 64) ||
    !validOptionalText(value.tenkai.deployedVersion, 128) ||
    !validOptionalText(value.tenkai.health, 64) ||
    !validOptionalOpaque(value.tenkai.rollbackPlanId) ||
    !(
      value.tenkai.provenanceExpiresAt === null || validTimestamp(value.tenkai.provenanceExpiresAt)
    ) ||
    !(value.tenkai.observedAt === null || validTimestamp(value.tenkai.observedAt)) ||
    !(value.error === null || validText(value.error, 500)) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt)
  )
    return false;
  return true;
}

export class ReleaseDeliveryStore {
  readonly #path: string;
  #writeQueue = Promise.resolve();

  constructor(readonly directory: string) {
    this.#path = join(directory, "release-deliveries.v1.json");
  }

  async load(): Promise<ReleaseDeliverySession[]> {
    let bytes: string;
    try {
      bytes = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RepositoryError("Local release-delivery history could not be read.", 500);
    }
    try {
      const parsed = JSON.parse(bytes) as PersistedReleaseSessions;
      if (
        parsed.schema !== "aldunis.release-delivery-sessions/v1" ||
        !Array.isArray(parsed.sessions) ||
        parsed.sessions.length > MAX_SESSIONS ||
        parsed.sessions.some((session) => !validSession(session))
      ) {
        throw new Error("invalid");
      }
      return structuredClone(parsed.sessions);
    } catch {
      throw new RepositoryError("Local release-delivery history is corrupt.", 500);
    }
  }

  async put(session: ReleaseDeliverySession): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const sessions = await this.load();
      const next = [session, ...sessions.filter((item) => item.id !== session.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_SESSIONS);
      const temporary = join(this.directory, `.release-deliveries-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            schema: "aldunis.release-delivery-sessions/v1",
            sessions: next,
          } satisfies PersistedReleaseSessions),
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.#path);
        const directory = await open(dirname(this.#path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

export class ReleaseDeliveryBroker {
  readonly #plans = new Map<string, PendingReleasePlan>();
  readonly #sessionExecutions = new Map<string, Promise<void>>();

  constructor(
    readonly store: ReleaseDeliveryStore,
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly runner: ReleaseCommandRunner = defaultRunner,
  ) {}

  async inspect(
    projectId: string,
    repository: string,
    worktree: string,
  ): Promise<ReleaseDeliveryInspection> {
    const localSessions = (await this.store.load()).filter(
      (item) =>
        item.projectId === projectId &&
        item.repository === repository &&
        item.worktree === worktree,
    );
    const sessions = localSessions.map(publicSession);
    return {
      configuration: {
        chisei: Boolean(
          this.env.ALDUNIS_CHISEI_ENDPOINT?.trim() && this.env.ALDUNIS_CHISEI_TOKEN?.trim(),
        ),
        tenkai: Boolean(this.env.ALDUNIS_TENKAI_DATABASE?.trim()),
        localOnly: true,
      },
      sessions,
      terminalOutcomes: await this.#inspectTerminalOutcomes(worktree, localSessions),
    };
  }

  async #inspectTerminalOutcomes(
    worktree: string,
    sessions: ReleaseDeliverySession[],
  ): Promise<TenkaiTerminalOutcomeInspection> {
    if (!this.env.ALDUNIS_TENKAI_DATABASE?.trim()) {
      return {
        authority: "tenkai",
        state: "unavailable",
        outcomes: [],
        warning: "Tenkai is not configured on this local host.",
      };
    }
    try {
      const environment = await this.#inspectEnvironment(worktree);
      return {
        authority: "tenkai",
        state: "live",
        outcomes: outcomesForSessions(environment.terminalOutcomes, sessions),
        warning: null,
      };
    } catch {
      return {
        authority: "tenkai",
        state: "unknown",
        outcomes: [],
        warning: "The authoritative Tenkai terminal-outcome projection is unavailable.",
      };
    }
  }

  async #session(id: string, repository: string, worktree: string, projectId: string) {
    const session = (await this.store.load()).find((item) => item.id === id);
    if (!session) throw new RepositoryError("The release-delivery session is unavailable.", 404);
    if (
      session.repository !== repository ||
      session.worktree !== worktree ||
      session.projectId !== projectId
    ) {
      throw new RepositoryError("The release-delivery session belongs to another workspace.", 403);
    }
    return session;
  }

  async #freshCandidate(session: ReleaseDeliverySession): Promise<PreparedReleaseCandidate> {
    const current = await prepareReleaseCandidate(
      session.repository,
      session.worktree,
      session.candidate.manifestPath,
    );
    if (current.identity !== session.candidate.identity) {
      const stale = {
        ...session,
        state: "stale" as const,
        completeness: "stale" as const,
        error: "The committed source, manifest, artifact, or build definition changed.",
        updatedAt: new Date().toISOString(),
      };
      await this.store.put(stale);
      throw new RepositoryError(
        "The release candidate changed. Prepare and evaluate a new candidate.",
        409,
      );
    }
    return current;
  }

  async plan(
    projectId: string,
    repository: string,
    worktree: string,
    namespace: string,
    action: ReleaseWorkflowAction,
    input: Record<string, unknown>,
  ): Promise<ReleaseDeliveryPlan> {
    for (const [id, plan] of this.#plans) {
      if (plan.used || Date.parse(plan.expiresAt) <= Date.now()) this.#plans.delete(id);
    }
    let session: ReleaseDeliverySession | null = null;
    let candidate: PreparedReleaseCandidate;
    let summary: string;
    let details: string[];
    let reason: string | null = null;
    if (action === "prepare") {
      if (typeof input.manifestPath !== "string") {
        throw new RepositoryError("A repository-relative Tenkai manifest is required.");
      }
      candidate = await prepareReleaseCandidate(repository, worktree, input.manifestPath);
      summary = `Build and test ${candidate.release}`;
      details = [
        `candidate: ${candidate.identity}`,
        `revision: ${candidate.document.commit.oid}`,
        `manifest: ${candidate.manifestPath}`,
        `artifact: ${candidate.document.artifacts[0]?.digest}`,
        ...candidate.build.commands.map((command) => `${command.id}: ${command.declared}`),
        "execution: repository-declared npm scripts run from a detached snapshot of the reviewed commit",
      ];
    } else {
      if (typeof input.sessionId !== "string")
        throw new RepositoryError("A delivery session is required.");
      session = await this.#session(input.sessionId, repository, worktree, projectId);
      candidate = await this.#freshCandidate(session);
      const allowed: Record<Exclude<ReleaseWorkflowAction, "prepare">, ReleaseWorkflowState[]> = {
        evaluate: [
          "candidate_ready",
          "governance_denied",
          "governance_unavailable",
          "governance_unknown",
        ],
        publish: ["governance_allowed"],
        promote: ["published"],
        plan: ["promoted"],
        apply: ["planned"],
        reconcile: [
          "published",
          "publication_unknown",
          "promoted",
          "planned",
          "applying",
          "completed",
          "failed",
          "unknown",
          "recovered",
        ],
        rollback: ["completed", "failed", "unknown"],
      };
      if (!allowed[action].includes(session.state)) {
        throw new RepositoryError(
          `The ${action} action is unavailable from state ${session.state}.`,
          409,
        );
      }
      if (["promote", "plan", "apply"].includes(action) && !this.#provenanceFresh(session)) {
        throw new RepositoryError(
          "Fresh Chisei provenance is required before advancing this release.",
          409,
        );
      }
      if (action === "evaluate") {
        if (!namespace)
          throw new RepositoryError(
            "Bind this project to a Chisei namespace before evaluation.",
            409,
          );
        this.#requireChisei();
        summary = `Request Chisei evaluation for ${candidate.identity}`;
        details = [
          `authority: Sekai Chisei (${namespace})`,
          "profile: example.software-release-candidate/v1",
          `request: aldunis-${session.id}`,
          "local confirmation invokes the adapter; Chisei owns the decision",
        ];
      } else if (action === "publish") {
        if (session.evaluation?.decision !== "allow" || !session.evaluation.fresh) {
          throw new RepositoryError("A fresh authoritative Chisei allow receipt is required.", 409);
        }
        this.#requireTenkai();
        summary = `Publish ${candidate.release} to Tenkai`;
        details = [
          `release: ${candidate.release}`,
          `evidence: ${session.evaluation.receiptDigest}`,
          "release signing: unsigned-development (built-in local environment only)",
          "provenance: authenticated issuer sekai-chisei",
        ];
      } else if (action === "promote") {
        this.#requireTenkai();
        const environment = await this.#inspectEnvironment(worktree);
        const subscription = environment.subscriptions.find(
          (item) => item.product === candidate.product && item.channel === "stable",
        );
        if (!subscription) {
          throw new RepositoryError(
            `Tenkai local must already subscribe ${candidate.product}=stable before promotion.`,
            409,
          );
        }
        summary = `Promote ${candidate.release} to stable`;
        details = [
          `channel: ${candidate.product}/stable`,
          `environment: ${environment.name}`,
          `current head: ${subscription.head}`,
        ];
      } else if (action === "plan") {
        this.#requireTenkai();
        summary = "Create an immutable Tenkai plan for local";
        details = [
          "environment: local",
          `release: ${candidate.release}`,
          "Tenkai computes and owns the plan",
        ];
      } else if (action === "apply") {
        this.#requireTenkai();
        if (!session.tenkai.planId)
          throw new RepositoryError("A reconciled Tenkai plan is required.", 409);
        const environment = await this.#inspectEnvironment(worktree);
        if (!this.#isCandidateOnlyPlan(session, environment.latest_plan, session.tenkai.planId)) {
          throw new RepositoryError(
            "The Tenkai plan is not a complete single-release plan for this candidate.",
            409,
          );
        }
        summary = `Apply ${session.tenkai.planId} to local`;
        details = [
          `plan: ${session.tenkai.planId}`,
          `only change: ${candidate.product} -> ${candidate.version}`,
          "approval: explicit local-development bypass",
          "this confirmation is not Tenkai plan approval or Sekai policy approval",
          "health failure may trigger Tenkai-owned automatic rollback",
        ];
      } else if (action === "reconcile") {
        this.#requireTenkai();
        summary = `Reconcile ${candidate.release} with Tenkai`;
        details = [
          `release: ${session.tenkai.releaseId ?? candidate.release}`,
          "reads: authoritative release and local environment",
          "no subprocess exit is treated as delivery success",
        ];
      } else {
        this.#requireTenkai();
        reason = typeof input.reason === "string" ? input.reason.trim() : "";
        if (!reason || reason.length > 500 || reason.includes("\0")) {
          throw new RepositoryError("A bounded rollback reason is required.");
        }
        summary = `Roll back ${candidate.product} in local`;
        details = [
          `product: ${candidate.product}`,
          "environment: local",
          `reason: ${reason}`,
          "Tenkai owns rollback planning, execution, and terminal state",
        ];
      }
    }
    const pending: PendingReleasePlan = {
      id: randomUUID(),
      action,
      sessionId: session?.id ?? null,
      summary,
      details,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
      projectId,
      repository,
      worktree,
      namespace,
      candidate,
      reason,
      sessionBinding: session?.updatedAt ?? null,
      used: false,
    };
    this.#plans.set(pending.id, pending);
    const {
      repository: _repository,
      worktree: _worktree,
      projectId: _projectId,
      namespace: _namespace,
      candidate: _candidate,
      reason: _reason,
      sessionBinding: _sessionBinding,
      used: _used,
      ...projection
    } = pending;
    return projection;
  }

  async execute(
    id: string,
    projectId: string,
    repository: string,
    worktree: string,
    namespace: string,
    signal?: AbortSignal,
  ): Promise<Omit<ReleaseDeliverySession, "repository" | "worktree">> {
    const plan = this.#plans.get(id);
    if (!plan) throw new RepositoryError("The release-delivery preview does not exist.", 404);
    if (plan.used || Date.parse(plan.expiresAt) <= Date.now()) {
      this.#plans.delete(id);
      throw new RepositoryError("The release-delivery preview expired or was already used.", 409);
    }
    if (
      plan.projectId !== projectId ||
      plan.repository !== repository ||
      plan.worktree !== worktree
    ) {
      throw new RepositoryError("The release-delivery preview belongs to another workspace.", 403);
    }
    plan.used = true;
    this.#plans.delete(id);
    if (plan.action === "evaluate" && plan.namespace !== namespace) {
      throw new RepositoryError(
        "The project Chisei namespace changed after preview. Inspect the action again.",
        409,
      );
    }
    if (plan.action === "prepare") return publicSession(await this.#executePrepare(plan, signal));
    return this.#withSessionExecution(plan.sessionId!, async () => {
      const session = await this.#session(plan.sessionId!, repository, worktree, projectId);
      if (plan.sessionBinding !== session.updatedAt) {
        throw new RepositoryError(
          "The release-delivery state changed after preview. Inspect the action again.",
          409,
        );
      }
      await this.#freshCandidate(session);
      const next =
        plan.action === "evaluate"
          ? await this.#executeEvaluate(session, plan.namespace, signal)
          : plan.action === "publish"
            ? await this.#executePublish(session, signal)
            : plan.action === "promote"
              ? await this.#executePromote(session, signal)
              : plan.action === "plan"
                ? await this.#executePlan(session, signal)
                : plan.action === "apply"
                  ? await this.#executeApply(session, signal)
                  : plan.action === "rollback"
                    ? await this.#executeRollback(session, plan.reason!, signal)
                    : await this.#executeReconcile(session, signal);
      return publicSession(next);
    });
  }

  async #withSessionExecution<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionExecutions.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.#sessionExecutions.set(sessionId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#sessionExecutions.get(sessionId) === queued) {
        this.#sessionExecutions.delete(sessionId);
      }
    }
  }

  async receipt(
    id: string,
    projectId: string,
    repository: string,
    worktree: string,
  ): Promise<Record<string, unknown>> {
    const session = await this.#session(id, repository, worktree, projectId);
    const terminalOutcomes = await this.#inspectTerminalOutcomes(worktree, [session]);
    let completeness = session.completeness;
    const evaluationFresh =
      session.evaluation?.fresh === true &&
      (!session.tenkai.releaseId || this.#provenanceFresh(session));
    try {
      await this.#freshCandidate(session);
    } catch {
      completeness = "stale";
    }
    if (session.evaluation && !evaluationFresh) completeness = "stale";
    return {
      schema: "aldunis.delivery-receipt/v1",
      candidate: {
        identity: session.candidate.identity,
        repository: session.candidate.document.repository,
        commit: session.candidate.document.commit,
        source_tree_digest: session.candidate.document.source_tree_digest,
        manifest_digest: session.candidate.document.manifest.digest,
        artifact_digest: session.candidate.document.artifacts[0]?.digest,
        build_definition_digest: session.candidate.document.build_definition_digest,
      },
      build: {
        authority: "aldunis-code",
        evidence_digest: session.buildEvidence.digest,
        commands: session.buildEvidence.commands,
        observed_at: session.buildEvidence.observedAt,
      },
      sekai: session.evaluation
        ? {
            authority: "sekai-chisei",
            operation_id: session.evaluation.operationId,
            receipt_schema: session.evaluation.receiptSchema,
            receipt_digest: session.evaluation.receiptDigest,
            decision: session.evaluation.decision,
            fresh: evaluationFresh,
            observed_at: session.evaluation.observedAt,
          }
        : null,
      tenkai: {
        authority: "tenkai",
        release_id: session.tenkai.releaseId,
        provenance_digest: session.tenkai.provenanceDigest,
        channel_id: session.tenkai.channelId,
        plan_id: session.tenkai.planId,
        environment_id: session.tenkai.environmentId,
        plan_state: session.tenkai.planState,
        deployed_version: session.tenkai.deployedVersion,
        health: session.tenkai.health,
        rollback_plan_id: session.tenkai.rollbackPlanId,
        provenance_expires_at: session.tenkai.provenanceExpiresAt,
        observed_at: session.tenkai.observedAt,
        terminal_outcomes: terminalOutcomes,
      },
      state: session.state,
      completeness,
      observed_at: session.updatedAt,
    };
  }

  #requireChisei(): void {
    if (!this.env.ALDUNIS_CHISEI_ENDPOINT?.trim() || !this.env.ALDUNIS_CHISEI_TOKEN?.trim()) {
      throw new RepositoryError("Authenticated Chisei delivery evaluation is not configured.", 503);
    }
  }

  #requireTenkai(): void {
    if (!this.env.ALDUNIS_TENKAI_DATABASE?.trim()) {
      throw new RepositoryError("The Tenkai-owned local database is not configured.", 503);
    }
  }

  #commandEnvironment(kind: "build" | "chisei" | "tenkai"): NodeJS.ProcessEnv {
    const environment = {
      ...baseEnvironment(),
      HOME: join(this.store.directory, "release-tool-home"),
      CI: "1",
      NO_COLOR: "1",
    };
    if (kind === "build") {
      return {
        ...environment,
        npm_config_audit: "false",
        npm_config_cache: join(this.store.directory, "release-npm-cache"),
        npm_config_fund: "false",
        npm_config_userconfig: join(this.store.directory, "release-empty-npmrc"),
        npm_config_update_notifier: "false",
      };
    }
    if (kind === "chisei") {
      return {
        ...environment,
        CHISEI_GRPC_URL: this.env.ALDUNIS_CHISEI_ENDPOINT,
        SEKAI_TOKEN: this.env.ALDUNIS_CHISEI_TOKEN,
      };
    }
    return environment;
  }

  async #run(
    kind: "build" | "chisei" | "tenkai",
    executable: string,
    args: string[],
    cwd: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    await mkdir(join(this.store.directory, "release-tool-home"), {
      recursive: true,
      mode: 0o700,
    });
    const result = await this.runner(executable, args, {
      cwd,
      timeout,
      signal,
      env: this.#commandEnvironment(kind),
    });
    if (result.aborted) throw new RepositoryError("The local delivery action was cancelled.", 409);
    return result;
  }

  async #withCandidateSnapshot<T>(
    worktree: string,
    commit: string,
    purpose: "build" | "publish",
    operation: (snapshot: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const directory = join(this.store.directory, `release-${purpose}-${randomUUID()}`);
    const snapshot = join(directory, "worktree");
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const gitEnvironment = {
      ...baseEnvironment(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const checkout = await defaultRunner(
      "git",
      ["-C", worktree, "worktree", "add", "--detach", snapshot, commit],
      {
        cwd: worktree,
        env: gitEnvironment,
        timeout: 60_000,
        signal,
      },
    );
    if (checkout.aborted) {
      await rm(directory, { recursive: true, force: true });
      throw new RepositoryError("The local delivery action was cancelled.", 409);
    }
    if (checkout.exitCode !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new RepositoryError("The reviewed delivery snapshot could not be created.", 409);
    }
    try {
      return await operation(snapshot);
    } finally {
      await defaultRunner("git", ["-C", worktree, "worktree", "remove", "--force", snapshot], {
        cwd: worktree,
        env: gitEnvironment,
        timeout: 60_000,
      });
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #runBuildSnapshot(plan: PendingReleasePlan, signal?: AbortSignal): Promise<void> {
    await this.#withCandidateSnapshot(
      plan.worktree,
      plan.candidate.document.commit.oid,
      "build",
      async (snapshot) => {
        const gitEnvironment = {
          ...baseEnvironment(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        };
        for (const command of plan.candidate.build.commands) {
          if (command.id !== "install") {
            const restore = await defaultRunner(
              "git",
              ["-C", snapshot, "checkout", "HEAD", "--", "package.json", "package-lock.json"],
              {
                cwd: snapshot,
                env: gitEnvironment,
                timeout: 30_000,
                signal,
              },
            );
            if (restore.aborted) {
              throw new RepositoryError("The local delivery action was cancelled.", 409);
            }
            if (restore.exitCode !== 0) {
              throw new RepositoryError(
                "The reviewed package definition could not be restored.",
                409,
              );
            }
          }
          const result = await this.#run(
            "build",
            command.executable,
            command.args,
            snapshot,
            10 * 60_000,
            signal,
          );
          if (result.exitCode !== 0) {
            const detail = safeDiagnostic(result.stderr.split("\n").filter(Boolean).at(-1) ?? "");
            throw new RepositoryError(
              detail || `The declared npm ${command.id} command failed.`,
              409,
            );
          }
        }
      },
      signal,
    );
  }

  async #executePrepare(
    plan: PendingReleasePlan,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    const approved = await prepareReleaseCandidate(
      plan.repository,
      plan.worktree,
      plan.candidate.manifestPath,
    );
    if (approved.identity !== plan.candidate.identity) {
      throw new RepositoryError(
        "The repository changed after the delivery preview was created.",
        409,
      );
    }
    await this.#runBuildSnapshot(plan, signal);
    const fresh = await prepareReleaseCandidate(
      plan.repository,
      plan.worktree,
      plan.candidate.manifestPath,
    );
    if (fresh.identity !== plan.candidate.identity) {
      throw new RepositoryError(
        "The repository changed while build and test evidence was collected.",
        409,
      );
    }
    const observedAt = new Date().toISOString();
    const buildEvidence = {
      digest: sha256(
        JSON.stringify({
          schema: "aldunis.build-evidence/v1",
          candidate: fresh.identity,
          commands: fresh.build.commands.map((command) => ({ id: command.id, status: "passed" })),
        }),
      ),
      commands: fresh.build.commands.map((command) => ({
        id: command.id,
        status: "passed" as const,
      })),
      observedAt,
    };
    const session: ReleaseDeliverySession = {
      schemaVersion: 1,
      id: randomUUID(),
      projectId: plan.projectId,
      repository: plan.repository,
      worktree: plan.worktree,
      candidate: persistedCandidate(fresh),
      state: "candidate_ready",
      completeness: "partial",
      buildEvidence,
      evaluation: null,
      tenkai: {
        releaseId: null,
        provenanceDigest: null,
        channelId: null,
        planId: null,
        environmentId: null,
        planState: null,
        deployedVersion: null,
        health: null,
        rollbackPlanId: null,
        provenanceExpiresAt: null,
        observedAt: null,
      },
      error: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    };
    await this.store.put(session);
    return session;
  }

  async #temporary(session: ReleaseDeliverySession): Promise<string> {
    const directory = join(this.store.directory, `release-delivery-${session.id}-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  async #executeEvaluate(
    session: ReleaseDeliverySession,
    namespace: string,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    const temporary = await this.#temporary(session);
    const candidatePath = join(temporary, "candidate.json");
    await writeFile(candidatePath, JSON.stringify(session.candidate.chisei), { mode: 0o600 });
    try {
      const result = await this.#run(
        "chisei",
        this.env.ALDUNIS_SEKAICTL_PATH?.trim() || "sekaictl",
        [
          "admin",
          "governance",
          "subject",
          "software-release",
          candidatePath,
          "--namespace",
          namespace,
          "--request-id",
          `aldunis-${session.id}`,
          "--target",
          this.env.ALDUNIS_CHISEI_ENDPOINT!,
        ],
        session.worktree,
        60_000,
        signal,
      );
      if (result.timedOut || !result.stdout.trim()) {
        return this.#unknown(
          session,
          "governance_unknown",
          "Chisei evaluation did not return a complete authoritative result.",
        );
      }
      if (result.exitCode !== 0) {
        return this.#unknown(
          session,
          "governance_unavailable",
          "Chisei evaluation did not complete successfully.",
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(result.stdout);
      } catch {
        return this.#unknown(
          session,
          "governance_unknown",
          "Chisei evaluation returned an unknown outcome.",
        );
      }
      if (!isRecord(value))
        throw new RepositoryError("Chisei returned an incompatible evaluation.", 502);
      exactKeys(
        value,
        [
          "version",
          "decision",
          "operation_id",
          "receipt_schema",
          "receipt_digest",
          "references",
          "fresh",
          "failure_code",
          "failure_message",
        ],
        "The Chisei evaluation",
      );
      if (
        value.version !== "chisei.governed-subject-result/v1" ||
        value.receipt_schema !== "chisei.governed-subject-receipt/v1"
      ) {
        throw new RepositoryError(
          "Chisei returned an incompatible governed-subject contract.",
          502,
        );
      }
      const decision = boundedString(value.decision, "The Chisei decision", 32);
      if (!["allow", "deny", "unavailable", "unknown"].includes(decision)) {
        throw new RepositoryError("Chisei returned an incompatible decision.", 502);
      }
      const operationId = boundedString(value.operation_id, "The Chisei operation identity");
      const receiptSchema = boundedString(value.receipt_schema, "The Chisei receipt schema", 128);
      const receiptDigest = boundedString(value.receipt_digest, "The Chisei receipt digest", 71);
      if (!SHA256.test(receiptDigest))
        throw new RepositoryError("Chisei returned an invalid receipt digest.", 502);
      if (!Array.isArray(value.references) || value.references.length > 16) {
        throw new RepositoryError("Chisei returned incompatible governed references.", 502);
      }
      const references = value.references.map((item) => {
        if (!isRecord(item))
          throw new RepositoryError("Chisei returned an incompatible governed reference.", 502);
        exactKeys(
          item,
          ["kind", "reference", "content_digest", "observed_at_ms"],
          "A Chisei reference",
        );
        const observed = Number(item.observed_at_ms);
        if (!Number.isSafeInteger(observed) || observed <= 0) {
          throw new RepositoryError("Chisei returned an invalid evidence observation.", 502);
        }
        return {
          kind: boundedString(item.kind, "A Chisei reference kind", 64),
          reference: boundedString(item.reference, "A Chisei reference", 512),
          contentDigest: boundedString(item.content_digest, "A Chisei content digest", 512),
          observedAt: new Date(observed).toISOString(),
        };
      });
      const expected = new Map([
        [
          "source_tree",
          {
            reference: session.candidate.chisei.source_tree_digest,
            digest: session.candidate.chisei.source_tree_digest,
          },
        ],
        [
          "manifest",
          {
            reference: session.candidate.chisei.manifest_digest,
            digest: session.candidate.chisei.manifest_digest,
          },
        ],
        [
          "artifact",
          {
            reference: session.candidate.chisei.artifact_reference,
            digest: session.candidate.chisei.artifact_digest,
          },
        ],
        [
          "build_definition",
          {
            reference: session.candidate.chisei.build_definition_digest,
            digest: session.candidate.chisei.build_definition_digest,
          },
        ],
      ]);
      if (
        references.length !== expected.size ||
        references.some((item) => {
          const binding = expected.get(item.kind);
          return (
            !binding ||
            item.reference !== binding.reference ||
            item.contentDigest !== binding.digest
          );
        }) ||
        new Set(references.map((item) => item.kind)).size !== expected.size
      ) {
        throw new RepositoryError(
          "Chisei evaluation evidence does not match the release candidate.",
          502,
        );
      }
      const fresh = value.fresh === true;
      const observedAt = new Date().toISOString();
      const next: ReleaseDeliverySession = {
        ...session,
        state:
          decision === "allow" && fresh
            ? "governance_allowed"
            : decision === "deny"
              ? "governance_denied"
              : decision === "unavailable"
                ? "governance_unavailable"
                : "governance_unknown",
        completeness: fresh ? "partial" : "stale",
        evaluation: {
          decision: decision as NonNullable<ReleaseDeliverySession["evaluation"]>["decision"],
          operationId,
          receiptSchema,
          receiptDigest,
          references,
          fresh,
          observedAt,
        },
        error:
          decision === "allow" && fresh
            ? null
            : safeDiagnostic(String(value.failure_message ?? `Chisei decision: ${decision}`)),
        updatedAt: observedAt,
      };
      await this.store.put(next);
      return next;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #executePublish(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    const evaluation = session.evaluation!;
    const temporary = await this.#temporary(session);
    const candidatePath = join(temporary, "candidate.json");
    const provenancePath = join(temporary, "governed-subject.json");
    const rootsPath = join(temporary, "provenance-trust.toml");
    await writeFile(candidatePath, JSON.stringify(session.candidate.chisei), { mode: 0o600 });
    const sekaictl = this.env.ALDUNIS_SEKAICTL_PATH?.trim() || "sekaictl";
    try {
      return await this.#withCandidateSnapshot(
        session.worktree,
        session.candidate.document.commit.oid,
        "publish",
        async (snapshot) => {
          const exportId = `aldunis-tenkai-${session.id}`;
          for (const args of [
            [
              "admin",
              "governance",
              "subject",
              "provenance",
              "export",
              candidatePath,
              "--operation-id",
              evaluation.operationId,
              "--receipt-digest",
              evaluation.receiptDigest,
              "--export-id",
              exportId,
              "--output",
              provenancePath,
              "--target",
              this.env.ALDUNIS_CHISEI_ENDPOINT!,
            ],
            [
              "admin",
              "governance",
              "subject",
              "provenance",
              "trust-root",
              "--export-id",
              exportId,
              "--output",
              rootsPath,
              "--target",
              this.env.ALDUNIS_CHISEI_ENDPOINT!,
            ],
          ]) {
            const result = await this.#run("chisei", sekaictl, args, snapshot, 60_000, signal);
            if (result.exitCode !== 0) {
              return this.#unknown(
                session,
                "publication_unknown",
                "Chisei provenance export is unavailable.",
              );
            }
          }
          const result = await this.#tenkaiMachine(
            session,
            "publish",
            [
              "publish",
              resolve(snapshot, session.candidate.manifestPath),
              "--allow-unsigned-development",
              "--provenance",
              provenancePath,
              "--provenance-trust-roots",
              rootsPath,
            ],
            90_000,
            signal,
            snapshot,
          );
          const releaseId = result.resources.find((item) => item.kind === "release")?.id ?? null;
          const rawProvenanceDigest =
            result.resources.find((item) => item.kind === "release_provenance")?.id ?? null;
          const provenanceDigest =
            rawProvenanceDigest && SHA256.test(rawProvenanceDigest) ? rawProvenanceDigest : null;
          if (result.outcome !== "succeeded") {
            return this.#unknown(
              session,
              "publication_unknown",
              result.error?.message ?? "Tenkai publication is unknown.",
              { releaseId, provenanceDigest },
            );
          }
          if (!releaseId || !provenanceDigest) {
            return this.#unknown(
              session,
              "publication_unknown",
              "Tenkai publication omitted required resource references.",
              { releaseId, provenanceDigest },
            );
          }
          let release: ReleaseInspection;
          try {
            release = await this.#inspectRelease(session);
            this.#assertRelease(session, release, releaseId, provenanceDigest);
          } catch {
            return this.#unknown(
              session,
              "publication_unknown",
              "Tenkai publication requires authoritative reconciliation.",
              { releaseId, provenanceDigest },
            );
          }
          const provenance = this.#matchingProvenance(session, release, provenanceDigest);
          const observedAt = new Date().toISOString();
          const next: ReleaseDeliverySession = {
            ...session,
            state: "published",
            completeness: "partial",
            tenkai: {
              ...session.tenkai,
              releaseId,
              provenanceDigest,
              provenanceExpiresAt: provenance?.expires_at ?? null,
              observedAt,
            },
            error: null,
            updatedAt: observedAt,
          };
          await this.store.put(next);
          return next;
        },
        signal,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #executePromote(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    this.#requireFreshProvenance(session);
    const result = await this.#tenkaiMachine(
      session,
      "promote",
      ["promote", session.candidate.release, "stable"],
      60_000,
      signal,
    );
    const channelId = result.resources.find((item) => item.kind === "channel")?.id ?? null;
    if (result.outcome !== "succeeded") {
      return this.#unknown(
        session,
        "unknown",
        result.error?.message ?? "Tenkai promotion is unknown.",
        { channelId },
      );
    }
    if (!channelId) {
      return this.#unknown(session, "unknown", "Tenkai promotion omitted its channel reference.");
    }
    let environment: EnvironmentInspection;
    let subscription: EnvironmentInspection["subscriptions"][number];
    try {
      environment = await this.#inspectEnvironment(session.worktree, signal);
      subscription = this.#subscription(session, environment);
    } catch {
      return this.#unknown(
        session,
        "unknown",
        "Tenkai promotion requires authoritative reconciliation.",
        { channelId },
      );
    }
    if (subscription.head !== session.candidate.version) {
      return this.#unknown(
        session,
        "unknown",
        "Tenkai has not reconciled the promoted channel head.",
        { channelId, environmentId: environment.id },
      );
    }
    const observedAt = new Date().toISOString();
    const next = {
      ...session,
      state: "promoted" as const,
      tenkai: { ...session.tenkai, channelId, environmentId: environment.id, observedAt },
      error: null,
      updatedAt: observedAt,
    };
    await this.store.put(next);
    return next;
  }

  async #executePlan(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    this.#requireFreshProvenance(session);
    const result = await this.#tenkaiMachine(
      session,
      "plan",
      ["plan", "--env", "local"],
      60_000,
      signal,
    );
    const planId = result.resources.find((item) => item.kind === "plan")?.id ?? null;
    if (result.outcome !== "succeeded") {
      return this.#unknown(
        session,
        "unknown",
        result.error?.message ?? "Tenkai planning is unknown.",
        { planId },
      );
    }
    if (!planId) {
      return this.#unknown(session, "unknown", "Tenkai planning omitted its plan reference.");
    }
    let environment: EnvironmentInspection;
    try {
      environment = await this.#inspectEnvironment(session.worktree, signal);
    } catch {
      return this.#unknown(
        session,
        "unknown",
        "Tenkai planning requires authoritative reconciliation.",
        { planId },
      );
    }
    if (!this.#isCandidateOnlyPlan(session, environment.latest_plan, planId)) {
      return this.#unknown(
        session,
        "unknown",
        "The authoritative Tenkai plan is not a complete single-release plan for this candidate.",
        { planId, environmentId: environment.id },
      );
    }
    const observedAt = new Date().toISOString();
    const next = {
      ...session,
      state: "planned" as const,
      tenkai: {
        ...session.tenkai,
        planId,
        environmentId: environment.id,
        planState: environment.latest_plan.state,
        observedAt,
      },
      error: null,
      updatedAt: observedAt,
    };
    await this.store.put(next);
    return next;
  }

  async #executeApply(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    this.#requireFreshProvenance(session);
    const beforeApply = await this.#inspectEnvironment(session.worktree, signal);
    if (!this.#isCandidateOnlyPlan(session, beforeApply.latest_plan, session.tenkai.planId)) {
      throw new RepositoryError(
        "The Tenkai plan changed or includes changes outside this candidate.",
        409,
      );
    }
    const applying = {
      ...session,
      state: "applying" as const,
      updatedAt: new Date().toISOString(),
      error: null,
    };
    await this.store.put(applying);
    const result = await this.#tenkaiMachine(
      applying,
      "apply",
      [
        "apply",
        session.tenkai.planId!,
        "--allow-unapproved-development",
        "--development-reason",
        `Aldunis Code local delivery ${session.id}`,
      ],
      10 * 60_000,
      signal,
    );
    try {
      const environment = await this.#inspectEnvironment(session.worktree, signal);
      return this.#reconciledState(applying, environment, result);
    } catch {
      return this.#unknown(
        applying,
        "unknown",
        "Tenkai apply requires authoritative reconciliation.",
      );
    }
  }

  async #executeReconcile(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    if (session.state === "publication_unknown") {
      const release = await this.#inspectRelease(session, signal);
      const provenance = this.#matchingProvenance(session, release, null, false);
      if (!provenance) {
        throw new RepositoryError(
          "The authoritative Tenkai release lacks matching Chisei provenance.",
          502,
        );
      }
      this.#assertRelease(session, release, release.release_id, provenance.envelope_digest, false);
      const observedAt = new Date().toISOString();
      const fresh = Date.parse(provenance.expires_at) > Date.now();
      const published: ReleaseDeliverySession = {
        ...session,
        state: "published",
        completeness: fresh ? "partial" : "stale",
        tenkai: {
          ...session.tenkai,
          releaseId: release.release_id,
          provenanceDigest: provenance.envelope_digest,
          provenanceExpiresAt: provenance.expires_at,
          observedAt,
        },
        error: null,
        updatedAt: observedAt,
      };
      await this.store.put(published);
      return published;
    }
    if (session.tenkai.releaseId) {
      const release = await this.#inspectRelease(session, signal);
      this.#assertRelease(
        session,
        release,
        session.tenkai.releaseId,
        session.tenkai.provenanceDigest,
        false,
      );
    }
    const environment = await this.#inspectEnvironment(session.worktree, signal);
    const reconciled = await this.#reconciledState(session, environment);
    if (reconciled.state !== "unknown") return reconciled;
    if (
      session.tenkai.planId &&
      this.#isCandidateOnlyPlan(session, environment.latest_plan, session.tenkai.planId) &&
      environment.latest_plan?.state !== "failed"
    ) {
      const observedAt = new Date().toISOString();
      const planned: ReleaseDeliverySession = {
        ...reconciled,
        state: "planned",
        completeness: this.#provenanceFresh(session) ? "partial" : "stale",
        tenkai: {
          ...reconciled.tenkai,
          planState: environment.latest_plan.state,
          observedAt,
        },
        error: null,
        updatedAt: observedAt,
      };
      await this.store.put(planned);
      return planned;
    }
    const subscription = this.#subscription(session, environment);
    if (session.tenkai.channelId && subscription.head === session.candidate.version) {
      const observedAt = new Date().toISOString();
      const promoted: ReleaseDeliverySession = {
        ...reconciled,
        state: "promoted",
        completeness: this.#provenanceFresh(session) ? "partial" : "stale",
        tenkai: { ...reconciled.tenkai, observedAt },
        error: null,
        updatedAt: observedAt,
      };
      await this.store.put(promoted);
      return promoted;
    }
    return reconciled;
  }

  async #executeRollback(
    session: ReleaseDeliverySession,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ReleaseDeliverySession> {
    const result = await this.#tenkaiMachine(
      session,
      "rollback",
      [
        "rollback",
        session.candidate.product,
        "--env",
        "local",
        "--allow-unapproved-development",
        "--development-reason",
        reason,
      ],
      10 * 60_000,
      signal,
    );
    const rollbackPlanId = result.resources.find((item) => item.kind === "plan")?.id ?? null;
    let environment: EnvironmentInspection;
    try {
      environment = await this.#inspectEnvironment(session.worktree, signal);
    } catch {
      return this.#unknown(
        session,
        "unknown",
        "Tenkai rollback requires authoritative reconciliation.",
        { rollbackPlanId },
      );
    }
    const subscription = this.#subscription(session, environment);
    const observedAt = new Date().toISOString();
    const rollbackStep = environment.latest_plan?.steps[0];
    const succeeded =
      result.outcome === "succeeded" &&
      rollbackPlanId !== null &&
      environment.latest_plan?.id === rollbackPlanId &&
      environment.latest_plan.state === "succeeded" &&
      environment.latest_plan.steps_truncated === false &&
      environment.latest_plan.step_count === 1 &&
      environment.latest_plan.steps.length === 1 &&
      rollbackStep?.product === session.candidate.product &&
      rollbackStep?.to === subscription.deployed &&
      rollbackStep.release_id.length > 0 &&
      subscription.head === session.candidate.version &&
      subscription.deployed !== null &&
      subscription.deployed !== session.candidate.version &&
      subscription.state === "behind" &&
      subscription.health === "healthy" &&
      subscription.error === null;
    const next: ReleaseDeliverySession = {
      ...session,
      state: succeeded ? "recovered" : result.outcome === "unknown" ? "unknown" : "failed",
      completeness: succeeded ? (this.#provenanceFresh(session) ? "complete" : "stale") : "unknown",
      tenkai: {
        ...session.tenkai,
        rollbackPlanId,
        environmentId: environment.id,
        planState: environment.latest_plan?.state ?? null,
        deployedVersion: subscription.deployed,
        health: subscription.health,
        observedAt,
      },
      error: succeeded
        ? null
        : (result.error?.message ?? "Tenkai rollback did not reach a reconciled terminal state."),
      updatedAt: observedAt,
    };
    await this.store.put(next);
    return next;
  }

  async #unknown(
    session: ReleaseDeliverySession,
    state: ReleaseWorkflowState,
    message: string,
    tenkai?: Partial<ReleaseDeliverySession["tenkai"]>,
  ): Promise<ReleaseDeliverySession> {
    const updatedAt = new Date().toISOString();
    const next = {
      ...session,
      state,
      completeness: "unknown" as const,
      ...(tenkai
        ? {
            tenkai: {
              ...session.tenkai,
              ...tenkai,
              observedAt: tenkai.observedAt ?? updatedAt,
            },
          }
        : {}),
      error: safeDiagnostic(message),
      updatedAt,
    };
    await this.store.put(next);
    return next;
  }

  #subscription(session: ReleaseDeliverySession, environment: EnvironmentInspection) {
    const subscription = environment.subscriptions.find(
      (item) => item.product === session.candidate.product && item.channel === "stable",
    );
    if (!subscription) {
      throw new RepositoryError("The authoritative Tenkai local subscription is unavailable.", 409);
    }
    return subscription;
  }

  #isCandidateOnlyPlan(
    session: ReleaseDeliverySession,
    plan: EnvironmentInspection["latest_plan"],
    planId: string | null,
  ): boolean {
    const step = plan?.steps[0];
    return Boolean(
      planId &&
      session.tenkai.releaseId &&
      plan?.id === planId &&
      plan.steps_truncated === false &&
      plan.step_count === 1 &&
      plan.steps.length === 1 &&
      step?.product === session.candidate.product &&
      step.to === session.candidate.version &&
      step.release_id === session.tenkai.releaseId,
    );
  }

  async #reconciledState(
    session: ReleaseDeliverySession,
    environment: EnvironmentInspection,
    result?: MachineResult,
  ): Promise<ReleaseDeliverySession> {
    const subscription = this.#subscription(session, environment);
    const planMatches = Boolean(
      session.tenkai.releaseId &&
      session.tenkai.provenanceDigest &&
      session.tenkai.channelId &&
      session.tenkai.planId &&
      this.#isCandidateOnlyPlan(session, environment.latest_plan, session.tenkai.planId),
    );
    const current =
      subscription.head === session.candidate.version &&
      subscription.deployed === session.candidate.version &&
      subscription.state === "current" &&
      subscription.health === "healthy" &&
      subscription.error === null &&
      planMatches &&
      environment.latest_plan?.state === "succeeded";
    const rollbackStep = environment.latest_plan?.steps[0];
    const recovered = Boolean(
      session.tenkai.rollbackPlanId &&
      environment.latest_plan?.id === session.tenkai.rollbackPlanId &&
      environment.latest_plan.state === "succeeded" &&
      environment.latest_plan.steps_truncated === false &&
      environment.latest_plan.step_count === 1 &&
      environment.latest_plan.steps.length === 1 &&
      rollbackStep?.product === session.candidate.product &&
      rollbackStep.to === subscription.deployed &&
      rollbackStep.release_id.length > 0 &&
      subscription.head === session.candidate.version &&
      subscription.deployed !== null &&
      subscription.deployed !== session.candidate.version &&
      subscription.state === "behind" &&
      subscription.health === "healthy" &&
      subscription.error === null,
    );
    const failed =
      environment.latest_plan?.state === "failed" ||
      subscription.error !== null ||
      (result && result.outcome === "failed");
    const state: ReleaseWorkflowState = recovered
      ? "recovered"
      : current
        ? "completed"
        : failed
          ? "failed"
          : "unknown";
    const observedAt = new Date().toISOString();
    const next: ReleaseDeliverySession = {
      ...session,
      state,
      completeness:
        current || recovered
          ? this.#provenanceFresh(session)
            ? "complete"
            : "stale"
          : failed
            ? "partial"
            : "unknown",
      tenkai: {
        ...session.tenkai,
        environmentId: environment.id,
        planState: environment.latest_plan?.state ?? null,
        deployedVersion: subscription.deployed,
        health: subscription.health,
        observedAt,
      },
      error:
        current || recovered
          ? null
          : safeDiagnostic(
              subscription.error ??
                result?.error?.message ??
                "Tenkai state is not terminal and current.",
            ),
      updatedAt: observedAt,
    };
    await this.store.put(next);
    return next;
  }

  async #tenkaiMachine(
    session: ReleaseDeliverySession,
    command: string,
    args: string[],
    timeout: number,
    signal?: AbortSignal,
    cwd = session.worktree,
  ): Promise<MachineResult> {
    const result = await this.#run(
      "tenkai",
      this.env.ALDUNIS_TENKAICTL_PATH?.trim() || "tenkaictl",
      [
        "--target",
        "embedded",
        "--database",
        this.env.ALDUNIS_TENKAI_DATABASE!,
        "--output",
        "json-v1",
        ...args,
      ],
      cwd,
      timeout,
      signal,
    );
    if (result.timedOut || !result.stdout.trim()) {
      return {
        schema: "tenkai.command-result/v1",
        command,
        outcome: "unknown",
        retry: "reconcile_before_retry",
        resources: [],
        error: { code: "transport_unknown", message: "Tenkai did not return a complete result." },
      };
    }
    let parsed: MachineResult;
    try {
      parsed = parseMachineResult(result.stdout, command);
    } catch {
      return {
        schema: "tenkai.command-result/v1",
        command,
        outcome: "unknown",
        retry: "reconcile_before_retry",
        resources: [],
        error: {
          code: "result_incompatible",
          message: "Tenkai returned an incompatible result after the mutation was invoked.",
        },
      };
    }
    if (result.exitCode !== 0 && parsed.outcome === "succeeded") {
      return {
        ...parsed,
        outcome: "unknown",
        retry: "reconcile_before_retry",
        error: {
          code: "process_failed",
          message: "Tenkai returned success from an unsuccessful process.",
        },
      };
    }
    return parsed;
  }

  async #inspectEnvironment(
    worktree: string,
    signal?: AbortSignal,
  ): Promise<EnvironmentInspection> {
    this.#requireTenkai();
    const result = await this.#run(
      "tenkai",
      this.env.ALDUNIS_TENKAICTL_PATH?.trim() || "tenkaictl",
      [
        "--target",
        "embedded",
        "--database",
        this.env.ALDUNIS_TENKAI_DATABASE!,
        "env",
        "inspect",
        "local",
      ],
      worktree,
      30_000,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new RepositoryError("The authoritative Tenkai local environment is unavailable.", 502);
    }
    return parseEnvironmentInspection(result.stdout);
  }

  async #inspectRelease(
    session: ReleaseDeliverySession,
    signal?: AbortSignal,
  ): Promise<ReleaseInspection> {
    const result = await this.#run(
      "tenkai",
      this.env.ALDUNIS_TENKAICTL_PATH?.trim() || "tenkaictl",
      [
        "--target",
        "embedded",
        "--database",
        this.env.ALDUNIS_TENKAI_DATABASE!,
        "release",
        "inspect",
        session.candidate.release,
      ],
      session.worktree,
      30_000,
      signal,
    );
    if (result.exitCode !== 0) throw new RepositoryError("The Tenkai release is unavailable.", 502);
    return parseReleaseInspection(result.stdout);
  }

  #assertRelease(
    session: ReleaseDeliverySession,
    release: ReleaseInspection,
    releaseId: string,
    provenanceDigest: string | null,
    requireFresh = true,
  ): void {
    if (
      release.release_id !== releaseId ||
      release.product !== session.candidate.product ||
      release.version !== session.candidate.version ||
      release.status !== "unsigned-development" ||
      release.manifest_digest !== session.candidate.chisei.manifest_digest.slice(7) ||
      release.artifact_digest !== session.candidate.chisei.artifact_digest.slice(7) ||
      !this.#matchingProvenance(session, release, provenanceDigest, requireFresh)
    ) {
      throw new RepositoryError(
        "The authoritative Tenkai release does not match the candidate.",
        502,
      );
    }
  }

  #matchingProvenance(
    session: ReleaseDeliverySession,
    release: ReleaseInspection,
    envelopeDigest?: string | null,
    requireFresh = true,
  ): ReleaseInspection["governance_provenance"][number] | undefined {
    return release.governance_provenance.find(
      (item) =>
        (!envelopeDigest || item.envelope_digest === envelopeDigest) &&
        item.profile === "example.governed-subject-receipt/v1" &&
        item.issuer === "sekai-chisei" &&
        item.subject === session.candidate.identity &&
        item.decision === "allow" &&
        item.receipt_schema === "chisei.governed-subject-receipt/v1" &&
        item.receipt_digest === session.evaluation?.receiptDigest &&
        Date.parse(item.observed_at) <= Date.now() &&
        (!requireFresh || Date.parse(item.expires_at) > Date.now()),
    );
  }

  #requireFreshProvenance(session: ReleaseDeliverySession): void {
    if (!this.#provenanceFresh(session)) {
      throw new RepositoryError(
        "Fresh Chisei provenance is required before advancing this release.",
        409,
      );
    }
  }

  #provenanceFresh(session: ReleaseDeliverySession): boolean {
    return (
      typeof session.tenkai.provenanceExpiresAt === "string" &&
      Date.parse(session.tenkai.provenanceExpiresAt) > Date.now()
    );
  }
}
