import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import TOML from "@iarna/toml";
import { loadManagedHostConfiguration } from "./managed-host.ts";
import { isMutatingTool, PermissionBroker } from "./permission.ts";
import {
  type ShikigamiConfigFileOperations,
  assertManagedShikigamiVersion,
  assertSupportedShikigamiVersion,
  buildShikigamiConfig,
  confirmShikigamiRunId,
  normalizeShikigamiEvent,
  parseShikigamiStderrLine,
  parseShikigamiModelCatalog,
  permissionHookRuntimeEnvironment,
  managedShikigamiEnvironment,
  loadShikigamiConfig,
  MAX_SHIKIGAMI_CONFIG_BYTES,
  resolveModelAdapter,
  readShikigamiConfigFile,
  ShikigamiAdapter,
  ShikigamiToolIdTracker,
  supportsShikigamiModelCatalog,
  toolsForMode,
} from "./shikigami-provider.ts";

test("assertSupportedShikigamiVersion accepts 1.0.2+ product lines", () => {
  assert.equal(assertSupportedShikigamiVersion("shikigami 1.0.2"), "1.0.2");
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 0.2.0"), /major version 1/);
  assert.throws(() => assertSupportedShikigamiVersion("shikigami 1.0.1"), /1\.0\.2/);
});

test("Shikigami model catalog support starts at 1.0.5", () => {
  assert.equal(supportsShikigamiModelCatalog("1.0.4"), false);
  assert.equal(supportsShikigamiModelCatalog("1.0.5"), true);
  assert.equal(supportsShikigamiModelCatalog("1.1.0"), true);
});

test("parseShikigamiModelCatalog maps canonical models and the auto route", () => {
  const models = parseShikigamiModelCatalog(
    JSON.stringify({
      default_model: "auto",
      available_models: [
        {
          canonical_model: "auto",
          upstream_model: "auto",
          provider: "sekai-chisei",
          lifecycle: "routing",
        },
        {
          canonical_model: "openai/gpt-5.5",
          upstream_model: "gpt-5.5",
          provider: "openai",
          lifecycle: "active",
        },
        {
          canonical_model: "openai/gpt-5.5",
          upstream_model: "gpt-5.5",
          provider: "openai",
          lifecycle: "active",
        },
      ],
    }),
  );
  assert.deepEqual(models, [
    { id: "auto", displayName: "Auto (Sekai-Chisei)", isDefault: true },
    { id: "openai/gpt-5.5", displayName: "openai/gpt-5.5", isDefault: false },
  ]);
});

test("managed Shikigami requires plane-compatible version and emits the fixed profile", () => {
  assert.equal(assertManagedShikigamiVersion("shikigami 1.0.5"), "1.0.5");
  assert.throws(() => assertManagedShikigamiVersion("shikigami 1.0.4"), /1\.0\.5/);
  const runtime = {
    executable: "/opt/shikigami",
    model: "operator-model",
    governanceEndpoint: "https://chisei.internal",
    principal: "service:managed-code",
    namespace: "tenant/code",
    tokenEnv: "SEKAI_TOKEN",
    token: "secret-token",
    path: "/usr/bin:/bin",
  };
  const config = buildShikigamiConfig({
    worktree: "/srv/repos/code",
    mode: "build",
    modelAdapter: "http",
    modelId: "caller-model",
    managed: runtime,
  });
  assert.match(config, /name = "aldunis-code-managed"/);
  assert.match(config, /adapter = "plane"/);
  assert.match(config, /model = "operator-model"/);
  assert.match(config, /adapter = "sekai-chisei"/);
  assert.match(config, /fail_closed = true/);
  assert.match(config, /token_env = "SEKAI_TOKEN"/);
  assert.doesNotMatch(config, /enabled = \[[^\]]*"bash/);
  assert.doesNotMatch(config, /caller-model/);

  const environment = managedShikigamiEnvironment(runtime, "/srv/state/run", undefined);
  assert.equal(environment.SEKAI_TOKEN, "secret-token");
  assert.equal(environment.HOME, "/srv/state/run");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test("managed Shikigami reserves runtime environment names for its token", async () => {
  const env = {
    ALDUNIS_MANAGED_ASSERTION_ISSUER: "https://aldunis.test",
    ALDUNIS_MANAGED_ASSERTION_AUDIENCE: "aldunis-code-managed",
    ALDUNIS_MANAGED_TENANT_ID: "tenant-test",
    ALDUNIS_MANAGED_INSTANCE_ID: "code-instance-test",
    ALDUNIS_MANAGED_ASSERTION_PUBLIC_KEY_PEM: "invalid",
    ALDUNIS_MANAGED_REPOSITORIES_JSON: "[]",
    ALDUNIS_MANAGED_SHIKIGAMI_EXECUTABLE: "/bin/shikigami",
    ALDUNIS_MANAGED_SHIKIGAMI_MODEL: "model",
    ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT: "https://chisei.test",
    ALDUNIS_MANAGED_SHIKIGAMI_PRINCIPAL: "service:test",
    ALDUNIS_MANAGED_SHIKIGAMI_NAMESPACE: "tenant/code",
    ALDUNIS_MANAGED_SHIKIGAMI_TOKEN_ENV: "PATH",
    PATH: "token",
  };
  await assert.rejects(
    () => loadManagedHostConfiguration(env),
    /collides with a reserved runtime key/,
  );
});

test("normalizeShikigamiEvent maps harness events", () => {
  const tools = new ShikigamiToolIdTracker();
  const start = normalizeShikigamiEvent(
    { type: "tool_start", name: "read_file", args_json: "{}" },
    tools,
  );
  const end = normalizeShikigamiEvent(
    { type: "tool_end", name: "read_file", ok: true, detail: "ok" },
    tools,
  );
  assert.equal(start[0]?.kind, "tool_started");
  assert.equal(end[0]?.kind, "tool_finished");
  if (start[0]?.kind === "tool_started" && end[0]?.kind === "tool_finished") {
    assert.equal(start[0].toolCallId, end[0].toolCallId);
  }
  const finished = normalizeShikigamiEvent({
    type: "run_finished",
    run_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    success: true,
    summary: "done",
  });
  assert.equal(finished.at(-1)?.kind, "turn_completed");
  assert.deepEqual(normalizeShikigamiEvent({ type: "status", status: "starting" }), []);
  assert.deepEqual(
    normalizeShikigamiEvent({
      type: "message",
      level: "info",
      text: "workspace /workspaces/sekai-chisei",
    }),
    [],
  );
  assert.deepEqual(normalizeShikigamiEvent({ type: "future_event_type" }), []);
});

test("parseShikigamiStderrLine ignores non-event output", () => {
  assert.equal(parseShikigamiStderrLine("noise"), null);
  assert.deepEqual(
    parseShikigamiStderrLine('[shikigami] {"type":"status","status":"running"}'),
    [],
  );
  assert.deepEqual(
    parseShikigamiStderrLine(
      '[shikigami] {"type":"message","level":"info","text":"project_rules AGENTS.md digest=abc"}',
    ),
    [],
  );
});

test("buildShikigamiConfig encodes mode tool allow-lists and pre_tool gate", () => {
  assert.equal(toolsForMode("ask").includes("write_file"), false);
  assert.equal(toolsForMode("build").includes("write_file"), true);
  assert.equal(isMutatingTool("write_file"), true);
  assert.equal(isMutatingTool("read_file"), false);

  const ask = buildShikigamiConfig({
    worktree: "/tmp/ws",
    mode: "ask",
    modelAdapter: "scripted",
    modelId: "scripted",
  });
  assert.match(ask, /adapter = "scripted"/);
  assert.match(ask, /"read_file"/);
  assert.doesNotMatch(ask, /"write_file"/);

  const build = buildShikigamiConfig({
    worktree: "/tmp/ws",
    mode: "build",
    modelAdapter: "http",
    modelId: "gpt-4.1-mini",
    nodeExecutable: "/usr/bin/node",
    permissionHookPath: "/tmp/hook.mjs",
    permissionConfigPath: "/tmp/gate.json",
  });
  assert.match(build, /adapter = "http"/);
  assert.match(build, /"write_file"/);
  assert.match(build, /"apply_patch"/);
  assert.match(build, /"bash"/);
  assert.match(build, /"todo_write"/);
  assert.match(build, /event = "pre_tool"/);
  assert.match(build, /fail_closed = true/);
  assert.match(build, /hook\.mjs/);
});

test("native Shikigami settings survive the Code safety overlay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-config-"));
  const stateDirectory = join(directory, "state");
  const nativePath = join(stateDirectory, "shikigami.toml");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    nativePath,
    `version = 1

[profile]
name = "local"

[model]
adapter = "http"
model = "local-model"
base_url = "http://127.0.0.1:11434/v1"
api_key_env = "LOCAL_KEY"

[governance]
adapter = "local"
fail_closed = true

[run]
tool_concurrency = 1

[network]
allowlist = ["127.0.0.1"]
`,
    "utf8",
  );
  const loaded = await loadShikigamiConfig({
    environment: { SHIKIGAMI_STATE: stateDirectory },
    cwd: directory,
  });
  assert.equal(loaded.path, nativePath);
  const resolved = resolveModelAdapter({ LOCAL_KEY: "local" }, loaded.values);
  assert.equal(resolved.adapter, "http");
  assert.equal(resolved.modelId, "local-model");
  assert.equal(resolved.apiKeyEnv, "LOCAL_KEY");

  const overlay = TOML.parse(
    buildShikigamiConfig({
      worktree: directory,
      mode: "ask",
      modelAdapter: resolved.adapter,
      modelId: resolved.modelId,
      baseUrl: resolved.baseUrl,
      apiKeyEnv: resolved.apiKeyEnv,
      baseConfig: loaded.values,
      governanceAdapter: "local",
      failClosed: true,
    }),
  ) as Record<string, unknown>;
  assert.equal((overlay.model as Record<string, unknown>).base_url, "http://127.0.0.1:11434/v1");
  assert.equal((overlay.governance as Record<string, unknown>).fail_closed, true);
  assert.equal((overlay.run as Record<string, unknown>).tool_concurrency, 1);
  assert.deepEqual((overlay.network as Record<string, unknown>).allowlist, ["127.0.0.1"]);
  assert.equal((overlay.workspace as Record<string, unknown>).adapter, "inplace");
  assert.equal((overlay.workspace as Record<string, unknown>).root, directory);
  assert.equal((overlay.tools as Record<string, unknown>).mode, "custom");
  assert.deepEqual((overlay.tools as Record<string, unknown>).enabled, toolsForMode("ask"));
  assert.equal((overlay.tools as Record<string, unknown>).mcp_servers instanceof Array, true);
});

test("explicit Shikigami config paths fail visibly when missing", async () => {
  await assert.rejects(
    () => loadShikigamiConfig({ explicitPath: "/nonexistent/aldunis-shikigami.toml" }),
    /config file was not found/,
  );
});

test("Shikigami config loading rejects oversize before content allocation", async () => {
  let read = false;
  let closed = false;
  const identity = {
    size: MAX_SHIKIGAMI_CONFIG_BYTES + 1,
    dev: 1,
    ino: 2,
    mode: 0o100600,
    mtimeMs: 3,
    ctimeMs: 4,
  };
  const operations: ShikigamiConfigFileOperations = {
    stat: async () => identity,
    open: async () => ({
      stat: async () => identity,
      read: async () => {
        read = true;
        return { bytesRead: 0 };
      },
      close: async () => {
        closed = true;
      },
    }),
  };

  await assert.rejects(
    () => readShikigamiConfigFile("fixture.toml", operations),
    /exceeds 4096 KiB/,
  );
  assert.equal(read, false);
  assert.equal(closed, true);
});

test("Shikigami config loading closes and rejects concurrent file changes", async () => {
  const mutations = {
    shrink: async (path: string) => truncate(path, 1),
    growth: async (path: string) => writeFile(path, "more", { flag: "a" }),
    mutation: async (path: string) => writeFile(path, "changed!"),
    replacement: async (path: string) => {
      const next = `${path}.next`;
      await writeFile(next, "replace");
      await rename(next, path);
    },
    disappearance: async (path: string) => unlink(path),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const directory = await mkdtemp(join(tmpdir(), `aldunis-shikigami-${name}-`));
    const path = join(directory, "shikigami.toml");
    await writeFile(path, "original");
    let closed = false;
    let mutated = false;
    const operations: ShikigamiConfigFileOperations = {
      stat,
      open: async (candidate) => {
        const handle = await open(candidate, "r");
        return {
          close: async () => {
            closed = true;
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            const { bytesRead } = await handle.read(buffer, offset, length, position);
            if (!mutated) {
              mutated = true;
              await mutate(candidate);
            }
            return { bytesRead };
          },
          stat: () => handle.stat(),
        };
      },
    };

    await assert.rejects(
      () => readShikigamiConfigFile(path, operations),
      /changed while being read/,
    );
    assert.equal(closed, true, `${name} must close the config handle`);
  }
});

test("Shikigami config loading rejects short reads and close failures", async () => {
  const identity = { size: 1, dev: 1, ino: 2, mode: 0o100600, mtimeMs: 3, ctimeMs: 4 };
  let shortClosed = false;
  await assert.rejects(
    () =>
      readShikigamiConfigFile("short.toml", {
        stat: async () => identity,
        open: async () => ({
          stat: async () => identity,
          read: async () => ({ bytesRead: 0 }),
          close: async () => {
            shortClosed = true;
          },
        }),
      }),
    /changed while being read/,
  );
  assert.equal(shortClosed, true);

  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-close-"));
  const path = join(directory, "shikigami.toml");
  await writeFile(path, "x");
  await assert.rejects(
    () =>
      readShikigamiConfigFile(path, {
        stat,
        open: async (candidate) => {
          const handle = await open(candidate, "r");
          return {
            stat: () => handle.stat(),
            read: async (buffer, offset, length, position) => {
              const { bytesRead } = await handle.read(buffer, offset, length, position);
              return { bytesRead };
            },
            close: async () => {
              await handle.close();
              throw new Error("fixture close failure");
            },
          };
        },
      }),
    /could not be closed/,
  );
});

test("Electron-hosted hooks run the embedded runtime as Node", () => {
  const source = { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" };
  const electron = permissionHookRuntimeEnvironment(source, "43.2.0");
  const node = permissionHookRuntimeEnvironment(source, undefined);

  assert.notEqual(electron, source);
  assert.equal(electron.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(node.ELECTRON_RUN_AS_NODE, "unexpected");
  assert.deepEqual(source, { PATH: "/bin", ELECTRON_RUN_AS_NODE: "unexpected" });
});

test("ShikigamiAdapter streams events from a fixture CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  console.error('[shikigami] {"type":"tool_start","name":"report","args_json":"{}"}');
  console.error('[shikigami] {"type":"tool_end","name":"report","ok":true,"detail":"ok"}');
  console.error('[shikigami] {"type":"run_finished","run_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","success":true,"summary":"fixture complete"}');
  console.log("run aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee turns=1 success=true termination=completed summary=fixture complete");
  process.exit(0);
}
console.error("unexpected");
process.exit(1);
`,
  );
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const readiness = await adapter.readiness({
    ...process.env,
    SHIKIGAMI_MODEL_ADAPTER: "scripted",
  });
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, true);
  assert.equal(readiness.version, "1.0.2");
  assert.equal(readiness.detail, null);

  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "11111111-1111-4111-8111-111111111111",
      prompt: "demo task",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
    },
    {
      ...process.env,
      SHIKIGAMI_MODEL_ADAPTER: "scripted",
      SHIKIGAMI_GOVERNANCE_ADAPTER: "sekai-chisei",
    },
  );
  const kinds: string[] = [];
  for await (const event of run.events) kinds.push(event.kind);
  assert.deepEqual(kinds, [
    "session_started",
    "tool_started",
    "tool_finished",
    "assistant_text",
    "governance_correlation",
    "turn_completed",
  ]);
});

test("normalizeShikigamiEvent rejects malformed provider run identities", () => {
  assert.throws(
    () =>
      normalizeShikigamiEvent({
        type: "run_finished",
        run_id: "invented-local-id",
        success: true,
      }),
    /malformed run identity/,
  );
});

test("provider-confirmed Shikigami identities reject conflicting resume output", () => {
  const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(confirmShikigamiRunId(runId, runId), runId);
  assert.equal(confirmShikigamiRunId(runId, runId.toUpperCase()), runId);
  assert.throws(
    () => confirmShikigamiRunId(runId, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"),
    /conflicting run identities/,
  );
});

test("ShikigamiAdapter fails visibly when stderr and stdout run identities conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-conflict-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
console.error('[shikigami] {"type":"run_finished","run_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","success":true,"summary":"done"}');
console.error('[shikigami] {"type":"run_finished","run_id":"bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee","success":true,"summary":"duplicate"}');
console.log("run bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee turns=1 success=true termination=completed");
`,
  );
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "11111111-1111-4111-8111-111111111111",
      prompt: "demo",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
    },
    {
      ...process.env,
      SHIKIGAMI_MODEL_ADAPTER: "scripted",
      SHIKIGAMI_GOVERNANCE_ADAPTER: "sekai-chisei",
    },
  );
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.ok(
    events.some(
      (event) => event.kind === "failed" && /conflicting run identities/.test(event.message),
    ),
  );
  assert.equal(
    events.some((event) => event.kind === "governance_correlation"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "turn_completed"),
    false,
  );
});

test("governed Shikigami runs fail when the provider confirms no run identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-missing-id-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === "version") console.log("shikigami 1.0.2");
`,
  );
  await chmod(executable, 0o700);
  const run = await new ShikigamiAdapter(executable).start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "11111111-1111-4111-8111-111111111111",
      prompt: "demo",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
    },
    {
      ...process.env,
      SHIKIGAMI_MODEL_ADAPTER: "scripted",
      SHIKIGAMI_GOVERNANCE_ADAPTER: "sekai-chisei",
    },
  );
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "failed" && /without a provider-confirmed run identity/.test(event.message),
    ),
  );
  assert.equal(
    events.some((event) => event.kind === "turn_completed"),
    false,
  );
});

test("ShikigamiAdapter readiness reports install detail when missing", async () => {
  const adapter = new ShikigamiAdapter("/nonexistent/shikigami-binary-aldunis-test");
  const readiness = await adapter.readiness(process.env);
  assert.equal(readiness.installed, false);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /Install shikigami 1\.0\.2\+/);
});

test("ShikigamiAdapter readiness reports unsupported version detail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-version-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
console.log("shikigami 1.0.1");
`,
  );
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const readiness = await adapter.readiness(process.env);
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /1\.0\.2/);
});

test("ShikigamiAdapter readiness reports missing HTTP key when forced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-http-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
console.log("shikigami 1.0.2");
`,
  );
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const env = {
    ...process.env,
    SHIKIGAMI_MODEL_ADAPTER: "http",
    SHIKIGAMI_API_KEY_ENV: "OPENAI_API_KEY",
  };
  delete env.OPENAI_API_KEY;
  const readiness = await adapter.readiness(env);
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authenticated, false);
  assert.match(readiness.detail ?? "", /OPENAI_API_KEY|SHIKIGAMI_API_KEY_ENV|scripted/);
});

test("ShikigamiAdapter readiness discovers governed model catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-models-"));
  const executable = join(directory, "fake-shikigami");
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "version") {',
    '  console.log("shikigami 1.0.5");',
    "  process.exit(0);",
    "}",
    'if (args.includes("doctor") && args.includes("--models") && args.includes("--json")) {',
    "  console.log(JSON.stringify({",
    '    default_model: "auto",',
    "    available_models: [",
    '      { canonical_model: "auto", upstream_model: "auto" },',
    '      { canonical_model: "openai/gpt-5.5", upstream_model: "gpt-5.5" },',
    "    ],",
    "  }));",
    "  process.exit(0);",
    "}",
    "process.exit(1);",
  ].join("\n");
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  const readiness = await adapter.readiness(
    {
      ...process.env,
      SHIKIGAMI_MODEL_ADAPTER: "plane",
    },
    { cwd: directory },
  );
  assert.deepEqual(readiness.models, [
    { id: "auto", displayName: "Auto (Sekai-Chisei)", isDefault: true },
    { id: "openai/gpt-5.5", displayName: "openai/gpt-5.5", isDefault: false },
  ]);
});

test("ShikigamiAdapter normalizes a parked question as a native resume request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-park-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  console.error('[shikigami] {"type":"run_finished","run_id":"bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee","success":false,"summary":"need operator input"}');
  console.log("run bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee turns=1 success=false termination=parked summary=need operator input");
  console.log("parked reason=need operator input");
  console.log("parked question=continue?");
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "33333333-3333-4333-8333-333333333333",
      prompt: "park me",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
    },
    {
      ...process.env,
      SHIKIGAMI_GOVERNANCE_ADAPTER: "sekai-chisei",
    },
  );
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "governance_correlation" &&
        event.runId === "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
    ),
  );
  const request = events.find((event) => event.kind === "input_requested");
  assert.equal(request?.kind, "input_requested");
  if (request?.kind === "input_requested") {
    assert.equal(request.question, "continue?");
    assert.equal(request.providerRequestId, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.equal(request.responseMode, "native_resume");
  }
});

test("ShikigamiAdapter resumes with a protected transient answer file and cleans it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-resume-"));
  const stateRoot = join(directory, "state-root");
  const executable = join(directory, "fake-shikigami");
  const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const conversationId = "44444444-4444-4444-8444-444444444444";
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.5");
  process.exit(0);
}
if (args.includes("--resume")) {
  const resumeId = args[args.indexOf("--resume") + 1];
  const answerPath = args[args.indexOf("--answer-file") + 1];
  const answer = fs.readFileSync(answerPath, "utf8");
  const permissions = fs.statSync(answerPath).mode & 0o777;
  if (resumeId !== "${runId}" || answer !== "operator answer" || permissions !== 0o600) process.exit(2);
  console.error("[shikigami] " + JSON.stringify({
    type: "run_finished",
    run_id: resumeId,
    success: true,
    summary: "resumed",
  }));
  console.log("run " + resumeId + " turns=2 success=true termination=completed summary=resumed");
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.resumeParked(
    {
      repository: directory,
      worktree: directory,
      conversationId,
      prompt: "",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
      resumeSessionId: runId,
      model: "scripted",
    },
    "operator answer",
    process.env,
    {
      executable,
      model: "scripted",
      governanceEndpoint: "http://127.0.0.1:9",
      principal: "service:test",
      namespace: "test",
      tokenEnv: "TEST_TOKEN",
      token: "test-token",
      path: process.env.PATH,
      stateRoot,
    },
  );
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.equal(events.at(-1)?.kind, "turn_completed");
  assert.equal(
    events.some((event) => event.kind === "failed"),
    false,
  );
  assert.deepEqual(await readdir(join(stateRoot, conversationId, "tmp")), []);
});

test("ShikigamiAdapter fails closed when native resume capability is too old", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-resume-version-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === "version") console.log("shikigami 1.0.4");
else process.exit(0);
`,
  );
  await chmod(executable, 0o700);
  const adapter = new ShikigamiAdapter(executable);
  await assert.rejects(
    () =>
      adapter.resumeParked(
        {
          repository: directory,
          worktree: directory,
          conversationId: "55555555-5555-4555-8555-555555555555",
          prompt: "",
          approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
          mode: "build",
          resumeSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          model: "scripted",
        },
        "answer",
        {
          ...process.env,
          SHIKIGAMI_MODEL_ADAPTER: "scripted",
        },
      ),
    /requires Shikigami 1\.0\.5/,
  );
});

test("ShikigamiAdapter emits approval_pending for mutating tools in build mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-approve-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  const start = { type: "tool_start", name: "write_file", args_json: JSON.stringify({ path: "a.txt", content: "x" }) };
  console.error("[shikigami] " + JSON.stringify(start));
  console.error('[shikigami] {"type":"tool_end","name":"write_file","ok":true,"detail":"ok"}');
  console.error('[shikigami] {"type":"run_finished","run_id":"cccccccc-cccc-cccc-cccc-cccccccccccc","success":true,"summary":"wrote"}');
  process.exit(0);
}
process.exit(1);
`,
  );
  await chmod(executable, 0o700);

  const permissions = new PermissionBroker();
  const adapter = new ShikigamiAdapter(executable, permissions);
  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "44444444-4444-4444-8444-444444444444",
      prompt: "write",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "build",
    },
    process.env,
  );

  const events = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.kind === "approval_pending") {
      permissions.decide(
        event.id,
        {
          runId: event.runId,
          conversationId: event.conversationId,
          repository: event.repository,
          worktree: event.worktree,
          toolCallId: event.toolCallId,
        },
        "allow_once",
      );
    }
  }
  assert.ok(events.some((event) => event.kind === "approval_pending"));
  assert.ok(events.some((event) => event.kind === "approval_resolved"));
  assert.ok(events.some((event) => event.kind === "tool_started"));
  assert.ok(events.some((event) => event.kind === "turn_completed"));
});

test("ShikigamiAdapter fails closed when mutating tools run outside build mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-ask-mutate-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
if (args.includes("run")) {
  const start = { type: "tool_start", name: "write_file", args_json: JSON.stringify({ path: "a.txt", content: "x" }) };
  console.error("[shikigami] " + JSON.stringify(start));
  setInterval(() => {}, 1000);
}
process.exit(1);
`,
  );
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "55555555-5555-4555-8555-555555555555",
      prompt: "should fail",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "ask",
    },
    process.env,
  );
  const events = [];
  for await (const event of run.events) events.push(event);
  const failed = events.find((event) => event.kind === "failed");
  assert.equal(failed?.kind, "failed");
  if (failed?.kind === "failed") {
    assert.equal(failed.code, "provider_mode_violation");
    assert.equal(failed.toolName, "write_file");
    assert.equal(failed.mode, "ask");
    assert.match(failed.message, /write_file/);
    assert.match(failed.message, /ask mode/);
  }
});

test("shikigami permission hook allows once and denies via PermissionBroker", async () => {
  const permissions = new PermissionBroker(30_000);
  const runId = "run-hook-1";
  const token = permissions.createRunToken(runId);
  const toolInput = { path: "a.txt", content: "hello" };
  const denyInput = { path: "b.txt", content: "nope" };

  let resolveRequest: ((body: { toolName: string; input: unknown }) => void) | null = null;
  const nextRequest = () =>
    new Promise<{ toolName: string; input: unknown }>((resolve) => {
      resolveRequest = resolve;
    });

  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        runId: string;
        toolName: string;
        input: unknown;
      };
      const authorization = request.headers.authorization ?? "";
      // Attach to the pending approval before the test resolves it.
      const resultPromise = permissions.awaitDecision(
        body.runId,
        authorization.slice("Bearer ".length),
        body.toolName,
        body.input,
      );
      resolveRequest?.({ toolName: body.toolName, input: body.input });
      resolveRequest = null;
      const result = await resultPromise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "failed",
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const approvalUrl = `http://127.0.0.1:${address.port}/api/provider/permissions/request`;

  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-hook-"));
  const configPath = join(directory, "gate.json");
  await writeFile(
    configPath,
    JSON.stringify({
      approvalUrl,
      runId,
      token,
      mutatingTools: ["write_file", "edit", "bash"],
    }),
  );

  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const hookPath = fileURLToPath(new URL("./shikigami-permission-hook.mjs", import.meta.url));

  const runHook = (payload: object) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [hookPath, configPath], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => resolve({ code, stderr }));
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });

  const approval = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:1",
    toolName: "write_file",
    toolInput,
    provider: "Shikigami",
  });
  assert.ok(approval);
  const allowSeen = nextRequest();
  const allowWait = runHook({
    event: "pre_tool",
    payload: { run_id: "h1", tool: "write_file", args_json: JSON.stringify(toolInput) },
  });
  await allowSeen;
  permissions.decide(
    approval.id,
    {
      runId,
      conversationId: "c1",
      repository: "/repo",
      worktree: "/repo/wt",
      toolCallId: "shikigami:write_file:1",
    },
    "allow_once",
  );
  const allowed = await allowWait;
  assert.equal(allowed.code, 0, allowed.stderr);

  const identicalInput = { path: "same.txt", content: "same" };
  const firstIdentical = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-1",
    toolName: "write_file",
    toolInput: identicalInput,
    provider: "Shikigami",
  });
  const secondIdentical = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:identical-2",
    toolName: "write_file",
    toolInput: identicalInput,
    provider: "Shikigami",
  });
  assert.ok(firstIdentical);
  assert.ok(secondIdentical);

  const firstIdenticalSeen = nextRequest();
  const firstIdenticalWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(identicalInput),
    },
  });
  await firstIdenticalSeen;
  const secondIdenticalSeen = nextRequest();
  let secondIdenticalSettled = false;
  const secondIdenticalWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(identicalInput),
    },
  }).finally(() => {
    secondIdenticalSettled = true;
  });
  await secondIdenticalSeen;

  permissions.decide(
    firstIdentical.id,
    {
      runId,
      conversationId: "c1",
      repository: "/repo",
      worktree: "/repo/wt",
      toolCallId: "shikigami:write_file:identical-1",
    },
    "allow_once",
  );
  const firstIdenticalResult = await firstIdenticalWait;
  assert.equal(firstIdenticalResult.code, 0, firstIdenticalResult.stderr);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    secondIdenticalSettled,
    false,
    "one allow-once must not release an identical operation",
  );

  permissions.decide(
    secondIdentical.id,
    {
      runId,
      conversationId: "c1",
      repository: "/repo",
      worktree: "/repo/wt",
      toolCallId: "shikigami:write_file:identical-2",
    },
    "deny",
  );
  const secondIdenticalResult = await secondIdenticalWait;
  assert.equal(secondIdenticalResult.code, 1, secondIdenticalResult.stderr);

  const denyApproval = permissions.register({
    runId,
    conversationId: "c1",
    repository: "/repo",
    worktree: "/repo/wt",
    toolCallId: "shikigami:write_file:2",
    toolName: "write_file",
    toolInput: denyInput,
    provider: "Shikigami",
  });
  assert.ok(denyApproval);
  const denySeen = nextRequest();
  const denyWait = runHook({
    event: "pre_tool",
    payload: {
      run_id: "h1",
      tool: "write_file",
      args_json: JSON.stringify(denyInput),
    },
  });
  await denySeen;
  permissions.decide(
    denyApproval.id,
    {
      runId,
      conversationId: "c1",
      repository: "/repo",
      worktree: "/repo/wt",
      toolCallId: "shikigami:write_file:2",
    },
    "deny",
  );
  const denied = await denyWait;
  assert.equal(denied.code, 1, denied.stderr);

  const skip = await runHook({
    event: "pre_tool",
    payload: { run_id: "h1", tool: "read_file", args_json: '{"path":"a.txt"}' },
  });
  assert.equal(skip.code, 0);

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("ShikigamiAdapter cancel stops a long-running fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-shikigami-cancel-"));
  const executable = join(directory, "fake-shikigami");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("shikigami 1.0.2");
  process.exit(0);
}
console.error('[shikigami] {"type":"status","status":"running"}');
process.on("SIGTERM", () => {
  console.log("run bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee termination=parked");
  console.log("parked question=should not survive cancellation?");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
  );
  await chmod(executable, 0o700);

  const adapter = new ShikigamiAdapter(executable);
  const run = await adapter.start(
    {
      repository: directory,
      worktree: directory,
      conversationId: "22222222-2222-4222-8222-222222222222",
      prompt: "hang",
      approvalUrl: "http://127.0.0.1:9/api/provider/permissions/request",
      mode: "ask",
    },
    process.env,
  );
  const kinds: string[] = [];
  for await (const event of run.events) {
    kinds.push(event.kind);
    if (event.kind === "session_started") assert.equal(adapter.cancel(run.id), true);
  }
  assert.ok(kinds.includes("session_started"));
  assert.ok(kinds.includes("cancelled") || kinds.includes("failed"));
  assert.ok(!kinds.includes("input_requested"));
  assert.equal(adapter.cancel(run.id), false);
});
