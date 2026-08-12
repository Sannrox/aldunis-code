# Command-line interface

Aldunis Code exposes one command surface for starting the local host and
managing authenticated remote sessions. The host remains loopback-only unless
remote mode is selected explicitly.

## Run locally

During development, run the TypeScript entry point through the `cli` script:

```sh
npm run cli -- --help
npm run cli -- start --port 4175
```

After `npm run build`, the bundled executable is available at
`dist-cli/aldunis-code.js`:

```sh
node dist-cli/aldunis-code.js --help
```

`npm start` builds the application and starts the bundled CLI. `serve` is an
explicit server-oriented alias for scripts and operators:

```sh
npm run cli -- serve --host 127.0.0.1 --port 4175
```

## Commands

| Command                              | Purpose                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `start`                              | Start the local Aldunis Code host; this is the default command. |
| `serve`                              | Start the host with explicit server-oriented intent.            |
| `auth pairing create`                | Issue a one-time remote pairing credential.                     |
| `auth pairing list`                  | List active remote sessions without exposing secrets.           |
| `auth pairing revoke --session <id>` | Revoke one remote session.                                      |

The auth group accepts the shorter aliases `auth pair`, `auth list`, and
`auth revoke`. `auth remote ...` is also accepted as a descriptive alias.

## Host options

```text
--host <address>            Bind address (default: 127.0.0.1)
--port <number>             Port (default: 4174; SSH remote default: 4177)
--remote <lan|tailscale|ssh> Enable authenticated remote access
--public-url <origin>       Certificate-matched HTTPS origin for LAN mode
--tls-cert <path>           PEM certificate for LAN mode
--tls-key <path>            PEM private key for LAN mode
```

LAN mode requires a private bind address, an HTTPS public origin, and both TLS
files. Each PEM file must be a regular file no larger than 1 MiB; symlink-mounted
secret files are accepted and pinned through their opened descriptor. Tailscale
mode keeps the host bound to loopback and configures Tailscale
Serve. SSH mode keeps the host bound to loopback, enables proof-key pairing over
an SSH local forward, and is intended for the desktop-managed environment
flow. SSH mode defaults to port 4177 so it does not collide with the Vite
development UI on 4174 or the split development host on 4175. These checks are
enforced by the host, not only by help text.

## Compatibility

The previous flag-only forms remain supported for existing scripts and managed
image deployments:

```sh
npm run host -- --port 4175
npm run host -- --remote tailscale
npm run host -- --remote-auth list
npm run host -- --remote-auth revoke --session <session-id>
```

New scripts should prefer the structured forms:

```sh
npm run cli -- serve --remote tailscale
npm run cli -- auth pairing list
npm run cli -- auth pairing revoke --session <session-id>
```

There is no general-purpose terminal command in this interface. Provider tools
still execute only through their adapter and the normal inspectable approval
flow.
