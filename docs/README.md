# Documentation

Guide to Aldunis Code documentation. Start with [getting started](getting-started.md)
if you want to run the app; start with [architecture](architecture.md) if you
want to change it.

## User and operator guides

| Document | Description |
| --- | --- |
| [getting-started.md](getting-started.md) | Install, run, first conversation, remote, desktop |
| [providers.md](providers.md) | Claude, Codex, Shikigami, reviewed ACP adapters |
| [automations.md](automations.md) | Timer-only scheduled prompts |
| [local-data.md](local-data.md) | State directory, history, preferences, secrets |
| [remote-workbench.md](remote-workbench.md) | Authenticated remote access (Tailscale / LAN) |
| [workspace-checkpoints.md](workspace-checkpoints.md) | Checkpoint capture and rewind safeguards |
| [web-preview.md](web-preview.md) | In-workbench web preview |
| [desktop-distribution.md](desktop-distribution.md) | Packaging, signing, update posture |
| [troubleshooting.md](troubleshooting.md) | Common failures and checks |

## Design and contribution

| Document | Description |
| --- | --- |
| [architecture.md](architecture.md) | Topology, ownership, security invariants |
| [work-lifecycle.md](work-lifecycle.md) | Issues, PRs, review, decisions |
| [design-system.md](design-system.md) | UI tokens and patterns |
| [design/README.md](design/README.md) | Design artifacts and evidence |
| [decisions/README.md](decisions/README.md) | Accepted design decisions (ADRs) |

## Repository root

| Document | Description |
| --- | --- |
| [../README.md](../README.md) | Project overview |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute |
| [../AGENTS.md](../AGENTS.md) | Engineering rules |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting |
| [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Community standards |
| [../LICENSE](../LICENSE) | MIT license |

## Documentation principles

1. **Correct over complete** — document shipped behavior; mark pre-release limits.
2. **Boundaries explicit** — never imply Code owns Chisei policy or Tenkai delivery.
3. **No secrets in examples** — use placeholders; never paste real tokens or paths
   that identify private machines beyond `127.0.0.1` examples.
4. **Decisions stay small** — one accepted choice per ADR under `decisions/`.
5. **Index stays current** — when you add a top-level guide, link it here.
