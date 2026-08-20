# Getting started

## Requirements

- **Node.js 22.12** or newer
- **npm** (included with Node.js)
- **Git**
- A local Git repository to open
- Optional: provider CLIs on `PATH` (Claude Code, Codex, Shikigami, `kiro-cli`,
  `grok`, `opencode`) depending on which providers you use

## Install and run

```sh
npm ci
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174).

The host binds **loopback only** by default and refuses non-loopback addresses
unless you enable remote mode (below).

`npm start` builds the web, desktop, and CLI entry points, then starts the local host.
The structured host command surface is documented in [CLI reference](cli.md).

### Development (UI + API split)

Keep both commands running in separate terminals:

```sh
# Terminal 1 — host
npm run cli -- serve --port 4175

# Terminal 2 — Vite
npm run dev
```

Vite serves the UI on `127.0.0.1:4174` and talks to the host on `4175`.

### Desktop shell

```sh
npm run desktop
```

The desktop shell waits for an ephemeral loopback host, enforces one instance,
and gives the renderer no ambient Node or filesystem authority. Packaging and
signing expectations are in [desktop-distribution.md](desktop-distribution.md).

`npm run package:desktop` produces **local test artifacts only** in `release/`.
It does not force Developer ID or Authenticode signing and never supplies
public release evidence.

## First conversation

1. Open a project (absolute path) via **Add project** / repository dialog.
2. Select a worktree in the sidebar.
3. Choose a provider (Claude profile, Codex, Shikigami, or an installed ACP
   adapter) and model as needed.
4. Send a prompt. Mutating tools pause for explicit approval in Build mode.

Provider credentials stay in each CLI’s own credential store. They are never
returned to the browser. See [providers.md](providers.md).

Local Code has no Aldunis account login. The local OS user, the loopback host,
and each provider's own credential store form the local boundary. An account
panel appears only when the host is running in enterprise-managed mode.

## Verify the tree

```sh
make validate
make test
make test-integration
make all
```

All four commands should exit successfully before you submit a change.

## Cross-product planes

The brand product switcher lists **Code**, **Sekai**, **Chisei**, and
**Tenkai**. Code is always available. The other planes stay visible but
**disabled** (“Not configured”) until an endpoint is set:

| Plane  | Environment variable                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| Sekai  | `ALDUNIS_SEKAI_ENDPOINT`                                                             |
| Chisei | `ALDUNIS_CHISEI_ENDPOINT`, or hosted `ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT` |
| Tenkai | `ALDUNIS_TENKAI_ENDPOINT`                                                            |

Non-empty values enable selection. The host reports availability via
`POST /api/products/availability`. Cross-product screens must consume
authenticated product contracts; they must not treat cached UI as domain
authority. Governed agent harness work is expected to use **Shikigami** with
Chisei as the policy plane—see architecture and product-boundary discussions.

For authenticated Chisei projections, set the optional bearer token only in
the host environment:

```sh
export ALDUNIS_CHISEI_ENDPOINT=http://127.0.0.1:50051
export ALDUNIS_CHISEI_TOKEN=…
```

Chisei connections require HTTPS unless the endpoint is a literal loopback
address (`127.0.0.1` or `[::1]`) or the host sets `SEKAI_ALLOW_PLAINTEXT=1`
for an in-cluster official Chisei. The host rejects every other insecure
remote endpoint before creating a client. When `ALDUNIS_CHISEI_TOKEN` is
unset, the host reuses `SEKAI_TOKEN`.

After opening Code on loopback, switch to Chisei and bind each local project to
its authorized namespace. Remote workbench clients cannot create or change
that binding. When remote access is enabled, browser binding administration is
disabled for both direct and proxied sessions because a loopback reverse proxy
is not proof of local authority; configure bindings before enabling remote
access. The browser never receives the endpoint or token.

The Tenkai screen also contains the loopback-only candidate-to-local-release
workflow. It requires `ALDUNIS_TENKAI_DATABASE` plus authenticated Chisei
configuration and compatible `sekaictl` / `tenkaictl` binaries. See
[local delivery](local-delivery.md) for its deliberately narrow version 1
profile and recovery behavior.

## Remote access (optional)

Remote access is **off by default**. Recommended path: Tailscale Serve.

```sh
npm run cli -- serve --remote tailscale
```

LAN mode requires a private bind address, public HTTPS origin, and TLS material:

```sh
npm run cli -- serve --remote lan --host 192.168.1.20 \
  --public-url https://aldunis.home.example:4174 \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem
```

The certificate and private-key PEM files must each be regular files no larger
than 1 MiB. Symlink-mounted secret files remain supported.

For a quick private-WLAN setup, use the repository helper. It detects the
WLAN address, builds the web UI, generates a temporary certificate with
`mkcert` when no certificate is supplied, and starts the same authenticated LAN
mode. Install `mkcert` for the zero-argument path, or pass certificate files
explicitly:

```sh
npm run wlan
```

Pass certificate files when using a certificate trusted by the client device:

```sh
npm run wlan -- \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem
```

Use `--no-build` for subsequent runs when the existing web build is current.
The helper never writes certificates or private keys into the repository. The
client must trust the certificate authority, and the host prints a one-time
pairing URL to open on the WLAN device.

The host prints a short-lived pairing URL. Manage sessions:

```sh
npm run cli -- auth pairing list
npm run cli -- auth pairing create
npm run cli -- auth pairing revoke --session <session-id>
```

The older `npm run host -- --remote-auth ...` forms remain available for
existing scripts.

### Desktop remote workbenches

In the Electron desktop, open **Settings → Access → Connections**. The
**Remote workbenches** section supports:

- **SSH launch / local forward** — enter an SSH alias or `user@host`. The
  desktop starts `aldunis-code serve --remote ssh` on the remote host, forwards
  a local ephemeral port to the remote loopback backend, and pairs the desktop
  with a one-time device grant.
- **Existing HTTPS endpoint** — enter the backend origin and its one-time
  pairing URL. HTTPS is required for non-loopback endpoints.

Saved records contain no SSH private keys, provider credentials, or pairing
credentials. The remote host remains authoritative for repositories,
worktrees, provider processes, and conversations. Use **Use local host** to
return to the desktop's loopback backend.

The desktop-managed SSH backend defaults to remote port **4177**, leaving the
development UI on **4174** and the split development host on **4175**. The
desktop chooses and remembers a preferred local forwarding port. For
comparison, T3 Code's remote guide uses backend port **3773**; that port is only
relevant to T3 Code and does not make a remote host an Aldunis backend.

Details: [remote-workbench.md](remote-workbench.md).

## Enterprise-managed mode (operator deployment)

Enterprise mode is started explicitly with `ALDUNIS_HOST_MODE=managed` behind
the configured gateway. The gateway authenticates the browser through the
enterprise identity provider and forwards short-lived signed Code assertions;
Code verifies those assertions and shows the resulting account, tenant,
roles/scopes, and expiry in the managed sidebar. Code does not receive a
password or provider credential and does not allow the browser to choose a
tenant.

Set `ALDUNIS_MANAGED_LOGOUT_URL` to the gateway's HTTPS sign-out URL if the
managed account panel should include a direct **Sign out** link. The value is
optional and is rejected if it contains credentials or a URL fragment.

The enterprise gateway must provide the managed assertion configuration and
repository/provider settings described in the [managed hosted workbench
decision](decisions/managed-hosted-workbench.md). Managed mode is single-tenant
and does not fall back to local or paired-remote authentication.

## Repository and worktree notes

- The host resolves symlinks and finds the canonical Git root.
- Browser code never receives a raw filesystem handle.
- Missing or inaccessible worktrees are reported; the app does not silently
  repair or delete them.
- Conversation worktrees are managed under a preview-and-approve boundary
  ([managed conversation worktrees](decisions/managed-conversation-worktrees.md)).

## Next reading

- [Providers](providers.md) — install and trust model for each CLI
- [Automations](automations.md) — scheduled prompts
- [Local data](local-data.md) — where state lives
- [Architecture](architecture.md) — security invariants
