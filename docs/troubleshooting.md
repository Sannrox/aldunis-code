# Troubleshooting

## Host will not start / port in use

```sh
lsof -nP -iTCP:4174 -sTCP:LISTEN
lsof -nP -iTCP:4175 -sTCP:LISTEN
```

Stop the conflicting process or choose another port:

```sh
npm run host -- --port 4176
```

## “Refusing non-loopback bind”

The host defaults to loopback. Do not pass a public `--host` unless you intend
[remote mode](remote-workbench.md) with TLS and pairing.

## Provider not listed or not ready

1. Confirm the binary is on `PATH` (`claude`, `codex`, `shikigami`, `kiro-cli`,
   `grok`, `opencode`).
2. Read the composer placeholder and empty-state detail — discovery surfaces a
   specific fix when known (missing binary, bad version, missing sign-in / key).
3. For Claude, open Settings → profiles and check authentication probe.
4. For Codex, run `codex login` when install is present but not authenticated.
5. For Shikigami, install **1.0.2+**; park resume remains CLI-only
   (`shikigami run --resume <id> --answer "…"`) until park-answer UX ships.
6. For ACP adapters, install the reviewed package under Provider adapters and
   ensure the exact launch (`… acp` / `grok agent stdio`) matches the digest.
7. Remote mode disables adapter administration—return to loopback to install.

## Approvals never appear

- Build mode is required for mutating tools.
- Ask/Plan decline mutations by design.
- Shikigami pre-tool waits are capped by hook timeout (max 120s).

## Automations never fire

- The **host process** must stay running.
- First tick **seeds** without firing; use **Run now** to test.
- Busy threads skip without advancing `lastRunAt`.
- Cron fields are **UTC**.

## History / preferences recovered

Invalid on-disk JSON recovers to safe defaults with a visible recovered flag.
Intact history records with forked sequence metadata are repaired automatically
at startup. Stop extra host processes if state repeatedly reports that it is
busy.
Do not delete the state directory unless you intend to lose local history.
See [local-data.md](local-data.md).

## Product switcher: Sekai / Chisei / Tenkai disabled

Expected until endpoints are configured:

```sh
export ALDUNIS_SEKAI_ENDPOINT=…
export ALDUNIS_CHISEI_ENDPOINT=…
export ALDUNIS_TENKAI_ENDPOINT=…
```

Restart the host after changing env.
