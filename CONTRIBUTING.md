# Contributing to Aldunis Code

Thank you for helping improve a local-first agent workbench. This guide is for
human contributors and automated agents.

## Before you start

1. Read [AGENTS.md](AGENTS.md) (product boundary and engineering rules).
2. Read [docs/architecture.md](docs/architecture.md) before changing trust,
   providers, filesystem scope, or approvals.
3. Prefer one GitHub Issue → one branch → one PR → one observable outcome.
   See [docs/work-lifecycle.md](docs/work-lifecycle.md).

Use the repository templates:

- [Bug report](https://github.com/Sannrox/aldunis-code/issues/new?template=bug.yml)
- [Feature proposal](https://github.com/Sannrox/aldunis-code/issues/new?template=feature.yml)
- [Private security report](https://github.com/Sannrox/aldunis-code/security/advisories/new)

## Development setup

```sh
git clone https://github.com/Sannrox/aldunis-code.git
cd aldunis-code
npm ci
make validate
make test
make test-integration
```

Run the stack locally:

```sh
# Terminal 1 — API host (loopback only by default)
npm run cli -- serve --port 4175

# Terminal 2 — Vite UI
npm run dev
```

Open `http://127.0.0.1:4174`. The host refuses non-loopback binds unless you
explicitly enable [remote mode](docs/remote-workbench.md).

### Useful scripts

| Script                    | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `npm run host`            | Local API / provider host                                                    |
| `npm run cli -- --help`   | Inspect the structured host CLI                                              |
| `npm run dev`             | Vite UI on 127.0.0.1:4174                                                    |
| `npm run wlan`            | Authenticated private-WLAN host with HTTPS pairing                           |
| `npm run ontology:sync`   | Rebuild the ignored project-local Sekai database from `docs/ontology.json`   |
| `npm run ontology:check`  | Verify the project-local Sekai database matches `docs/ontology.json`         |
| `make validate`           | Formatting, lint, whitespace, and TypeScript validation                      |
| `make test`               | Full deterministic test suite                                                |
| `make test-integration`   | Cross-process, HTTP, provider, persistence, and packaging fixtures           |
| `make coverage`           | c8 coverage report for the affected test tier                                |
| `make update`             | Rebuild the ignored project-local ontology database                          |
| `make all`                | Build web, desktop, and CLI artifacts                                        |
| `npm test`                | Direct unit test implementation                                              |
| `npm run test:affected`   | Run the unit tier when runtime/build files changed; emit a JSON result       |
| `npm run coverage`        | Run the affected test tier with a c8 coverage report                         |
| `npm run format:check`    | Check changed Prettier-supported files                                       |
| `npm run lint:changed`    | Lint changed JavaScript and TypeScript files with ESLint                     |
| `npm run validate`        | Format, lint, and whitespace validation                                      |
| `npm run verify`          | The CI verification command: validate, typecheck, tests, coverage, and build |
| `npm run check`           | TypeScript project build check                                               |
| `npm run build`           | Web + desktop main bundles                                                   |
| `npm run desktop`         | Build and run the local Electron shell                                       |
| `npm run package:desktop` | Build non-release local test packages                                        |

### Local Sekai ontology

The tracked ontology source is [`docs/ontology.json`](docs/ontology.json). The
project-local `knowledge.db` is generated runtime state and is intentionally
ignored. From a clean checkout, create or refresh it with:

```sh
make update
npm run ontology:check
```

These commands use the `sekai` CLI with an explicit project-local database;
they do not read or modify the user-level ontology database, `data/sekai.db`,
or any remote service. The check exits non-zero when the local database is
missing, invalid, or stale.

## Pull requests

1. Create a branch. Agent-created branches use the `codex/` prefix.
2. Keep scope to one Issue outcome. Link the Issue (`Closes #N`).
3. Record verification actually run (and what you skipped).
4. Publish PR tips with `scripts/gh-verified-push.sh` for GitHub-**Verified**
   commits. Prefer **squash merge** (`gh pr merge --squash --delete-branch`);
   avoid rebase-merge when Verified history matters.
5. Do not commit credentials, provider transcripts, customer code, unredacted
   logs, local databases, or runtime state directories.

A pull request should be ready for review: focused commits, no unrelated
formatting churn, updated docs when behavior changes, and tests that cover the
observable outcome. Draft pull requests are appropriate for early design or
cross-platform feedback.

### Verification expectations

At minimum for application changes:

```sh
make validate
make test
make test-integration
```

The format and lint commands are incremental: they inspect changed files by
default so the repository can adopt the tools without a formatting-only
rewrite. Use `npm run format:all` and `npm run lint:all` when auditing the
entire tracked tree.

Add focused tests for new server logic. Provider and live UI stress are
proportionate to risk—state what you ran.

Documentation-only changes should at least pass:

```sh
git diff --check
```

Also verify every changed relative link and run any command whose documented
behavior changed.

For agent-delivered Issues, also run the **global** `autoreview` helper when
available (see AGENTS.md). Do not vendor autoreview into this repository.

## Architecture and decisions

Difficult-to-reverse choices (provider trust, credentials, filesystem scope,
approval authority, cross-product contracts) need a Discussion and often a
short note under [docs/decisions/](docs/decisions/README.md).

Use repository skills under `.agents/skills/` when shaping or delivering work:

- `route-code-work` — ownership across Code / Chisei / Tenkai / Platform
- `assess-code-impact` — security and boundary impact
- `deliver-ready-issue` — implementation through a ready PR
- `verify-code-change` — proportionate verification
- `capture-code-decision` — promote accepted design into docs

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Do not open public Issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
