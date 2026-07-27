# Contributing to Aldunis Code

Thank you for helping improve a local-first agent workbench. This guide is for
human contributors and automated agents.

## Before you start

1. Read [AGENTS.md](AGENTS.md) (product boundary and engineering rules).
2. Read [docs/architecture.md](docs/architecture.md) before changing trust,
   providers, filesystem scope, or approvals.
3. Prefer one GitHub Issue → one branch → one PR → one observable outcome.
   See [docs/work-lifecycle.md](docs/work-lifecycle.md).

## Development setup

```sh
git clone https://github.com/Sannrox/aldunis-code.git
cd aldunis-code
npm install
npm run check
npm test
```

Run the stack locally:

```sh
# Terminal 1 — API host (loopback only by default)
npm run host -- --port 4175

# Terminal 2 — Vite UI
npm run dev
```

Open `http://127.0.0.1:4174`. The host refuses non-loopback binds unless you
explicitly enable [remote mode](docs/remote-workbench.md).

### Useful scripts

| Script | Purpose |
| --- | --- |
| `npm run host` | Local API / provider host |
| `npm run dev` | Vite UI on 127.0.0.1:4174 |
| `npm test` | Deterministic unit tests |
| `npm run check` | TypeScript project build check |
| `npm run build` | Web + desktop main bundles |
| `npm run desktop` | Packaged Electron shell (local) |

## Pull requests

1. Create a branch. Agent-created branches use the `codex/` prefix.
2. Keep scope to one Issue outcome. Link the Issue (`Closes #N`).
3. Record verification actually run (and what you skipped).
4. Publish PR tips with `scripts/gh-verified-push.sh` for GitHub-**Verified**
   commits. Prefer **squash merge** (`gh pr merge --squash --delete-branch`);
   avoid rebase-merge when Verified history matters.
5. Do not commit credentials, provider transcripts, customer code, unredacted
   logs, local databases, or runtime state directories.

### Verification expectations

At minimum for application changes:

```sh
npm run check
npm test
```

Add focused tests for new server logic. Provider and live UI stress are
proportionate to risk—state what you ran.

For agent-delivered Issues, also run the **global** `autoreview` helper when
available (see AGENTS.md). Do not vendor autoreview into this repository.

## Architecture and decisions

Difficult-to-reverse choices (provider trust, credentials, filesystem scope,
approval authority, cross-product contracts) need a Discussion and often a
short note under [docs/decisions/](docs/decisions/README.md).

Use repository skills under `.agents/skills/` when shaping or delivering work:

- `route-code-work` — ownership across Code / Chisei / Tenkai / Platform
- `assess-code-impact` — security and boundary impact
- `deliver-code-issue` — implementation through a ready PR
- `verify-code-change` — proportionate verification
- `capture-code-decision` — promote accepted design into docs

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not open public Issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
