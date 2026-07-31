import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ReleaseDeliveryBroker,
  ReleaseDeliveryStore,
  type ReleaseCommandRunner,
  type ReleaseWorkflowAction,
} from "./release-delivery-workflow.ts";

const execFileAsync = promisify(execFile);

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "aldunis-release-workflow-repo-"));
  const state = await mkdtemp(join(tmpdir(), "aldunis-release-workflow-state-"));
  await execFileAsync("git", ["-C", root, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Aldunis Test"]);
  await execFileAsync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/acme/widget.git"]);
  await mkdir(join(root, "artifact"));
  await writeFile(join(root, "artifact", "payload.txt"), "payload\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "widget",
    scripts: { build: "node build.mjs", test: "node --test" },
  }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({
    name: "widget",
    lockfileVersion: 3,
    packages: {},
  }));
  await writeFile(join(root, "tenkai.toml"), [
    "[product]",
    'name = "widget"',
    'version = "1.2.3"',
    "[deploy]",
    'install = "true"',
    'health = "true"',
    'inputs = ["artifact"]',
  ].join("\n"));
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return { root, state };
}

function machine(command: string, resources: Array<{ kind: string; id: string }>) {
  return JSON.stringify({
    schema: "tenkai.command-result/v1",
    command,
    outcome: "succeeded",
    retry: "not_needed",
    resources,
  });
}

function fakeRunner() {
  let head = "1.2.2";
  let deployed: string | null = "1.2.2";
  let health: string | null = "healthy";
  let latestPlan: Record<string, unknown> | null = null;
  let publishTimeout = false;
  let applyUnknown = false;
  let rollbackHealthy = true;
  let decision: "allow" | "deny" | "unavailable" | "unknown" = "allow";
  let resultVersion = "chisei.governed-subject-result/v1";
  let receiptSchema = "chisei.governed-subject-receipt/v1";
  let includeUnrelatedPlanStep = false;
  let includeUnrelatedRollbackStep = false;
  let applyCalls = 0;
  let artifactReferenceOverride: string | null = null;
  const runner: ReleaseCommandRunner = async (executable, args) => {
    if (executable === "npm") {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false };
    }
    if (executable === "sekaictl") {
      const output = args[args.indexOf("--output") + 1];
      if (args.includes("provenance") && args.includes("export")) {
        await writeFile(output, JSON.stringify({ profile: "fixture" }));
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false };
      }
      if (args.includes("provenance") && args.includes("trust-root")) {
        await writeFile(output, "version = 1\n");
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false };
      }
      const candidate = JSON.parse(await readFile(args[4], "utf8")) as Record<string, string>;
      return {
        stdout: JSON.stringify({
          version: resultVersion,
          decision,
          operation_id: "governed-subject-operation-1",
          receipt_schema: receiptSchema,
          receipt_digest: `sha256:${"9".repeat(64)}`,
          references: [
            ["source_tree", candidate.source_tree_digest, candidate.source_tree_digest],
            ["manifest", candidate.manifest_digest, candidate.manifest_digest],
            ["artifact", artifactReferenceOverride ?? candidate.artifact_reference, candidate.artifact_digest],
            ["build_definition", candidate.build_definition_digest, candidate.build_definition_digest],
          ].map(([kind, reference, content_digest]) => ({
            kind,
            reference,
            content_digest,
            observed_at_ms: Date.now(),
          })),
          fresh: true,
          failure_code: decision === "allow" ? "" : decision,
          failure_message: decision === "allow" ? "" : `fixture ${decision}`,
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    const commandIndex = args.findIndex((value) => [
      "publish", "promote", "plan", "apply", "rollback", "release", "env",
    ].includes(value));
    const command = args[commandIndex];
    if (command === "release") {
      return {
        stdout: JSON.stringify({
          release_id: "tenkai:release:widget:1.2.3",
          product: "widget",
          version: "1.2.3",
          status: "unsigned-development",
          algorithm: "none",
          manifest_digest: (JSON.parse(await readFile(join(args.includes("publish") ? "" : "", "unused"), "utf8")).x),
          artifact_digest: "",
          governance_provenance: [],
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "env") {
      return {
        stdout: JSON.stringify({
          name: "local",
          id: "tenkai:environment:local",
          description: "fixture",
          subscriptions: [{
            product: "widget",
            channel: "stable",
            head,
            deployed,
            health,
            error: health === "unknown" ? "health failed" : null,
            state: deployed === head && health !== "unknown" ? "current" : health === "unknown" ? "unknown" : "behind",
          }],
          facts: {},
          lease: {},
          latest_plan: latestPlan,
          execution_note: "fixture",
        }),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "publish" && publishTimeout) {
      return { stdout: "", stderr: "", exitCode: null, timedOut: true, aborted: false };
    }
    if (command === "publish") {
      return {
        stdout: machine("publish", [
          { kind: "release", id: "tenkai:release:widget:1.2.3" },
          { kind: "release_provenance", id: `sha256:${"8".repeat(64)}` },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "promote") {
      head = "1.2.3";
      return {
        stdout: machine("promote", [{ kind: "channel", id: "widget/stable" }]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "plan") {
      const steps = [{
        id: "step-1",
        order: 0,
        product: "widget",
        action: "install",
        from: "1.2.2",
        to: "1.2.3",
        release_id: "tenkai:release:widget:1.2.3",
      }];
      if (includeUnrelatedPlanStep) {
        steps.push({
          id: "step-2",
          order: 1,
          product: "unrelated",
          action: "install",
          from: "4.0.0",
          to: "5.0.0",
          release_id: "tenkai:release:unrelated:5.0.0",
        });
      }
      latestPlan = {
        id: "tenkai:plan:local:1:opaque",
        state: "computed",
        created_at: Date.now(),
        step_count: steps.length,
        status_detail: "",
        steps,
        steps_truncated: false,
      };
      return {
        stdout: machine("plan", [
          { kind: "plan", id: "tenkai:plan:local:1:opaque" },
          { kind: "environment", id: "tenkai:environment:local" },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "apply" && applyUnknown) {
      applyCalls += 1;
      health = "unknown";
      return {
        stdout: JSON.stringify({
          schema: "tenkai.command-result/v1",
          command: "apply",
          outcome: "unknown",
          retry: "reconcile_before_retry",
          resources: [{ kind: "plan", id: "tenkai:plan:local:1:opaque" }],
        }),
        stderr: "",
        exitCode: 1,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "apply") {
      applyCalls += 1;
      deployed = "1.2.3";
      health = "healthy";
      latestPlan = { ...latestPlan, state: "succeeded" };
      return {
        stdout: machine("apply", [
          { kind: "plan", id: "tenkai:plan:local:1:opaque" },
          { kind: "environment", id: "tenkai:environment:local" },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    if (command === "rollback") {
      deployed = "1.2.2";
      health = rollbackHealthy ? "healthy" : "unknown";
      const steps = [{
        id: "step-rollback",
        order: 0,
        product: "widget",
        action: "rollback",
        from: "1.2.3",
        to: "1.2.2",
        release_id: "tenkai:release:widget:1.2.2",
      }];
      if (includeUnrelatedRollbackStep) {
        steps.push({
          id: "step-unrelated-rollback",
          order: 1,
          product: "unrelated",
          action: "rollback",
          from: "5.0.0",
          to: "4.0.0",
          release_id: "tenkai:release:unrelated:4.0.0",
        });
      }
      latestPlan = {
        ...latestPlan,
        id: "tenkai:plan:local:2:rollback",
        state: "succeeded",
        step_count: steps.length,
        steps,
        steps_truncated: false,
      };
      return {
        stdout: machine("rollback", [
          { kind: "plan", id: "tenkai:plan:local:2:rollback" },
          { kind: "environment", id: "tenkai:environment:local" },
        ]),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        aborted: false,
      };
    }
    throw new Error(`unexpected fixture command: ${executable} ${args.join(" ")}`);
  };
  return {
    runner,
    setDecision(value: typeof decision) { decision = value; },
    setPublishTimeout(value: boolean) { publishTimeout = value; },
    setApplyUnknown(value: boolean) { applyUnknown = value; },
    setRollbackHealthy(value: boolean) { rollbackHealthy = value; },
    setResultContract(version: string, schema: string) {
      resultVersion = version;
      receiptSchema = schema;
    },
    setIncludeUnrelatedPlanStep(value: boolean) {
      includeUnrelatedPlanStep = value;
    },
    setIncludeUnrelatedRollbackStep(value: boolean) {
      includeUnrelatedRollbackStep = value;
    },
    setArtifactReferenceOverride(value: string | null) {
      artifactReferenceOverride = value;
    },
    addUnrelatedStepToLatestPlan() {
      if (!latestPlan || !Array.isArray(latestPlan.steps)) throw new Error("fixture plan is unavailable");
      latestPlan.steps.push({
        id: "step-late",
        order: latestPlan.steps.length,
        product: "unrelated",
        action: "install",
        from: "4.0.0",
        to: "5.0.0",
        release_id: "tenkai:release:unrelated:5.0.0",
      });
      latestPlan.step_count = latestPlan.steps.length;
    },
    getApplyCalls() {
      return applyCalls;
    },
    releaseInspection(manifest: string, artifact: string, subject: string) {
      const original = runner;
      const wrapped: ReleaseCommandRunner = async (executable, args, options) => {
        if (executable === "tenkaictl" && args.includes("release") && args.includes("inspect")) {
          return {
            stdout: JSON.stringify({
              release_id: "tenkai:release:widget:1.2.3",
              product: "widget",
              version: "1.2.3",
              status: "unsigned-development",
              algorithm: "none",
              manifest_digest: manifest,
              artifact_digest: artifact,
              governance_provenance: [{
                profile: "example.governed-subject-receipt/v1",
                issuer: "sekai-chisei",
                issuer_key_id: "fixture-key",
                subject,
                envelope_digest: `sha256:${"8".repeat(64)}`,
                decision: "allow",
                receipt_schema: "chisei.governed-subject-receipt/v1",
                receipt_digest: `sha256:${"9".repeat(64)}`,
                governed_references: [],
                observed_at_unix_ms: Date.now(),
                expires_at_unix_ms: Date.now() + 60_000,
              }],
            }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
            aborted: false,
          };
        }
        return original(executable, args, options);
      };
      return wrapped;
    },
  };
}

const env = {
  ALDUNIS_CHISEI_ENDPOINT: "http://127.0.0.1:50051",
  ALDUNIS_CHISEI_TOKEN: "fixture-token",
  ALDUNIS_TENKAI_DATABASE: "/fixture/tenkai.db",
};

async function previewExecute(
  broker: ReleaseDeliveryBroker,
  root: string,
  action: ReleaseWorkflowAction,
  input: Record<string, unknown>,
) {
  const preview = await broker.plan("project-1", root, root, "team/widget", action, input);
  return broker.execute(preview.id, "project-1", root, root, "team/widget");
}

test("the staged workflow resumes after restart and exports a complete correlation receipt", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  assert.equal(prepared.state, "candidate_ready");

  broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const inspected = await broker.inspect("project-1", root, root);
  assert.equal(inspected.sessions[0]?.id, prepared.id);
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  assert.equal(evaluated.state, "governance_allowed");

  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    fake.releaseInspection(
      evaluated.candidate.chisei.manifest_digest.slice(7),
      evaluated.candidate.chisei.artifact_digest.slice(7),
      evaluated.candidate.identity,
    ),
  );
  const published = await previewExecute(broker, root, "publish", { sessionId: prepared.id });
  const promoted = await previewExecute(broker, root, "promote", { sessionId: prepared.id });
  const planned = await previewExecute(broker, root, "plan", { sessionId: prepared.id });
  const completed = await previewExecute(broker, root, "apply", { sessionId: prepared.id });
  assert.equal(published.state, "published");
  assert.equal(promoted.state, "promoted");
  assert.equal(planned.state, "planned");
  assert.equal(completed.state, "completed");
  assert.equal(completed.completeness, "complete");

  const receipt = await broker.receipt(prepared.id, "project-1", root, root);
  assert.equal(receipt.schema, "aldunis.delivery-receipt/v1");
  assert.equal(receipt.completeness, "complete");
  const serialized = JSON.stringify(receipt);
  for (const forbidden of ["fixture-token", "/fixture/tenkai.db", "signature", "private_key", root]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const store = new ReleaseDeliveryStore(state);
  const persisted = (await store.load()).find((session) => session.id === prepared.id);
  assert.ok(persisted);
  await store.put({
    ...persisted,
    tenkai: {
      ...persisted.tenkai,
      provenanceExpiresAt: new Date(Date.now() - 1).toISOString(),
    },
  });
  const reconciledAfterExpiry = await previewExecute(broker, root, "reconcile", {
    sessionId: prepared.id,
  });
  assert.equal(reconciledAfterExpiry.state, "completed");
  assert.equal(reconciledAfterExpiry.completeness, "stale");
  const staleReceipt = await broker.receipt(prepared.id, "project-1", root, root);
  assert.equal(staleReceipt.completeness, "stale");
  assert.equal((staleReceipt.sekai as { fresh: boolean }).fresh, false);
});

test("publication reads the reviewed manifest from an immutable candidate snapshot", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  const releaseRunner = fake.releaseInspection(
    evaluated.candidate.chisei.manifest_digest.slice(7),
    evaluated.candidate.chisei.artifact_digest.slice(7),
    evaluated.candidate.identity,
  );
  let liveManifestChanged = false;
  const runner: ReleaseCommandRunner = async (executable, args, options) => {
    if (executable === "tenkaictl" && args.includes("publish")) {
      const manifestPath = args[args.indexOf("publish") + 1];
      assert.notEqual(manifestPath, join(root, "tenkai.toml"));
      assert.match(await readFile(manifestPath, "utf8"), /version = "1.2.3"/);
    }
    const result = await releaseRunner(executable, args, options);
    if (
      !liveManifestChanged
      && executable === "sekaictl"
      && args.includes("provenance")
      && args.includes("export")
    ) {
      liveManifestChanged = true;
      await writeFile(join(root, "tenkai.toml"), [
        "[product]",
        'name = "widget"',
        'version = "9.9.9"',
        "[deploy]",
        'inputs = ["artifact"]',
      ].join("\n"));
    }
    return result;
  };
  broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, runner);

  const published = await previewExecute(broker, root, "publish", { sessionId: prepared.id });

  assert.equal(liveManifestChanged, true);
  assert.equal(published.state, "published");
});

test("a multi-product Tenkai plan cannot advance or apply the selected candidate", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    fake.releaseInspection(
      evaluated.candidate.chisei.manifest_digest.slice(7),
      evaluated.candidate.chisei.artifact_digest.slice(7),
      evaluated.candidate.identity,
    ),
  );
  await previewExecute(broker, root, "publish", { sessionId: prepared.id });
  await previewExecute(broker, root, "promote", { sessionId: prepared.id });
  fake.setIncludeUnrelatedPlanStep(true);

  const planned = await previewExecute(broker, root, "plan", { sessionId: prepared.id });

  assert.equal(planned.state, "unknown");
  assert.match(planned.error ?? "", /not a complete single-release plan/);
  await assert.rejects(
    () => broker.plan("project-1", root, root, "team/widget", "apply", {
      sessionId: prepared.id,
    }),
    /unavailable from state unknown/,
  );
});

test("apply rechecks the exact plan after preview before invoking Tenkai", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    fake.releaseInspection(
      evaluated.candidate.chisei.manifest_digest.slice(7),
      evaluated.candidate.chisei.artifact_digest.slice(7),
      evaluated.candidate.identity,
    ),
  );
  await previewExecute(broker, root, "publish", { sessionId: prepared.id });
  await previewExecute(broker, root, "promote", { sessionId: prepared.id });
  await previewExecute(broker, root, "plan", { sessionId: prepared.id });
  const preview = await broker.plan("project-1", root, root, "team/widget", "apply", {
    sessionId: prepared.id,
  });
  fake.addUnrelatedStepToLatestPlan();

  await assert.rejects(
    () => broker.execute(preview.id, "project-1", root, root, "team/widget"),
    /changed or includes changes outside this candidate/,
  );
  assert.equal(fake.getApplyCalls(), 0);
});

test("known Chisei denial and Tenkai publish timeout stay fail-closed and resumable", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  fake.setDecision("deny");
  const denied = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  assert.equal(denied.state, "governance_denied");
  await assert.rejects(
    () => broker.plan("project-1", root, root, "team/widget", "publish", { sessionId: prepared.id }),
    /unavailable from state governance_denied/,
  );

  fake.setDecision("allow");
  const allowed = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  fake.setPublishTimeout(true);
  const unknown = await previewExecute(broker, root, "publish", { sessionId: prepared.id });
  assert.equal(allowed.state, "governance_allowed");
  assert.equal(unknown.state, "publication_unknown");
  assert.equal(unknown.completeness, "unknown");

  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    fake.releaseInspection(
      allowed.candidate.chisei.manifest_digest.slice(7),
      allowed.candidate.chisei.artifact_digest.slice(7),
      allowed.candidate.identity,
    ),
  );
  const reconciled = await previewExecute(broker, root, "reconcile", { sessionId: prepared.id });
  assert.equal(reconciled.state, "published");
  assert.equal(reconciled.completeness, "partial");
  assert.equal(reconciled.tenkai.planId, null);
  assert.equal(reconciled.tenkai.channelId, null);
});

test("a nonzero Tenkai process cannot advance with a succeeded payload", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  const releaseRunner = fake.releaseInspection(
    evaluated.candidate.chisei.manifest_digest.slice(7),
    evaluated.candidate.chisei.artifact_digest.slice(7),
    evaluated.candidate.identity,
  );
  await previewExecute(
    new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, releaseRunner),
    root,
    "publish",
    { sessionId: prepared.id },
  );
  const failedProcessRunner: ReleaseCommandRunner = async (executable, args, options) => {
    const result = await releaseRunner(executable, args, options);
    return executable === "tenkaictl" && args.includes("promote")
      ? { ...result, exitCode: 1 }
      : result;
  };
  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    failedProcessRunner,
  );

  const promoted = await previewExecute(broker, root, "promote", { sessionId: prepared.id });

  assert.equal(promoted.state, "unknown");
  assert.match(promoted.error ?? "", /unsuccessful process/);
});

test("a malformed mutation result becomes durable unknown before any retry", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  const releaseRunner = fake.releaseInspection(
    evaluated.candidate.chisei.manifest_digest.slice(7),
    evaluated.candidate.chisei.artifact_digest.slice(7),
    evaluated.candidate.identity,
  );
  const malformedRunner: ReleaseCommandRunner = async (executable, args, options) => (
    executable === "tenkaictl" && args.includes("publish")
      ? { stdout: "{", stderr: "", exitCode: 0, timedOut: false, aborted: false }
      : releaseRunner(executable, args, options)
  );
  broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, malformedRunner);

  const unknown = await previewExecute(broker, root, "publish", { sessionId: prepared.id });

  assert.equal(unknown.state, "publication_unknown");
  assert.match(unknown.error ?? "", /incompatible result/);
  await assert.rejects(
    () => broker.plan("project-1", root, root, "team/widget", "publish", {
      sessionId: prepared.id,
    }),
    /unavailable from state publication_unknown/,
  );
});

test("post-mutation inspection failures reconcile promotion and planning before retry", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  const releaseRunner = fake.releaseInspection(
    evaluated.candidate.chisei.manifest_digest.slice(7),
    evaluated.candidate.chisei.artifact_digest.slice(7),
    evaluated.candidate.identity,
  );
  let failEnvironmentInspection = false;
  const runner: ReleaseCommandRunner = async (executable, args, options) => {
    if (
      failEnvironmentInspection
      && executable === "tenkaictl"
      && args.includes("env")
      && args.includes("inspect")
    ) {
      failEnvironmentInspection = false;
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false, aborted: false };
    }
    const result = await releaseRunner(executable, args, options);
    if (
      executable === "tenkaictl"
      && (args.includes("promote") || args.includes("plan"))
    ) {
      failEnvironmentInspection = true;
    }
    return result;
  };
  broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, runner);
  await previewExecute(broker, root, "publish", { sessionId: prepared.id });

  const promotionUnknown = await previewExecute(broker, root, "promote", {
    sessionId: prepared.id,
  });
  assert.equal(promotionUnknown.state, "unknown");
  assert.ok(promotionUnknown.tenkai.channelId);
  const promoted = await previewExecute(broker, root, "reconcile", { sessionId: prepared.id });
  assert.equal(promoted.state, "promoted");

  const planningUnknown = await previewExecute(broker, root, "plan", {
    sessionId: prepared.id,
  });
  assert.equal(planningUnknown.state, "unknown");
  assert.ok(planningUnknown.tenkai.planId);
  const planned = await previewExecute(broker, root, "reconcile", { sessionId: prepared.id });
  assert.equal(planned.state, "planned");
});

test("incompatible Chisei result and receipt schemas fail closed", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  const broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });

  fake.setResultContract("chisei.governed-subject-result/v2", "chisei.governed-subject-receipt/v1");
  await assert.rejects(
    () => previewExecute(broker, root, "evaluate", { sessionId: prepared.id }),
    /incompatible governed-subject contract/,
  );

  fake.setResultContract("chisei.governed-subject-result/v1", "chisei.governed-subject-receipt/v2");
  await assert.rejects(
    () => previewExecute(broker, root, "evaluate", { sessionId: prepared.id }),
    /incompatible governed-subject contract/,
  );

  fake.setResultContract(
    "chisei.governed-subject-result/v1",
    "chisei.governed-subject-receipt/v1",
  );
  fake.setArtifactReferenceOverride(`tenkai:artifact-tree:sha256:${"0".repeat(64)}`);
  await assert.rejects(
    () => previewExecute(broker, root, "evaluate", { sessionId: prepared.id }),
    /evidence does not match the release candidate/,
  );
  fake.setArtifactReferenceOverride(null);
  const failedRunner: ReleaseCommandRunner = async (executable, args, options) => {
    const result = await fake.runner(executable, args, options);
    return executable === "sekaictl" && !args.includes("provenance")
      ? { ...result, exitCode: 1 }
      : result;
  };
  const failedBroker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    failedRunner,
  );
  const unavailable = await previewExecute(
    failedBroker,
    root,
    "evaluate",
    { sessionId: prepared.id },
  );
  assert.equal(unavailable.state, "governance_unavailable");
  assert.notEqual(unavailable.evaluation?.decision, "allow");
});

test("changed committed content stales prior evidence and previews are single-use", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  const broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const preview = await broker.plan(
    "project-1",
    root,
    root,
    "team/widget",
    "prepare",
    { manifestPath: "tenkai.toml" },
  );
  const prepared = await broker.execute(preview.id, "project-1", root, root, "team/widget");
  await assert.rejects(
    () => broker.execute(preview.id, "project-1", root, root, "team/widget"),
    /does not exist/,
  );
  await writeFile(join(root, "artifact", "payload.txt"), "changed\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-qm", "change candidate"]);
  await assert.rejects(
    () => broker.plan("project-1", root, root, "team/widget", "evaluate", { sessionId: prepared.id }),
    /Prepare and evaluate a new candidate/,
  );
  const inspected = await broker.inspect("project-1", root, root);
  assert.equal(inspected.sessions[0]?.state, "stale");
});

test("a changed package script cannot execute after preview", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let npmCalls = 0;
  const countingRunner: ReleaseCommandRunner = async (executable, args, options) => {
    if (executable === "npm") npmCalls += 1;
    return fake.runner(executable, args, options);
  };
  const broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    countingRunner,
  );
  const preview = await broker.plan(
    "project-1",
    root,
    root,
    "team/widget",
    "prepare",
    { manifestPath: "tenkai.toml" },
  );
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "widget",
    scripts: { build: "node changed.mjs", test: "node --test" },
  }));
  await assert.rejects(
    () => broker.execute(preview.id, "project-1", root, root, "team/widget"),
    /Commit or remove every tracked and untracked change/,
  );
  assert.equal(npmCalls, 0);
});

test("a changed Chisei namespace invalidates its evaluation preview", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let evaluationCalls = 0;
  const runner: ReleaseCommandRunner = async (executable, args, options) => {
    if (executable === "sekaictl" && !args.includes("provenance")) evaluationCalls += 1;
    return fake.runner(executable, args, options);
  };
  const broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const preview = await broker.plan(
    "project-1",
    root,
    root,
    "team/widget",
    "evaluate",
    { sessionId: prepared.id },
  );

  await assert.rejects(
    () => broker.execute(preview.id, "project-1", root, root, "team/other"),
    /Chisei namespace changed after preview/,
  );
  assert.equal(evaluationCalls, 0);
});

test("prepare installs the bound lockfile and restores scripts inside one detached checkout", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  const npmCalls: Array<{ args: string[]; cwd: string }> = [];
  const runner: ReleaseCommandRunner = async (executable, args, options) => {
    if (executable !== "npm") return fake.runner(executable, args, options);
    npmCalls.push({ args, cwd: options.cwd });
    if (args[0] !== "ci") {
      const manifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8")) as {
        scripts: { build: string; test: string };
      };
      assert.deepEqual(manifest.scripts, {
        build: "node build.mjs",
        test: "node --test",
      });
    }
    await writeFile(join(options.cwd, "package.json"), JSON.stringify({
      name: "widget",
      scripts: { build: "node changed.mjs", test: "node changed-test.mjs" },
    }));
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, aborted: false };
  };
  const broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, runner);

  const prepared = await previewExecute(
    broker,
    root,
    "prepare",
    { manifestPath: "tenkai.toml" },
  );

  assert.deepEqual(npmCalls.map(({ args }) => args), [
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    ["run", "build"],
    ["test"],
  ]);
  assert.equal(new Set(npmCalls.map(({ cwd }) => cwd)).size, 1);
  assert.deepEqual(prepared.buildEvidence.commands.map(({ id }) => id), [
    "install",
    "build",
    "test",
  ]);
});

test("concurrent previews cannot advance the same session twice", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  let evaluationCalls = 0;
  let releaseFirst!: () => void;
  let reportFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { reportFirstEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const blockingRunner: ReleaseCommandRunner = async (executable, args, options) => {
    if (executable === "sekaictl" && !args.includes("provenance")) {
      evaluationCalls += 1;
      if (evaluationCalls === 1) {
        reportFirstEntered();
        await firstGate;
      }
    }
    return fake.runner(executable, args, options);
  };
  broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, blockingRunner);
  const first = await broker.plan(
    "project-1",
    root,
    root,
    "team/widget",
    "evaluate",
    { sessionId: prepared.id },
  );
  const second = await broker.plan(
    "project-1",
    root,
    root,
    "team/widget",
    "evaluate",
    { sessionId: prepared.id },
  );

  const firstExecution = broker.execute(first.id, "project-1", root, root, "team/widget");
  await firstEntered;
  const secondExecution = broker.execute(second.id, "project-1", root, root, "team/widget");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(evaluationCalls, 1);
  releaseFirst();
  const evaluated = await firstExecution;
  assert.equal(evaluated.state, "governance_allowed");
  await assert.rejects(
    () => secondExecution,
    /state changed after preview/,
  );
  assert.equal(evaluationCalls, 1);
});

test("unknown apply reconciles before rollback and reaches a terminal recovered outcome", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  let broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  const prepared = await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const evaluated = await previewExecute(broker, root, "evaluate", { sessionId: prepared.id });
  broker = new ReleaseDeliveryBroker(
    new ReleaseDeliveryStore(state),
    env,
    fake.releaseInspection(
      evaluated.candidate.chisei.manifest_digest.slice(7),
      evaluated.candidate.chisei.artifact_digest.slice(7),
      evaluated.candidate.identity,
    ),
  );
  await previewExecute(broker, root, "publish", { sessionId: prepared.id });
  await previewExecute(broker, root, "promote", { sessionId: prepared.id });
  await previewExecute(broker, root, "plan", { sessionId: prepared.id });
  fake.setApplyUnknown(true);
  const failed = await previewExecute(broker, root, "apply", { sessionId: prepared.id });
  assert.equal(failed.state, "failed");
  assert.equal(failed.completeness, "partial");
  fake.setRollbackHealthy(false);
  const unhealthy = await previewExecute(broker, root, "rollback", {
    sessionId: prepared.id,
    reason: "fixture health failure",
  });
  assert.equal(unhealthy.state, "failed");
  assert.notEqual(unhealthy.completeness, "complete");

  fake.setRollbackHealthy(true);
  fake.setIncludeUnrelatedRollbackStep(true);
  const unrelated = await previewExecute(broker, root, "rollback", {
    sessionId: prepared.id,
    reason: "fixture health failure",
  });
  assert.equal(unrelated.state, "failed");
  assert.notEqual(unrelated.completeness, "complete");

  const store = new ReleaseDeliveryStore(state);
  const persisted = (await store.load()).find((session) => session.id === prepared.id);
  assert.ok(persisted);
  await store.put({
    ...persisted,
    tenkai: {
      ...persisted.tenkai,
      provenanceExpiresAt: new Date(Date.now() - 1).toISOString(),
    },
  });
  fake.setIncludeUnrelatedRollbackStep(false);
  fake.setRollbackHealthy(true);
  const recovered = await previewExecute(broker, root, "rollback", {
    sessionId: prepared.id,
    reason: "fixture health failure",
  });
  assert.equal(recovered.state, "recovered");
  assert.equal(recovered.completeness, "stale");
  const reconciled = await previewExecute(broker, root, "reconcile", {
    sessionId: prepared.id,
  });
  assert.equal(reconciled.state, "recovered");
  assert.equal(reconciled.completeness, "stale");
});

test("corrupt persisted history fails visibly instead of resetting sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-release-corrupt-"));
  await writeFile(join(directory, "release-deliveries.v1.json"), "{\"schema\":\"wrong\",\"sessions\":[]}");
  await assert.rejects(
    () => new ReleaseDeliveryStore(directory).load(),
    /history is corrupt/,
  );
});

test("nested persisted-session corruption is rejected before workflow routing", async () => {
  const { root, state } = await repositoryFixture();
  const fake = fakeRunner();
  const broker = new ReleaseDeliveryBroker(new ReleaseDeliveryStore(state), env, fake.runner);
  await previewExecute(broker, root, "prepare", { manifestPath: "tenkai.toml" });
  const path = join(state, "release-deliveries.v1.json");
  const original = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Array<Record<string, unknown>>;
  };
  const missingCandidateDocument = structuredClone(original);
  (missingCandidateDocument.sessions[0]?.candidate as Record<string, unknown>).document = null;
  await writeFile(path, JSON.stringify(missingCandidateDocument));
  await assert.rejects(
    () => new ReleaseDeliveryStore(state).load(),
    /history is corrupt/,
  );

  const invalidState = structuredClone(original);
  invalidState.sessions[0]!.state = "invented";
  await writeFile(path, JSON.stringify(invalidState));
  await assert.rejects(
    () => new ReleaseDeliveryStore(state).load(),
    /history is corrupt/,
  );
});
