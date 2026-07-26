import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acpAllowOnceOption,
  acpPromptRequest,
  acpReadTextFile,
  acpSessionRequest,
  isOptionalGrokNotification,
  isOptionalKiroNotification,
  normalizeAcpNotification,
} from "./acp-provider.ts";
import {
  adapterDigest,
  parseProviderAdapterManifest,
  ProviderAdapterError,
  ProviderAdapterStore,
  type ProviderAdapterManifest,
} from "./provider-adapters.ts";

function manifest(overrides: Partial<ProviderAdapterManifest> = {}): ProviderAdapterManifest {
  return {
    schemaVersion: 1,
    id: "example.acp-agent",
    publisher: { name: "Example Tools" },
    version: "1.0.0",
    aldunis: { minimumVersion: "0.1.0", maximumVersion: "0.1.0" },
    protocol: { kind: "acp", minimumVersion: 1, maximumVersion: 1 },
    executable: { names: ["example-agent"], arguments: ["--acp"] },
    capabilities: { tools: true, images: false, sessionResume: true },
    environment: [{ name: "EXAMPLE_TOKEN", required: false, sensitive: true }],
    presentation: {
      name: "Example Agent",
      description: "A fixture declarative provider.",
      website: "https://example.com",
    },
    ...overrides,
  };
}

test("adapter manifests reject unknown fields, traversal, interpreters, and incompatible protocols", () => {
  assert.throws(
    () => parseProviderAdapterManifest({ ...manifest(), executableCode: "export default 1" }),
    /unknown field executableCode/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({ id: "../escape" })),
    /stable lowercase dotted identifier/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({ executable: { names: ["node"], arguments: ["-e"] } })),
    /generic interpreter/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({ executable: { names: ["python3.12"], arguments: ["-c"] } })),
    /generic interpreter/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({ executable: { names: ["busybox"], arguments: ["sh"] } })),
    /generic interpreter/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      executable: { names: ["git"], arguments: ["-c", "alias.run=!echo compromised", "run"] },
    })),
    /generic interpreter/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      executable: { names: ["example-agent"], arguments: ["--eval=code"] },
    })),
    /option flags only/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      executable: { names: ["example-agent"], arguments: ["../script"] },
    })),
    /option flags only/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      executable: { names: ["rm"], arguments: ["-rf", "src"] },
    })),
    /option flags only/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      protocol: { kind: "acp", minimumVersion: 2, maximumVersion: 2 } as never,
    })),
    /unsupported protocol/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      presentation: { name: "Example", description: "Invalid URL", website: "::not-a-url" },
    })),
    /valid HTTPS URL/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      capabilities: { tools: true, images: false, sessionResume: false },
    })),
    /resumable multi-turn sessions/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      capabilities: { tools: true, images: true, sessionResume: true },
    })),
    /do not support normalized image content/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({ version: "1.0.0-beta.01" })),
    /semantic version/,
  );
});

test("adapter digest is canonical and changes with reviewed authority inputs", () => {
  const parsed = parseProviderAdapterManifest(manifest());
  const reordered = parseProviderAdapterManifest({
    presentation: parsed.presentation,
    environment: parsed.environment,
    capabilities: parsed.capabilities,
    executable: parsed.executable,
    protocol: parsed.protocol,
    aldunis: parsed.aldunis,
    version: parsed.version,
    publisher: parsed.publisher,
    id: parsed.id,
    schemaVersion: parsed.schemaVersion,
  });
  assert.equal(adapterDigest(parsed), adapterDigest(reordered));
  assert.notEqual(
    adapterDigest(parsed),
    adapterDigest(parseProviderAdapterManifest(manifest({
      capabilities: { ...parsed.capabilities, tools: false },
    }))),
  );
});

test("adapter store installs atomically, blocks duplicates and downgrades, and retains rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapters-"));
  const store = new ProviderAdapterStore(directory);
  const first = parseProviderAdapterManifest(manifest());
  const input = { source: "file:///tmp/example-adapter.json", digest: adapterDigest(first), manifest: first };
  const installed = await store.install(input);
  assert.equal(installed.enabled, true);
  await assert.rejects(store.install(input), (error: unknown) => (
    error instanceof ProviderAdapterError && error.status === 409
  ));

  const lower = parseProviderAdapterManifest(manifest({ version: "0.9.0" }));
  await assert.rejects(
    store.update({ ...input, digest: adapterDigest(lower), manifest: lower }),
    /increase the semantic version/,
  );
  const second = parseProviderAdapterManifest(manifest({
    version: "1.1.0",
    capabilities: { ...first.capabilities, tools: false },
  }));
  await store.setEnabled(first.id, false);
  await store.update({ ...input, digest: adapterDigest(second), manifest: second });
  assert.equal((await store.get(first.id))?.current.enabled, false);
  assert.equal((await store.version(`adapter:${first.id}@${first.version}`))?.enabled, false);
  assert.equal((await store.rollback(first.id)).manifest.version, "1.0.0");
  assert.equal((await store.setEnabled(first.id, true)).enabled, true);
  const stored = JSON.parse(await readFile(join(directory, "provider-adapters", `${first.id}.json`), "utf8")) as {
    current: { manifest: ProviderAdapterManifest };
  };
  assert.equal(stored.current.manifest.version, "1.0.0");
  assert.equal(JSON.stringify(stored).includes("token-value"), false);
  await store.uninstall(first.id);
  assert.equal(await store.get(first.id), null);
});

test("adapter mutations serialize concurrent installs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-concurrent-"));
  const store = new ProviderAdapterStore(directory);
  const candidate = parseProviderAdapterManifest(manifest());
  const input = {
    source: "https://example.com/adapter.json",
    digest: adapterDigest(candidate),
    manifest: candidate,
  };
  const results = await Promise.allSettled([store.install(input), store.install(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("adapter store validates retained rollback integrity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-retained-"));
  const store = new ProviderAdapterStore(directory);
  const first = parseProviderAdapterManifest(manifest());
  await store.install({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(first),
    manifest: first,
  });
  const second = parseProviderAdapterManifest(manifest({ version: "1.1.0" }));
  await store.update({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(second),
    manifest: second,
  });
  const path = join(directory, "provider-adapters", `${first.id}.json`);
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    previous: { manifest: ProviderAdapterManifest };
  };
  stored.previous.manifest.executable.arguments = ["--tampered"];
  await writeFile(path, JSON.stringify(stored), "utf8");
  await assert.rejects(store.get(first.id), /failed integrity verification/);
});

test("adapter updates follow semantic-version prerelease precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-semver-"));
  const store = new ProviderAdapterStore(directory);
  const beta2 = parseProviderAdapterManifest(manifest({ version: "1.0.0-beta.2" }));
  await store.install({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(beta2),
    manifest: beta2,
  });
  const beta10 = parseProviderAdapterManifest(manifest({ version: "1.0.0-beta.10" }));
  await store.update({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(beta10),
    manifest: beta10,
  });
  const release = parseProviderAdapterManifest(manifest({ version: "1.0.0" }));
  await store.update({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(release),
    manifest: release,
  });
  assert.equal((await store.get(release.id))?.current.manifest.version, "1.0.0");
});

test("adapter update ordering compares arbitrarily large version identifiers exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-large-version-"));
  const store = new ProviderAdapterStore(directory);
  const first = parseProviderAdapterManifest(manifest({ version: "90071992547409930.0.0" }));
  await store.install({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(first),
    manifest: first,
  });
  const lower = parseProviderAdapterManifest(manifest({ version: "90071992547409929.999999999999999999.0" }));
  await assert.rejects(store.update({
    source: "https://example.com/adapter.json",
    digest: adapterDigest(lower),
    manifest: lower,
  }), /increase the semantic version/);
});

test("adapter inspection fails closed on digest mismatch", () => {
  const directory = join(tmpdir(), "unused-adapter-state");
  const store = new ProviderAdapterStore(directory);
  assert.throws(
    () => store.inspect({
      source: "https://example.com/adapter.json",
      digest: "sha256:deadbeef",
      manifest: manifest(),
    }),
    /digest does not match/,
  );
  assert.throws(
    () => store.inspect({ source: "not-a-url", digest: adapterDigest(manifest()), manifest: manifest() }),
    /valid HTTPS or local file URL/,
  );
  assert.throws(
    () => store.inspect({
      source: "https://token@example.com/adapter.json?signature=secret",
      digest: adapterDigest(manifest()),
      manifest: manifest(),
    }),
    /HTTPS or local file URL/,
  );
});

test("selected provider paths must be executable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aldunis-adapter-executable-"));
  const path = join(directory, "example-agent");
  await writeFile(path, "not executable", "utf8");
  await chmod(path, 0o600);
  const parsed = parseProviderAdapterManifest(manifest());
  const installed = {
    schemaVersion: 1 as const,
    source: "file:///tmp/adapter.json",
    digest: adapterDigest(parsed),
    enabled: true,
    installedAt: new Date().toISOString(),
    manifest: parsed,
  };
  await assert.rejects(
    new ProviderAdapterStore(directory).resolveExecutable(installed, path),
  );
});

test("adapter versions accept SemVer build metadata", () => {
  assert.equal(
    parseProviderAdapterManifest(manifest({ version: "1.2.3-beta.1+linux.arm64" })).version,
    "1.2.3-beta.1+linux.arm64",
  );
});

test("ACP normalization accepts known updates and rejects unknown protocol messages", () => {
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    },
  }), [{ kind: "assistant_text", text: "hello" }]);
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "failed",
      },
    },
  }), [{ kind: "tool_finished", toolCallId: "tool-1", failed: true }]);
  // Grok Build emits metadata-only tool_call_update frames without status.
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-2",
        kind: "read",
        title: "Read package.json",
      },
    },
  }), []);
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-3",
        status: "Success",
      },
    },
  }), [{ kind: "tool_finished", toolCallId: "tool-3", failed: false }]);
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-4",
        status: "running",
      },
    },
  }), []);
  assert.throws(
    () => normalizeAcpNotification({
      method: "session/update",
      params: { update: { sessionUpdate: "host_extension" } },
    }),
    /Unsupported ACP session update/,
  );
});

test("the shipped Kiro adapter is declarative, direct-only, and schema-valid", async () => {
  const raw = await readFile(
    new URL("../provider-adapters/kiro-cli.json", import.meta.url),
    "utf8",
  );
  const parsed = parseProviderAdapterManifest(JSON.parse(raw));
  const reviewedDigest = (
    await readFile(new URL("../provider-adapters/kiro-cli.sha256", import.meta.url), "utf8")
  ).trim();
  assert.equal(parsed.id, "dev.kiro.cli");
  assert.deepEqual(parsed.executable, {
    names: ["kiro-cli", "kiro-cli.exe"],
    arguments: ["acp"],
  });
  assert.deepEqual(parsed.environment, [
    { name: "HOME", required: false, sensitive: true },
    { name: "KIRO_HOME", required: false, sensitive: true },
    { name: "USERPROFILE", required: false, sensitive: true },
    { name: "XDG_RUNTIME_DIR", required: false, sensitive: true },
  ]);
  assert.equal(parsed.capabilities.tools, true);
  assert.equal(parsed.capabilities.sessionResume, true);
  assert.equal(adapterDigest(parsed), reviewedDigest);
  assert.equal(raw.includes("--trust-all-tools"), false);
  assert.equal(raw.includes("--trust-tools"), false);
  assert.equal(raw.includes("KIRO_API_KEY"), false);
});

test("the shipped OpenCode adapter is declarative, direct-only, and schema-valid", async () => {
  const raw = await readFile(
    new URL("../provider-adapters/opencode-cli.json", import.meta.url),
    "utf8",
  );
  const parsed = parseProviderAdapterManifest(JSON.parse(raw));
  const reviewedDigest = (
    await readFile(new URL("../provider-adapters/opencode-cli.sha256", import.meta.url), "utf8")
  ).trim();
  assert.equal(parsed.id, "ai.opencode.cli");
  assert.deepEqual(parsed.executable, {
    names: ["opencode", "opencode.exe"],
    arguments: ["acp"],
  });
  assert.equal(parsed.capabilities.tools, true);
  assert.equal(parsed.capabilities.sessionResume, true);
  assert.equal(adapterDigest(parsed), reviewedDigest);
  assert.equal(raw.includes("--trust-all-tools"), false);
  assert.equal(raw.includes("--yolo"), false);
});

test("Kiro optional notifications are capability-isolated from core ACP events", () => {
  assert.equal(isOptionalKiroNotification("dev.kiro.cli", {
    jsonrpc: "2.0",
    method: "_kiro.dev/compaction/status",
    params: { status: "started" },
  }), true);
  assert.equal(isOptionalKiroNotification("dev.kiro.cli", {
    jsonrpc: "2.0",
    id: 7,
    method: "_kiro.dev/commands/options",
    params: {},
  }), false);
  assert.equal(isOptionalKiroNotification("dev.kiro.cli", {
    jsonrpc: "2.0",
    method: "unknown/extension",
    params: {},
  }), false);
  assert.equal(isOptionalKiroNotification("example.acp-agent", {
    jsonrpc: "2.0",
    method: "_kiro.dev/compaction/status",
    params: { status: "started" },
  }), false);
});

test("the shipped Grok Build adapter is declarative, direct-only, and schema-valid", async () => {
  const raw = await readFile(
    new URL("../provider-adapters/grok-build-cli.json", import.meta.url),
    "utf8",
  );
  const parsed = parseProviderAdapterManifest(JSON.parse(raw));
  const reviewedDigest = (
    await readFile(new URL("../provider-adapters/grok-build-cli.sha256", import.meta.url), "utf8")
  ).trim();
  assert.equal(parsed.id, "dev.xai.grok-build");
  assert.deepEqual(parsed.executable, {
    names: ["grok", "grok.exe"],
    arguments: ["agent", "stdio"],
  });
  assert.deepEqual(parsed.environment, [
    { name: "HOME", required: false, sensitive: true },
    { name: "USERPROFILE", required: false, sensitive: true },
    { name: "XDG_RUNTIME_DIR", required: false, sensitive: true },
  ]);
  assert.equal(parsed.capabilities.tools, true);
  assert.equal(parsed.capabilities.images, false);
  assert.equal(parsed.capabilities.sessionResume, true);
  assert.equal(adapterDigest(parsed), reviewedDigest);
  assert.equal(raw.includes("--always-approve"), false);
  assert.equal(raw.includes("XAI_API_KEY"), false);
  assert.equal(raw.includes("GROK_API_KEY"), false);
});

test("Grok optional notifications are capability-isolated from core ACP events", () => {
  assert.equal(isOptionalGrokNotification("dev.xai.grok-build", {
    jsonrpc: "2.0",
    method: "_x.ai/mcp/servers_updated",
    params: { mcpServers: [] },
  }), true);
  assert.equal(isOptionalGrokNotification("dev.xai.grok-build", {
    jsonrpc: "2.0",
    method: "_x.ai/session/prompt_complete",
    params: { sessionId: "s1" },
  }), true);
  assert.equal(isOptionalGrokNotification("dev.xai.grok-build", {
    jsonrpc: "2.0",
    id: 4,
    method: "_x.ai/mcp/servers_updated",
    params: {},
  }), false);
  assert.equal(isOptionalGrokNotification("dev.xai.grok-build", {
    jsonrpc: "2.0",
    method: "session/update",
    params: {},
  }), false);
  assert.equal(isOptionalGrokNotification("dev.kiro.cli", {
    jsonrpc: "2.0",
    method: "_x.ai/mcp/servers_updated",
    params: {},
  }), false);
});

test("ACP fs/read_text_file is worktree-bounded and supports line windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldunis-acp-fs-"));
  await writeFile(join(root, "pkg.json"), "line1\nline2\nline3\n", "utf8");
  const full = await acpReadTextFile(root, { path: join(root, "pkg.json") });
  assert.equal(full.content, "line1\nline2\nline3\n");
  const slice = await acpReadTextFile(root, { path: "pkg.json", line: 2, limit: 1 });
  assert.equal(slice.content, "line2");
  await assert.rejects(
    () => acpReadTextFile(root, { path: join(root, "..", "outside.txt") }),
    /escapes the conversation worktree|not readable/,
  );
});

test("Grok user message echoes normalize as informational without wire exposure", () => {
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "echoed prompt" },
      },
    },
  }), []);
  assert.deepEqual(normalizeAcpNotification({
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "pong" },
      },
    },
  }), [{ kind: "assistant_text", text: "pong" }]);
});

test("unreviewed positional launch arguments remain rejected outside Kiro and Grok", () => {
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      executable: { names: ["example-agent"], arguments: ["agent", "stdio"] },
    })),
    /option flags only/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      id: "dev.xai.grok-build",
      executable: { names: ["grok", "grok.exe"], arguments: ["agent", "serve"] },
    })),
    /option flags only/,
  );
  assert.throws(
    () => parseProviderAdapterManifest(manifest({
      id: "dev.xai.grok-build",
      executable: { names: ["grok", "grok.exe"], arguments: ["agent"] },
    })),
    /option flags only/,
  );
});

test("Kiro session notifications normalize without exposing the wire shape", () => {
  assert.deepEqual(normalizeAcpNotification({
    jsonrpc: "2.0",
    method: "session/notification",
    params: {
      sessionId: "kiro-session",
      update: {
        type: "AgentMessageChunk",
        content: { type: "text", text: "hello from Kiro" },
      },
    },
  }), [{ kind: "assistant_text", text: "hello from Kiro" }]);
  assert.deepEqual(normalizeAcpNotification({
    jsonrpc: "2.0",
    method: "session/notification",
    params: {
      sessionId: "kiro-session",
      update: { type: "TurnEnd" },
    },
  }), []);
  assert.throws(() => normalizeAcpNotification({
    jsonrpc: "2.0",
    method: "session/notification",
    params: {
      sessionId: "kiro-session",
      update: { type: "UnknownKiroUpdate" },
    },
  }), /malformed session update/);
});

test("Kiro prompts use the standard ACP prompt field exercised by the CLI", () => {
  assert.deepEqual(acpPromptRequest("session-1", "hello"), {
    method: "session/prompt",
    params: {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "hello" }],
    },
  });
});

test("ACP echoes opaque allow-once IDs and resumes only when both sides support it", () => {
  assert.equal(acpAllowOnceOption([
    { optionId: "deny-generated-7", kind: "reject_once" },
    { optionId: "permit-generated-8", kind: "allow_once" },
  ]), "permit-generated-8");
  assert.equal(acpAllowOnceOption([{ optionId: "always", kind: "allow_always" }]), null);
  assert.equal(acpSessionRequest("session-1", true, true, "/worktree").method, "session/load");
  assert.equal(acpSessionRequest("session-1", false, true, "/worktree"), null);
  assert.equal(acpSessionRequest("session-1", true, false, "/worktree"), null);
  assert.deepEqual(acpSessionRequest(undefined, false, false, "/worktree"), {
    method: "session/new",
    params: { cwd: "/worktree", mcpServers: [] },
  });
});
