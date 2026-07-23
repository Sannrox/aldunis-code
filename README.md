# Aldunis Code

Aldunis Code is a local-first agentic development workbench. It gives
developers one focused interface for repositories, worktrees, conversations,
approvals, and diffs, with Claude Code as the first provider.

The application is an independent implementation. It does not copy T3 Code
source, assets, or product identity. General workflow research may inform the
product, but every shipped interface and implementation is owned here.

## Product boundaries

- **Aldunis Code** owns the local workbench, provider process lifecycle,
  conversation presentation, local permissions, and changed-file experience.
- **Sekai Chisei** owns governance, policy, evidence, provenance, routing,
  usage, and audit.
- **Tenkai** owns releases, environments, delivery plans, deployments,
  rollback, and recovery.
- **Aldunis Platform** owns enterprise tenants, identity, sessions, commercial
  behavior, and browser-facing cross-product composition.

Integrations use explicit authenticated APIs and events. Aldunis Code does not
read another product's database or turn displayed projections into authority.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run build
npm start
```

Open `http://127.0.0.1:4174`.

To run the desktop shell locally:

```sh
npm run desktop
```

The desktop shell waits for an ephemeral loopback host before showing its
window, enforces one application instance, and gives the renderer no ambient
Node.js or filesystem authority. Supported systems, application-data
locations, signing, notarization, provenance, update channels, rollback, and
compromised-release response are defined in
[the desktop distribution design](docs/desktop-distribution.md). Packaging
with `npm run package:desktop` creates local test artifacts only; public
distribution requires the signed native-platform evidence documented there.

The host refuses non-loopback addresses. To use the Vite development server,
run the API host and Vite in separate terminals:

```sh
npm run host -- --port 4175
npm run dev
```

Remote access is explicit and disabled by default. Recommended iPad access
uses Tailscale Serve:

```sh
npm run host -- --remote tailscale
```

A local-network session requires an exact private backend address and an HTTPS
reverse proxy whose public origin is supplied explicitly:

```sh
npm run host -- --remote lan --host 192.168.1.20 \
  --public-url https://aldunis.home.example:4174 \
  --tls-cert /path/to/aldunis.home.example.pem \
  --tls-key /path/to/aldunis.home.example-key.pem
```

The host prints one short-lived pairing URL. Manage paired devices locally:

```sh
npm run host -- --remote-auth list
npm run host -- --remote-auth pair
npm run host -- --remote-auth revoke --session <session-id>
```

The [authenticated remote workbench decision](docs/remote-workbench.md)
defines the transport and application-authority boundary.

Use **Open repository** in the sidebar and enter an absolute local path. The
host resolves symlinks, finds the canonical Git root, and returns normalized
repository and worktree metadata. Browser code receives no filesystem handle.

If a repository was moved, removed, or became inaccessible, open the project
switcher and select its current path. Missing and inaccessible linked worktrees
are reported in the sidebar without attempting to repair or delete them.

```sh
npm test
npm run check
npm run build
```

After opening a repository or linked worktree, choose Claude Code or an
authenticated Codex CLI and send a prompt to start a provider session attached
to that explicitly selected worktree. Codex discovery reports its local
authentication readiness, version, models, and supported reasoning efforts.
Provider credentials remain in each CLI's supported local credential store and
are never returned to the browser.

## Claude profiles

Open Settings to create named Claude Code profiles with a binary path, an
optional Claude configuration directory, and provider-specific environment
variables. Aldunis Code passes a custom directory as `CLAUDE_CONFIG_DIR` while
leaving the process home unchanged.

Sensitive environment values are stored separately in the local server secret
store with owner-only file permissions. Profile metadata and browser responses
contain only a marker indicating whether a value exists. Editing a profile with
an empty displayed sensitive value preserves the stored value; removing its
environment-variable row deletes the Aldunis-owned secret.

Deleting a profile removes its Aldunis-owned environment secrets. It never
deletes the configured Claude directory, Claude credentials, or other
provider-owned files. Existing Claude threads may continue only through a
profile that resolves to the same Claude configuration directory.
Aldunis Code starts Claude in plan permission mode for this initial adapter, so
mutating tools are not silently approved. Active turns can be cancelled, and a
completed or interrupted Claude session can be resumed with its provider
session ID. Unknown protocol events and unsupported Claude Code major versions
fail closed with a visible conversation state.

Codex uses the same Ask, Plan, and Build authority boundary. Build-mode network
and file mutations pause for one explicit scoped approval; command sandbox
escapes are declined because the current app-server protocol cannot confine
them to the selected worktree. Ask and
Plan decline mutations. Persisted conversations and provider session IDs remain
bound to their original provider, and unknown Codex protocol activity fails
closed.

Use **Changed files** to inspect the active worktree without exposing a
terminal. Added, modified, deleted, renamed, binary, and oversized files have
explicit states. Text patches stay constrained to the selected worktree;
binary content and patches larger than 256 KiB are not rendered. The view is
read-only and never stages, rewrites, or discards user work.

## Local history

Projects, conversations, turns, messages, typed tool activity, and provider
session references are stored as a versioned local event log. The default path
is `$XDG_STATE_HOME/aldunis-code/events.v1.jsonl` (or
`~/.local/state/aldunis-code/events.v1.jsonl`). Set
`ALDUNIS_CODE_STATE_DIR` to use another local state directory.

Every event is appended in sequence and synchronized before it is projected.
Startup rebuilds projections from the log; corrupt, unordered, or incompatible
history stops with an explicit error rather than resetting data. Project
deletion and retention compact the log atomically so removed prompts and
activity are not left behind. Provider credentials, environment variables,
tool inputs, and tool outputs are not part of the persistence schema.

Active turns remain owned by the loopback host when the user navigates away
from Code. Returning restores the latest durable messages, provider run,
attention state, and pending approval without restarting the provider.
Background state checks are bounded to active turns, and each project is
limited to 200 retained conversations until older local history is deleted or
compacted. Desktop notifications are optional, requested only by an explicit
user action, and contain generic attention text rather than prompts, paths, or
provider output.

Read [AGENTS.md](AGENTS.md), [the architecture](docs/architecture.md), and
[the work lifecycle](docs/work-lifecycle.md) before changing a boundary.
Checkpoint safeguards and interrupted-operation recovery are described in
[workspace checkpoints](docs/workspace-checkpoints.md).
