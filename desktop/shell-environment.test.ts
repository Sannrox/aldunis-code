import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  hydrateDesktopProcessEnvironment,
  mergeEnvironmentPaths,
  parseShellEnvironment,
} from "./shell-environment.ts";

function markedEnvironment(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => [
      `__ALDUNIS_ENV_${name}_START__`,
      value,
      `__ALDUNIS_ENV_${name}_END__`,
    ].join("\n"))
    .join("\n");
}

test("shell environment parsing ignores noise and unmarked values", () => {
  const parsed = parseShellEnvironment(
    `startup warning\n${markedEnvironment({ PATH: "/opt/bin:/usr/bin", HOME: "/not-read" })}\ntrailing output`,
    ["PATH", "SSH_AUTH_SOCK"],
  );

  assert.deepEqual(parsed, { PATH: "/opt/bin:/usr/bin" });
});

test("shell PATH entries take precedence and are de-duplicated", () => {
  assert.equal(
    mergeEnvironmentPaths("darwin", ["/opt/bin:/usr/bin", "/usr/local/bin:/usr/bin"]),
    "/opt/bin:/usr/bin:/usr/local/bin",
  );
  assert.equal(
    mergeEnvironmentPaths("win32", ["C:\\Tools;C:\\Windows", "c:\\tools;C:\\Other"]),
    "C:\\Tools;C:\\Windows;C:\\Other",
  );
});

test("desktop startup hydrates POSIX provider PATH before backend creation", async () => {
  const env: NodeJS.ProcessEnv = {
    SHELL: "/bin/zsh",
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "/tmp/inherited.sock",
  };
  const commands: string[] = [];

  await hydrateDesktopProcessEnvironment({
    env,
    platform: "darwin",
    runCommand: async (command) => {
      commands.push(command);
      return {
        stdout: markedEnvironment({
          PATH: "/tmp/test/.local/bin:/usr/bin",
          SSH_AUTH_SOCK: "/tmp/login-shell.sock",
          HOMEBREW_PREFIX: "/opt/homebrew",
        }),
      };
    },
  });

  assert.deepEqual(commands, ["/bin/zsh"]);
  assert.equal(env.PATH, "/tmp/test/.local/bin:/usr/bin");
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/inherited.sock");
  assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
});

test("macOS falls back to launchctl when login shell probing yields no PATH", async () => {
  const env: NodeJS.ProcessEnv = {
    SHELL: "/opt/unknown-shell",
    PATH: "/usr/bin",
  };
  const commands: string[] = [];

  await hydrateDesktopProcessEnvironment({
    env,
    platform: "darwin",
    runCommand: async (command) => {
      commands.push(command);
      if (command === "/bin/launchctl") return { stdout: "/opt/homebrew/bin:/usr/bin\n" };
      throw new Error("shell unavailable");
    },
  });

  assert.deepEqual(commands, ["/opt/unknown-shell", "/bin/zsh", "/bin/launchctl"]);
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
});

test("Windows desktop startup merges PowerShell and known CLI directories", async () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    USERPROFILE: "C:\\Users\\test",
  };

  await hydrateDesktopProcessEnvironment({
    env,
    platform: "win32",
    runCommand: async () => ({
      stdout: markedEnvironment({ PATH: "C:\\Profile\\Node;C:\\Windows\\System32" }),
    }),
  });

  assert.equal(
    env.PATH,
    [
      "C:\\Profile\\Node",
      "C:\\Windows\\System32",
      "C:\\Users\\test\\AppData\\Roaming\\npm",
      "C:\\Users\\test\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\test\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\test\\AppData\\Local\\pnpm",
      "C:\\Users\\test\\.bun\\bin",
      "C:\\Users\\test\\scoop\\shims",
    ].join(";"),
  );
});

test("desktop main installs the shell environment before creating the local host", async () => {
  const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ hydrateDesktopProcessEnvironment \} from "\.\/shell-environment\.ts"/);
  assert.match(source, /await hydrateDesktopProcessEnvironment\(\);[\s\S]*process\.env\.ALDUNIS_CODE_STATE_DIR/);
});
