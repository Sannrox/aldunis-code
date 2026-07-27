# Security policy

## Reporting

Do **not** open a public Issue for suspected vulnerabilities.

Use a private
[GitHub security advisory](https://github.com/Sannrox/aldunis-code/security/advisories/new).

Include:

- affected revision (commit or release tag)
- operating system and how you ran the host (loopback / remote)
- reproduction steps
- impact assessment
- a **minimal, redacted** proof of concept

Never attach credentials, private source code, provider transcripts, customer
data, or unredacted logs.

## Current posture

Aldunis Code is **pre-release** and is not supported for production or
unattended execution.

Hard requirements for safe use:

- Bind to **loopback by default**. Non-loopback binds require explicit remote
  mode and authenticated sessions ([remote workbench](docs/remote-workbench.md)).
- Provider credentials remain in **provider-supported local stores** and must
  never be sent to the browser, public logs, or the git repository.
- Mutating tools require **explicit, scoped approval** (allow-once) bound to
  conversation, repository, and worktree.
- Declarative provider adapters are **user-trusted manifests**, not sandboxes.
  The native provider process runs with the local OS user authority.
- Treat prompts, paths, diffs, and tool activity as **sensitive local data**.

## Threat notes (non-exhaustive)

| Risk | Mitigation direction |
| --- | --- |
| Prompt injection via repo content | Human approval for mutations; fail closed on unknown protocol |
| Accidental remote exposure | Loopback default; pairing for remote; no ambient network bind |
| Secret leakage in UI/logs | Redacted profile markers; no tool I/O in history schema |
| Adapter supply chain | Digest-pinned manifests; explicit install approval |

## Supported versions

Only the default branch and explicitly tagged releases receive security review
attention during early development. Always prefer the latest default branch
when testing fixes.

## Related docs

- [Architecture — security invariants](docs/architecture.md#security-invariants)
- [Local data](docs/local-data.md)
- [Providers](docs/providers.md)
