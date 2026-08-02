import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CliUsageError,
  formatCliHelp,
  parseCliArgs,
} from "./cli.ts";

test("the root command defaults to start and accepts host flags", () => {
  assert.deepEqual(parseCliArgs(["--host", "127.0.0.1", "--port=4175"]), {
    kind: "run",
    command: "start",
    options: { host: "127.0.0.1", port: "4175" },
  });
  assert.deepEqual(parseCliArgs(["serve", "--remote", "tailscale"]), {
    kind: "run",
    command: "serve",
    options: { remote: "tailscale" },
  });
});

test("auth pairing commands have T3-style nested routing and aliases", () => {
  assert.deepEqual(parseCliArgs(["auth", "pairing", "create"]), {
    kind: "auth",
    action: "create",
  });
  assert.deepEqual(parseCliArgs(["auth", "remote", "list"]), {
    kind: "auth",
    action: "list",
  });
  assert.deepEqual(parseCliArgs(["auth", "revoke", "--session=session-1"]), {
    kind: "auth",
    action: "revoke",
    session: "session-1",
  });
});

test("the CLI build emits provider approval helpers beside the host bundle", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts?: { "build:cli"?: string };
  };
  const command = packageJson.scripts?.["build:cli"] ?? "";

  assert.match(command, /esbuild server\/permission-mcp\.mjs/);
  assert.match(command, /--outfile=dist-cli\/permission-mcp\.mjs/);
  assert.match(command, /esbuild server\/shikigami-permission-hook\.mjs/);
  assert.match(command, /--outfile=dist-cli\/shikigami-permission-hook\.mjs/);
});

test("legacy remote-auth flags remain compatible", () => {
  assert.deepEqual(parseCliArgs(["--remote-auth", "pair"]), {
    kind: "auth",
    action: "create",
  });
  assert.deepEqual(parseCliArgs(["--remote-auth=revoke", "--session", "session-1"]), {
    kind: "auth",
    action: "revoke",
    session: "session-1",
  });
  assert.deepEqual(parseCliArgs(["--session", "session-1", "--remote-auth", "revoke"]), {
    kind: "auth",
    action: "revoke",
    session: "session-1",
  });
});

test("help and version requests are routed without starting the host", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { kind: "help", scope: "root" });
  assert.deepEqual(parseCliArgs(["start", "--help"]), { kind: "help", scope: "start" });
  assert.deepEqual(parseCliArgs(["auth", "--help"]), { kind: "help", scope: "auth" });
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "version" });
  assert.match(formatCliHelp(), /auth pairing <create\|list\|revoke>/);
  assert.match(formatCliHelp("auth"), /one-time remote pairing credential/);
});

test("invalid commands and missing values fail with actionable usage errors", () => {
  assert.throws(
    () => parseCliArgs(["--wat"]),
    (error: unknown) => error instanceof CliUsageError && /Unknown option/.test(error.message),
  );
  assert.throws(
    () => parseCliArgs(["--port"]),
    (error: unknown) => error instanceof CliUsageError && /requires a value/.test(error.message),
  );
  assert.throws(
    () => parseCliArgs(["auth", "pairing", "revoke"]),
    (error: unknown) => error instanceof CliUsageError && /--session/.test(error.message),
  );
  assert.throws(
    () => parseCliArgs(["serve", "--remote", "public"]),
    (error: unknown) => error instanceof CliUsageError && /lan.*tailscale/.test(error.message),
  );
});
