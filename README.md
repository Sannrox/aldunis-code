# Aldunis Code

Local-first workbench for agent-assisted software development.

Aldunis Code gives you one loopback-bound interface for repositories, worktrees,
conversations, tool approvals, and diffs. Provider CLIs (Claude Code, Codex,
Shikigami, and reviewed ACP adapters) run as **local subprocesses** under an
explicit permission model. The browser never receives provider credentials or
unrestricted filesystem access.

**Status:** early / pre-release. Suitable for local development and review, not
unattended production use.

## Why this exists

Most coding agents are either a terminal session or a cloud IDE tab. Aldunis Code
is a **local host + web UI** that:

- binds conversations to a **canonical repository and worktree**
- normalizes multi-provider events into one conversation model
- requires **scoped, inspectable approval** for mutating tools
- keeps secrets and state on the machine, not in the browser

It is an independent implementation. It does not copy T3 Code source or product
identity; open projects may inform workflows, but shipped code is owned here.

## Product family

| Product | Role |
| --- | --- |
| **Aldunis Code** (this repo) | Local workbench, providers, approvals, diffs |
| [Sekai Chisei](https://github.com/Sannrox/sekai-chisei) | Governance, policy, budgets, evidence, audit |
| [Tenkai](https://github.com/Sannrox/tenkai) | Releases, environments, delivery, recovery |
| Aldunis Platform | Enterprise identity, tenants, commercial composition |

Cross-product screens consume **authenticated contracts** only. They never share
databases or treat cached UI projections as authority. Sekai / Chisei / Tenkai
appear in the product switcher only when configured (see
[getting started](docs/getting-started.md#cross-product-planes)).

## Quick start

**Requirements:** Node.js 22+

```sh
npm install
npm run build
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174).

Development (API host + Vite):

```sh
npm run host -- --port 4175
npm run dev   # http://127.0.0.1:4174 → proxies to host
```

Verify:

```sh
npm test
npm run check
npm run build
```

Full install, providers, remote access, and desktop packaging:
**[docs/getting-started.md](docs/getting-started.md)**

## Documentation

| Doc | Audience |
| --- | --- |
| [Documentation index](docs/README.md) | Map of all docs |
| [Getting started](docs/getting-started.md) | Install, run, first conversation |
| [Architecture](docs/architecture.md) | Topology, ownership, security invariants |
| [Providers](docs/providers.md) | Claude, Codex, Shikigami, ACP adapters |
| [Automations](docs/automations.md) | Scheduled prompts into existing threads |
| [Local data](docs/local-data.md) | State directory, history, preferences |
| [Remote workbench](docs/remote-workbench.md) | Tailscale / LAN remote access |
| [Work lifecycle](docs/work-lifecycle.md) | Issues, PRs, review |
| [Decisions](docs/decisions/README.md) | Accepted design decisions |
| [Contributing](CONTRIBUTING.md) | How to contribute |
| [Security](SECURITY.md) | Vulnerability reporting |
| [AGENTS.md](AGENTS.md) | Engineering rules for humans and agents |

## License

[MIT](LICENSE) — Copyright (c) 2026 Aldunis contributors.
