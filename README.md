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
npm run dev
```

Open `http://127.0.0.1:4174`.

```sh
npm run check
npm run build
```

The current application is a navigable product shell with representative local
data. Provider and product integrations are deliberately marked disconnected
until their contracts are implemented.

Read [AGENTS.md](AGENTS.md), [the architecture](docs/architecture.md), and
[the work lifecycle](docs/work-lifecycle.md) before changing a boundary.

