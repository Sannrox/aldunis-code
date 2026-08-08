import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBaseRevision } from "./changed-files.ts";

interface CheckResult {
  command: string[];
  output: string;
}

function runGitCheck(args: string[]): CheckResult | undefined {
  const result = spawnSync("git", ["diff", "--check", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || output.trim().length === 0) return undefined;
  return { command: ["git", "diff", "--check", ...args], output };
}

export function checkWhitespace(): CheckResult[] {
  const base = resolveBaseRevision();
  const checks: CheckResult[] = [];

  if (base) {
    const committed = runGitCheck([`${base}...HEAD`]);
    if (committed) checks.push(committed);
  }

  const workingTree = runGitCheck([]);
  if (workingTree) checks.push(workingTree);

  const index = runGitCheck(["--cached"]);
  if (index) checks.push(index);

  return checks;
}

export function main(): void {
  const failures = checkWhitespace();
  console.log(
    JSON.stringify(
      {
        status: failures.length === 0 ? "passed" : "failed",
        checks: failures,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) process.exitCode = 1;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) main();
