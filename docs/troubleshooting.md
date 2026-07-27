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
2. For Claude, open Settings → profiles and check authentication probe.
3. For ACP adapters, install the reviewed package under Provider adapters and
   ensure the exact launch (`… acp` / `grok agent stdio`) matches the digest.
4. Remote mode disables adapter administration—return to loopback to install.

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
