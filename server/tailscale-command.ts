import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TAILSCALE_COMMAND_TIMEOUT_MS = 10_000;
export const TAILSCALE_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;

export type TailscaleCommandRunner = typeof execFileAsync;

/** Run one Tailscale lifecycle command within fixed time and output budgets. */
export async function runTailscaleCommand(
  arguments_: string[],
  run: TailscaleCommandRunner = execFileAsync,
): Promise<string> {
  const result = await run("tailscale", arguments_, {
    encoding: "utf8",
    timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
    maxBuffer: TAILSCALE_COMMAND_MAX_OUTPUT_BYTES,
  });
  return result.stdout;
}
