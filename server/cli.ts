export type HostCommand = "start" | "serve";
export type AuthPairingAction = "create" | "list" | "revoke";

export interface HostCommandOptions {
  host?: string;
  port?: string;
  remote?: "lan" | "tailscale";
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
}

export type CliHelpScope = "root" | "start" | "serve" | "auth" | "pairing";

export type CliInvocation =
  | { kind: "run"; command: HostCommand; options: HostCommandOptions }
  | { kind: "auth"; action: AuthPairingAction; session?: string }
  | { kind: "help"; scope: CliHelpScope }
  | { kind: "version" };

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

type OptionName = keyof HostCommandOptions;

const HOST_OPTION_NAMES: Record<string, OptionName> = {
  "--host": "host",
  "--port": "port",
  "--remote": "remote",
  "--public-url": "publicUrl",
  "--tls-cert": "tlsCert",
  "--tls-key": "tlsKey",
};

const AUTH_ACTIONS: Record<string, AuthPairingAction> = {
  create: "create",
  pair: "create",
  list: "list",
  revoke: "revoke",
};

function usageError(message: string): never {
  throw new CliUsageError(message);
}

function optionParts(token: string): { name: string; inlineValue: string | undefined } {
  const separator = token.indexOf("=");
  if (separator < 0) return { name: token, inlineValue: undefined };
  return {
    name: token.slice(0, separator),
    inlineValue: token.slice(separator + 1),
  };
}

function requiredValue(
  args: readonly string[],
  index: number,
  name: string,
  inlineValue: string | undefined,
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    if (!inlineValue) usageError(`${name} requires a value.`);
    return { value: inlineValue, nextIndex: index + 1 };
  }
  const value = args[index + 1];
  if (value === undefined) usageError(`${name} requires a value.`);
  return { value, nextIndex: index + 2 };
}

function parseHostOptions(
  args: readonly string[],
  command: HostCommand,
  startIndex = 0,
): CliInvocation {
  const options: HostCommandOptions = {};
  let index = startIndex;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "-h" || token === "--help") {
      return { kind: "help", scope: command };
    }
    if (token === "-v" || token === "--version") {
      return { kind: "version" };
    }
    if (!token.startsWith("-")) {
      usageError(`Unexpected argument: ${token}`);
    }
    const { name, inlineValue } = optionParts(token);
    const option = HOST_OPTION_NAMES[name];
    if (!option) {
      usageError(`Unknown option: ${token}`);
    }
    const parsed = requiredValue(args, index, name, inlineValue);
    if (option === "remote" && parsed.value !== "lan" && parsed.value !== "tailscale") {
      usageError(`--remote must be either 'lan' or 'tailscale', not '${parsed.value}'.`);
    }
    if (option === "remote") {
      options.remote = parsed.value as HostCommandOptions["remote"];
    } else {
      options[option] = parsed.value;
    }
    index = parsed.nextIndex;
  }
  return { kind: "run", command, options };
}

function parseAuthAction(value: string): AuthPairingAction {
  const action = AUTH_ACTIONS[value.toLocaleLowerCase()];
  if (action) return action;
  usageError(`Unknown auth pairing action: ${value}`);
}

function parseAuth(args: readonly string[]): CliInvocation {
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { kind: "help", scope: "auth" };
  }

  let index = 0;
  const group = args[index];
  if (group === "pairing" || group === "remote") index += 1;
  if (index >= args.length || args[index] === "-h" || args[index] === "--help") {
    return { kind: "help", scope: "pairing" };
  }

  const action = parseAuthAction(args[index]!);
  index += 1;
  let session: string | undefined;
  while (index < args.length) {
    const token = args[index]!;
    if (token === "-h" || token === "--help") return { kind: "help", scope: "pairing" };
    const { name, inlineValue } = optionParts(token);
    if (name !== "--session") usageError(`Unknown auth option: ${token}`);
    const parsed = requiredValue(args, index, name, inlineValue);
    session = parsed.value;
    index = parsed.nextIndex;
  }
  if (action !== "revoke" && session !== undefined) {
    usageError("--session is only valid for auth pairing revoke.");
  }
  if (action === "revoke" && !session) {
    usageError("auth pairing revoke requires --session <id>.");
  }
  return { kind: "auth", action, ...(session ? { session } : {}) };
}

function parseLegacyRemoteAuth(args: readonly string[]): CliInvocation {
  let index = 0;
  let actionValue: string | undefined;
  let session: string | undefined;
  while (index < args.length) {
    const current = args[index]!;
    const { name, inlineValue: currentInlineValue } = optionParts(current);
    if (name === "--remote-auth") {
      if (actionValue !== undefined) usageError("--remote-auth may only be provided once.");
      const actionValueResult = requiredValue(args, index, name, currentInlineValue);
      actionValue = actionValueResult.value;
      index = actionValueResult.nextIndex;
      continue;
    }
    if (name === "--session") {
      if (session !== undefined) usageError("--session may only be provided once.");
      const sessionValue = requiredValue(args, index, name, currentInlineValue);
      session = sessionValue.value;
      index = sessionValue.nextIndex;
      continue;
    }
    if (HOST_OPTION_NAMES[name]) {
      index = requiredValue(args, index, name, currentInlineValue).nextIndex;
      continue;
    }
    usageError(`Unknown option: ${current}`);
  }
  if (actionValue === undefined) usageError("--remote-auth requires an action.");
  const action = parseAuthAction(actionValue);
  if (action !== "revoke" && session !== undefined) {
    usageError("--session is only valid when revoking a remote session.");
  }
  if (action === "revoke" && !session) {
    usageError("--remote-auth revoke requires --session <id>.");
  }
  return { kind: "auth", action, ...(session ? { session } : {}) };
}

/** Parse the public Aldunis Code command surface without starting the host. */
export function parseCliArgs(args: readonly string[]): CliInvocation {
  if (args.length === 0) {
    return { kind: "run", command: "start", options: {} };
  }

  const legacyAuthIndex = args.findIndex((token) => {
    const { name } = optionParts(token);
    return name === "--remote-auth";
  });
  if (legacyAuthIndex >= 0) {
    return parseLegacyRemoteAuth(args);
  }

  const first = args[0]!;
  if (first === "-h" || first === "--help") return { kind: "help", scope: "root" };
  if (first === "-v" || first === "--version") return { kind: "version" };
  if (first === "auth") return parseAuth(args.slice(1));
  if (first === "start" || first === "serve") {
    return parseHostOptions(args, first, 1);
  }
  if (first.startsWith("-")) {
    return parseHostOptions(args, "start");
  }
  usageError(`Unknown command: ${first}`);
}

export function formatCliHelp(scope: CliHelpScope = "root"): string {
  if (scope === "auth") {
    return `Aldunis Code authentication commands

Usage:
  aldunis-code auth pairing <create|list|revoke> [options]

Commands:
  pairing create                 Issue a one-time remote pairing credential.
  pairing list                   List active remote sessions without secrets.
  pairing revoke --session <id>  Revoke one remote session.

Aliases:
  auth pair|list|revoke
  auth remote pair|list|revoke

Options:
  -h, --help                    Show this help.
`;
  }

  if (scope === "pairing") {
    return `Aldunis Code pairing commands

Usage:
  aldunis-code auth pairing <create|list|revoke> [options]

Use \`aldunis-code auth --help\` for the full authentication command reference.
`;
  }

  return `Aldunis Code — local-first agentic development workbench

Usage:
  aldunis-code [start] [options]
  aldunis-code serve [options]
  aldunis-code auth pairing <create|list|revoke> [options]

Commands:
  start                         Start the local Aldunis Code host.
  serve                         Run the host with server-oriented intent.
  auth pairing create           Issue a one-time remote pairing credential.
  auth pairing list             List active remote sessions without secrets.
  auth pairing revoke           Revoke a remote session.

Host options:
  --host <address>              Bind address (default: 127.0.0.1).
  --port <number>               Port (default: 4174).
  --remote <lan|tailscale>      Enable authenticated remote access.
  --public-url <https-origin>   Certificate-matched LAN origin.
  --tls-cert <path>             PEM certificate for LAN mode.
  --tls-key <path>              PEM private key for LAN mode.
  -h, --help                    Show this help.
  -v, --version                 Show the installed version.

Compatibility:
  --remote-auth pair|list|revoke
  npm run host -- --remote-auth list
`;
}
