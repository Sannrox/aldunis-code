# Local candidate-to-release delivery

Aldunis Code can coordinate one reviewed commit through Chisei evaluation and
Tenkai's built-in `local` environment without exposing a terminal. The workflow
is a capability-linked handoff: Code owns the local candidate and correlation
ledger, Chisei owns the governance decision and signed evidence, and Tenkai
owns release, plan, apply, health, rollback, and recovery state.

## Version 1 scope

Version 1 deliberately admits one narrow profile:

- a clean committed Git worktree with a credential-free `origin` remote;
- canonical UTF-8 tracked paths, with no symlinks, submodules, or unresolved
  entries;
- a repository-relative Tenkai software manifest;
- committed root `package.json` and `package-lock.json` files with explicit
  `build` and `test` scripts;
- Tenkai's built-in `local` environment and preconfigured
  `<product>=stable` subscription; and
- the Chisei `example.software-release-candidate/v1` evaluation and
  `example.governed-subject-receipt/v1` Tenkai provenance profile.

Dirty-worktree releases, arbitrary build commands, hosted delivery, non-local
environments, infrastructure apply, and general command execution are not
available.

## Configure the local adapters

Install compatible `sekaictl` and `tenkaictl` binaries. Configure these values
only in the host process:

```sh
export ALDUNIS_CHISEI_ENDPOINT=http://127.0.0.1:50051
export ALDUNIS_CHISEI_TOKEN=…
export ALDUNIS_TENKAI_ENDPOINT=local
export ALDUNIS_TENKAI_DATABASE=/path/to/tenkai-owned.db
```

Optional binary overrides are `ALDUNIS_SEKAICTL_PATH` and
`ALDUNIS_TENKAICTL_PATH`. The database path, token, subprocess environment,
signed evidence envelope, and public trust-root file are never returned to the
browser. Bind the local project to its authorized Chisei namespace before
evaluation.

Initialize Tenkai and configure the product's stable subscription before the
workbench promotes it. Subscription administration remains a Tenkai operation;
Code does not add an unversioned mutation:

```sh
tenkaictl --database /path/to/tenkai-owned.db init
tenkaictl --database /path/to/tenkai-owned.db env subscribe local example=stable
```

## Use the staged ledger

Open the Tenkai product screen and select the explicit manifest. Each mutation
has a single-use five-minute preview:

1. **Prepare candidate** checks the committed tree, computes the accepted
   `aldunis.delivery-candidate/v1` digest, installs the exact committed lockfile
   with `npm ci --ignore-scripts`, and runs the repository-declared
   `npm run build` and `npm test`. All three commands run in one detached
   checkout of the exact reviewed commit; package scripts are restored from
   that commit before execution.
2. **Evaluate** submits only candidate identities and digests. Chisei denial,
   unavailability, staleness, and unknown results fail closed.
3. **Publish** asks Chisei to export a short-lived authenticated provenance
   envelope, invokes Tenkai against a detached checkout of the candidate commit,
   then inspects the immutable release. The first local slice uses Tenkai's
   explicit unsigned-development release mode; Chisei provenance is still
   issuer-authenticated.
4. **Promote and plan** reconcile the stable channel and accept only one
   complete Tenkai step for the selected candidate. Truncated or multi-product
   plans fail closed.
5. **Apply** uses Tenkai's explicit local-development approval bypass after a
   separate Code confirmation. That confirmation is neither a Chisei policy
   decision nor a Tenkai plan approval.
6. **Reconcile or rollback** reads Tenkai's release and environment records.
   A subprocess exit never becomes delivery success. A healthy authoritative
   rollback remains recovered after provenance expiry, while its exported
   delivery receipt is marked stale.
7. **Inspect terminal evidence** reads Tenkai's bounded `terminal_outcomes`
   projection for the selected release and plan. Code displays only event,
   deployment, release, plan, environment, configuration, binding digests,
   terminal state, observation time, delivery attempts, and delivery lag. The
   projection never includes payloads, retry errors, credentials, source, or
   logs. `pending`, `in_flight`, and `retrying` remain visible and the absence
   of a row is never treated as successful delivery.
8. **Confirm the observation** optionally reads the Chisei bounded sample
   observation using the Tenkai event identity as `request_id`. The host derives
   the Chisei namespace from the local project binding; the browser cannot
   select or override it. A missing readback is explicit and does not recreate
   the original observation content.

Completed and historical sessions remain selectable. Use **New candidate** to
return to the committed manifest input and start the next one-release ledger.

Build scripts and Tenkai deployment commands execute with the local OS user's
authority. The host supplies a credential-minimized environment, but this is
not an operating-system sandbox.

## Recovery and restart

The session ledger survives host restart in
`release-deliveries.v1.json`. It contains candidate/build digests and opaque
Chisei/Tenkai references, not source, command output, credentials, signed
assertions, approval envelopes, or raw logs.

If source, manifest, artifact inputs, package scripts, or the lockfile changes,
the old session becomes `stale` and cannot advance. A timeout or malformed
foreign result becomes `unknown`; reconcile with Tenkai before retrying a
mutation. Known health failure remains `partial` until Tenkai reaches a
reconciled terminal deployment or rollback.

`aldunis.delivery-receipt/v1` exports correlation only. `complete` requires a
fresh matching Chisei allow receipt and a reconciled terminal Tenkai outcome.
When a failed or unknown terminal state is present, **Prepare Shikigami repair**
opens a new normal Build conversation with a bounded evidence brief. It does
not start a hidden provider run, bypass approval, or read either product's
database. The existing provider-confirmed Shikigami run and native parked-run
resume boundary remain the provider's responsibility. Deleting the local
receipt or session never deletes Chisei or Tenkai records.
