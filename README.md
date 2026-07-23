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

The host refuses non-loopback addresses. To use the Vite development server,
run the API host and Vite in separate terminals:

```sh
npm run host -- --port 4175
npm run dev
```

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

After opening a repository or linked worktree, send a prompt to start a Claude
Code session attached to that explicitly selected worktree. Provider
credentials stay in Claude Code's
supported local credential store and are never returned to the browser.
Aldunis Code starts Claude in plan permission mode for this initial adapter, so
mutating tools are not silently approved. Active turns can be cancelled, and a
completed or interrupted Claude session can be resumed with its provider
session ID. Unknown protocol events and unsupported Claude Code major versions
fail closed with a visible conversation state.

Read [AGENTS.md](AGENTS.md), [the architecture](docs/architecture.md), and
[the work lifecycle](docs/work-lifecycle.md) before changing a boundary.
