# Aldunis Code

Local-first workbench for agent-assisted software development.

[![CI](https://github.com/Sannrox/aldunis-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Sannrox/aldunis-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22.12+](https://img.shields.io/badge/Node.js-22.12%2B-339933.svg)](package.json)

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

## Product family

| Product                                                 | Role                                         |
| ------------------------------------------------------- | -------------------------------------------- |
| **Aldunis Code** (this repo)                            | Local workbench, providers, approvals, diffs |
| [Sekai Chisei](https://github.com/Sannrox/sekai-chisei) | Governance, policy, budgets, evidence, audit |
| [Tenkai](https://github.com/Sannrox/tenkai)             | Releases, environments, delivery, recovery   |

Cross-product screens consume **authenticated contracts** only. They never share
databases or treat cached UI projections as authority. Sekai / Chisei / Tenkai
appear in the product switcher only when configured (see
[getting started](docs/getting-started.md#cross-product-planes)).

## Quick start

**Requirements:** Node.js 22.12+, npm, Git, and a local Git repository to open.

```sh
npm ci
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174).

For development, run the API host and Vite in separate terminals:

```sh
# Terminal 1
npm run cli -- serve --port 4175

# Terminal 2
npm run dev
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174); Vite proxies API requests
to the host on port 4175.

Verify:

```sh
npm test
npm run check
npm run build
```

### Desktop release signing

Nightly desktop releases are opt-in prereleases. When Windows Authenticode
credentials are not configured, the nightly workflow may publish an unsigned
Windows installer and labels that limitation in the release notes. Stable
releases remain fail-closed and require signed Windows and macOS packages.
See [desktop distribution](docs/desktop-distribution.md) for the signing
requirements and update-channel behavior.

Full install, providers, remote access, and desktop packaging:
**[docs/getting-started.md](docs/getting-started.md)**

The host command reference, including structured startup and remote-auth
commands, is in **[docs/cli.md](docs/cli.md)**.

## Contributing

Contributions are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md), use the issue templates for bugs and
features, and report vulnerabilities privately through
[SECURITY.md](SECURITY.md). The project is pre-release, so proposals that
reduce unsafe authority, clarify provider boundaries, or improve deterministic
verification are especially useful.

## Documentation

| Doc                                          | Audience                                         |
| -------------------------------------------- | ------------------------------------------------ |
| [Documentation index](docs/README.md)        | Map of all docs                                  |
| [Getting started](docs/getting-started.md)   | Install, run, first conversation                 |
| [Architecture](docs/architecture.md)         | Topology, ownership, security invariants         |
| [Providers](docs/providers.md)               | Claude, Codex, Shikigami, ACP adapters           |
| [Automations](docs/automations.md)           | Scheduled prompts into existing threads          |
| [Local data](docs/local-data.md)             | State directory, history, preferences            |
| [Remote workbench](docs/remote-workbench.md) | Tailscale / LAN remote access                    |
| [Work lifecycle](docs/work-lifecycle.md)     | Issues, PRs, review                              |
| [Decisions](docs/decisions/README.md)        | Accepted design decisions                        |
| [Contributing](CONTRIBUTING.md)              | How to contribute                                |
| [Security](SECURITY.md)                      | Vulnerability reporting                          |
| [AGENTS.md](AGENTS.md)                       | Repository-specific engineering rules for agents |

## License

[MIT](LICENSE) — Copyright (c) 2026 Aldunis contributors.
