# Getting started

## Requirements

- **Node.js 22** or newer
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

`npm start` builds the web and desktop entry points, then starts the local host.

### Development (UI + API split)

Keep both commands running in separate terminals:

```sh
# Terminal 1 — host
npm run host -- --port 4175

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

`npm run package:desktop` produces **local test artifacts only**.

## First conversation

1. Open a project (absolute path) via **Add project** / repository dialog.
2. Select a worktree in the sidebar.
3. Choose a provider (Claude profile, Codex, Shikigami, or an installed ACP
   adapter) and model as needed.
4. Send a prompt. Mutating tools pause for explicit approval in Build mode.

Provider credentials stay in each CLI’s own credential store. They are never
returned to the browser. See [providers.md](providers.md).

## Verify the tree

```sh
npm test
npm run check
npm run build
```

All three commands should exit successfully before you submit a change.

## Cross-product planes

The brand product switcher lists **Code**, **Sekai**, **Chisei**, and
**Tenkai**. Code is always available. The other planes stay visible but
**disabled** (“Not configured”) until an endpoint is set:

| Plane | Environment variable |
| --- | --- |
| Sekai | `ALDUNIS_SEKAI_ENDPOINT` |
| Chisei | `ALDUNIS_CHISEI_ENDPOINT` |
| Tenkai | `ALDUNIS_TENKAI_ENDPOINT` |

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
address (`127.0.0.1` or `[::1]`); the host rejects every insecure remote
endpoint before creating a client.

After opening Code on loopback, switch to Chisei and bind each local project to
its authorized namespace. Remote workbench clients cannot create or change
that binding. When remote access is enabled, browser binding administration is
disabled for both direct and proxied sessions because a loopback reverse proxy
is not proof of local authority; configure bindings before enabling remote
access. The browser never receives the endpoint or token.

## Remote access (optional)

Remote access is **off by default**. Recommended path: Tailscale Serve.

```sh
npm run host -- --remote tailscale
```

LAN mode requires a private bind address, public HTTPS origin, and TLS material:

```sh
npm run host -- --remote lan --host 192.168.1.20 \
  --public-url https://aldunis.home.example:4174 \
  --tls-cert /path/to/cert.pem \
  --tls-key /path/to/key.pem
```

The host prints a short-lived pairing URL. Manage sessions:

```sh
npm run host -- --remote-auth list
npm run host -- --remote-auth pair
npm run host -- --remote-auth revoke --session <session-id>
```

Details: [remote-workbench.md](remote-workbench.md).

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
