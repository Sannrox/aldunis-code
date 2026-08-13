import assert from "node:assert/strict";
import test from "node:test";
import {
  runTailscaleCommand,
  TAILSCALE_COMMAND_MAX_OUTPUT_BYTES,
  TAILSCALE_COMMAND_TIMEOUT_MS,
} from "./tailscale-command.ts";

test("tailscale commands use bounded runtime and output", async () => {
  let invocation: unknown[] | undefined;
  const stdout = await runTailscaleCommand(["serve", "status", "--json"], async (...args) => {
    invocation = args;
    return { stdout: '{"Web":{}}', stderr: "" } as never;
  });

  assert.equal(stdout, '{"Web":{}}');
  assert.deepEqual(invocation, [
    "tailscale",
    ["serve", "status", "--json"],
    {
      encoding: "utf8",
      timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
      maxBuffer: TAILSCALE_COMMAND_MAX_OUTPUT_BYTES,
    },
  ]);
});
