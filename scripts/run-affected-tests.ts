import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getChangedFiles } from "./changed-files.ts";

export interface TestPlan {
  reason: string;
  requiredTiers: string[];
}

const applicationPatterns = [
  /^(server|desktop|src)\//,
  /^(contracts|provider-adapters)\//,
  /^scripts\/.*\.(cjs|js|mjs|ts)$/,
  /^(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/,
];

export function selectTestPlan(files: string[]): TestPlan {
  if (files.length === 0) {
    return {
      requiredTiers: ["unit"],
      reason: "No changed files were found; run the unit suite as a safety fallback.",
    };
  }

  if (files.some((file) => applicationPatterns.some((pattern) => pattern.test(file)))) {
    return {
      requiredTiers: ["unit"],
      reason: "Application, test, build, or dependency files changed.",
    };
  }

  return {
    requiredTiers: [],
    reason: "Only documentation or non-runtime files changed.",
  };
}

function runUnitTests(): Promise<number> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolveExit) => {
    const child = spawn(command, ["test"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExit(1);
    });
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const base = argumentValue(args, "--base");
  const files = getChangedFiles({ base, cwd: process.cwd() });
  const plan = hasFlag(args, "--all")
    ? { requiredTiers: ["unit"], reason: "All tests explicitly requested." }
    : selectTestPlan(files);
  const startedAt = Date.now();

  if (plan.requiredTiers.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: "skipped",
          changedFiles: files,
          requiredTiers: plan.requiredTiers,
          ranTiers: [],
          reason: plan.reason,
          durationMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hasFlag(args, "--dry-run")) {
    console.log(
      JSON.stringify(
        {
          status: "dry-run",
          changedFiles: files,
          requiredTiers: plan.requiredTiers,
          ranTiers: [],
          reason: plan.reason,
          durationMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  const exitCode = await runUnitTests();
  console.log(
    JSON.stringify(
      {
        status: exitCode === 0 ? "passed" : "failed",
        changedFiles: files,
        requiredTiers: plan.requiredTiers,
        ranTiers: exitCode === 0 ? plan.requiredTiers : [],
        reason: plan.reason,
        durationMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) await main();
