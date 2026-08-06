import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const LAUNCHCTL_TIMEOUT_MS = 2_000;
const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;

const POSIX_ENVIRONMENT_NAMES = [
  "PATH",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
] as const;

const WINDOWS_ENVIRONMENT_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const SHELL_PREFERRED_ENVIRONMENT_NAMES = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
]);

type EnvironmentPatch = Record<string, string>;

export interface ShellEnvironmentCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type ShellEnvironmentCommand = (
  command: string,
  args: readonly string[],
  options: ShellEnvironmentCommandOptions,
) => Promise<{ stdout: string }>;

export interface HydrateDesktopEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: ShellEnvironmentCommand;
}

const startMarker = (name: string): string => `__ALDUNIS_ENV_${name}_START__`;
const endMarker = (name: string): string => `__ALDUNIS_ENV_${name}_END__`;

function capturePosixEnvironmentCommand(names: readonly string[]): string {
  return names
    .map((name) => [
      `printf '%s\\n' '${startMarker(name)}'`,
      `printenv ${name} || true`,
      `printf '%s\\n' '${endMarker(name)}'`,
    ].join("; "))
    .join("; ");
}

function captureWindowsEnvironmentCommand(names: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => [
      `Write-Output '${startMarker(name)}'`,
      `$value = [Environment]::GetEnvironmentVariable('${name}')`,
      "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
      `Write-Output '${endMarker(name)}'`,
    ]),
  ].join("; ");
}

/** Parse only the explicitly allowlisted values emitted by a login shell. */
export function parseShellEnvironment(
  output: string,
  names: readonly string[],
): EnvironmentPatch {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));
    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);
    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (value.length > 0) environment[name] = value;
  }

  return environment;
}

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function pathComparisonKey(entry: string, platform: NodeJS.Platform): string {
  const normalized = entry.trim().replace(/^"+|"+$/g, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Merge PATH values with the shell-provided entries taking precedence. */
export function mergeEnvironmentPaths(
  platform: NodeJS.Platform,
  values: readonly (string | undefined)[],
): string | null {
  const entries: string[] = [];
  const seen = new Set<string>();
  const delimiter = pathDelimiter(platform);

  for (const value of values) {
    if (!value) continue;
    for (const entry of value.split(delimiter)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const key = pathComparisonKey(trimmed, platform);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(trimmed);
    }
  }

  return entries.length > 0 ? entries.join(delimiter) : null;
}

function inheritedPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function loginShellCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const fallback = platform === "darwin"
    ? "/bin/zsh"
    : platform === "linux"
      ? "/bin/bash"
      : null;
  const candidates = [env.SHELL?.trim(), fallback].filter(
    (value): value is string => Boolean(value),
  );
  return [...new Set(candidates)];
}

function knownWindowsCliDirectories(env: NodeJS.ProcessEnv): string[] {
  const directories: string[] = [];
  if (env.APPDATA) directories.push(`${env.APPDATA}\\npm`);
  if (env.LOCALAPPDATA) {
    directories.push(
      `${env.LOCALAPPDATA}\\Programs\\nodejs`,
      `${env.LOCALAPPDATA}\\Volta\\bin`,
      `${env.LOCALAPPDATA}\\pnpm`,
    );
  }
  if (env.USERPROFILE) {
    directories.push(
      `${env.USERPROFILE}\\.bun\\bin`,
      `${env.USERPROFILE}\\scoop\\shims`,
    );
  }
  return directories;
}

const defaultRunCommand: ShellEnvironmentCommand = async (command, args, options) => {
  const result = await execFileAsync(command, [...args], {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: MAX_SHELL_OUTPUT_BYTES,
    encoding: "utf8",
  });
  return { stdout: result.stdout };
};

async function readPosixShellEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  runCommand: ShellEnvironmentCommand,
): Promise<EnvironmentPatch> {
  const environment: EnvironmentPatch = {};
  const command = capturePosixEnvironmentCommand(POSIX_ENVIRONMENT_NAMES);

  for (const shell of loginShellCandidates(env, platform)) {
    try {
      const result = await runCommand(shell, ["-ilc", command], {
        env,
        timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      });
      Object.assign(environment, parseShellEnvironment(result.stdout, POSIX_ENVIRONMENT_NAMES));
      if (environment.PATH) break;
    } catch {
      // Try the platform fallback shell, then launchctl on macOS.
    }
  }

  if (platform === "darwin" && !environment.PATH) {
    try {
      const result = await runCommand("/bin/launchctl", ["getenv", "PATH"], {
        env,
        timeoutMs: LAUNCHCTL_TIMEOUT_MS,
      });
      const path = result.stdout.trim();
      if (path) environment.PATH = path;
    } catch {
      // The inherited environment remains the safe fallback.
    }
  }

  return environment;
}

async function readWindowsShellEnvironment(
  env: NodeJS.ProcessEnv,
  runCommand: ShellEnvironmentCommand,
): Promise<EnvironmentPatch> {
  const command = captureWindowsEnvironmentCommand(WINDOWS_ENVIRONMENT_NAMES);

  for (const shell of WINDOWS_SHELL_CANDIDATES) {
    try {
      const result = await runCommand(
        shell,
        ["-NoLogo", "-NonInteractive", "-Command", command],
        { env, timeoutMs: LOGIN_SHELL_TIMEOUT_MS },
      );
      const environment = parseShellEnvironment(result.stdout, WINDOWS_ENVIRONMENT_NAMES);
      if (environment.PATH) return environment;
    } catch {
      // Try the next installed PowerShell host.
    }
  }

  return {};
}

function applyEnvironmentPatch(
  env: NodeJS.ProcessEnv,
  patch: EnvironmentPatch,
  platform: NodeJS.Platform,
): void {
  const supplementalWindowsPath = platform === "win32"
    ? knownWindowsCliDirectories(env).join(";")
    : undefined;
  const mergedPath = mergeEnvironmentPaths(platform, [
    patch.PATH,
    supplementalWindowsPath,
    inheritedPath(env),
  ]);
  if (mergedPath) env.PATH = mergedPath;

  for (const [name, value] of Object.entries(patch)) {
    if (name === "PATH") continue;
    if (name === "SSH_AUTH_SOCK" && env[name]) continue;

    if (SHELL_PREFERRED_ENVIRONMENT_NAMES.has(name) || !env[name]) env[name] = value;
  }
}

/**
 * Electron-launched apps do not reliably inherit the user's login-shell PATH.
 * Hydrate only bounded, non-secret process settings before starting the local
 * host so all provider probes and subprocesses see the same environment.
 */
export async function hydrateDesktopProcessEnvironment(
  options: HydrateDesktopEnvironmentOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const patch = platform === "win32"
    ? await readWindowsShellEnvironment(env, runCommand)
    : await readPosixShellEnvironment(env, platform, runCommand);

  applyEnvironmentPatch(env, patch, platform);
}
