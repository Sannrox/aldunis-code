import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getChangedFiles, listTrackedFiles } from "./changed-files.ts";

type ToolName = "eslint" | "prettier";

const extensions: Record<ToolName, Set<string>> = {
  eslint: new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]),
  prettier: new Set([
    ".cjs",
    ".css",
    ".html",
    ".js",
    ".json",
    ".mjs",
    ".md",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
  ]),
};

export function selectToolFiles(tool: ToolName, files: string[], cwd = process.cwd()): string[] {
  const allowed = extensions[tool];
  return files
    .filter((file) => allowed.has(file.slice(file.lastIndexOf("."))))
    .filter((file) => existsSync(resolve(cwd, file)))
    .sort();
}

function npmTool(tool: ToolName): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return join(process.cwd(), "node_modules", ".bin", `${tool}${suffix}`);
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn(command, args, {
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

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const tool = args.find((arg): arg is ToolName => arg === "eslint" || arg === "prettier");
  if (!tool)
    throw new Error(
      "Usage: tsx scripts/check-changed.ts <eslint|prettier> [--all] [--base <revision>]",
    );

  const cwd = process.cwd();
  const all = args.includes("--all");
  const base = argumentValue(args, "--base");
  const discovered = all ? listTrackedFiles(cwd) : getChangedFiles({ base, cwd });
  const files = selectToolFiles(tool, discovered, cwd);
  const startedAt = Date.now();

  if (files.length === 0) {
    console.log(
      JSON.stringify(
        {
          tool,
          status: "skipped",
          reason: all ? "No supported files found." : "No changed supported files found.",
          files: [],
          durationMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
    return;
  }

  const commandArgs = tool === "eslint" ? ["--max-warnings=0", ...files] : ["--check", ...files];
  const exitCode = await run(npmTool(tool), commandArgs);
  console.log(
    JSON.stringify(
      {
        tool,
        status: exitCode === 0 ? "passed" : "failed",
        files,
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
