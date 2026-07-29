# Provider management entry-point research

Issue [#364](https://github.com/Sannrox/aldunis-code/issues/364) asks whether
provider profiles and declarative adapters need one administration entry point.

## Decision

**Proceed with one shell, not one authority.** Create a top-level Provider
management shell with explicit Profiles, Adapter packages, and Diagnostics
destinations. Contextual setup and recovery actions deep-link to the relevant
profile. Adapter installation and package lifecycle stay in a separately
labeled trust section with their existing approval boundary.

The implementation is scoped in blocked Issue
[#369](https://github.com/Sannrox/aldunis-code/issues/369). No trust,
credential, subprocess, or remote-administration rule changes in this decision.

## Product contract

Provider administration must help a local operator make a provider ready,
understand failures, and intentionally manage declarative adapter packages.
These constraints are fixed:

- selecting a provider for execution is not administration;
- a profile configures one provider runtime and may contain Aldunis-owned,
  write-only environment secrets;
- provider login and OAuth remain provider-owned;
- an adapter package is a digest-pinned launch/protocol contract whose install
  or material update requires explicit approval;
- the selected provider executable runs with the local OS user's authority and
  is not an operating-system sandbox;
- adapter administration is unavailable in remote mode;
- manifest validation, rollback, uninstall, permission brokering, and
  fail-closed protocol handling do not weaken.

One shell is a navigation boundary only. Existing profile and adapter APIs,
stores, validation, and mutation paths remain separate.

## Current inventory

| Entry point | Destination | Purpose | Recovery handoff |
| --- | --- | --- | --- |
| Composer provider menu | Provider Profiles | Generic profile configuration | Optionally targets active provider |
| Composer empty/readiness/failure actions | Provider Profiles | Repair a specific provider | Targets failing provider/profile |
| Command palette: Provider settings | Provider Profiles | Generic administration | None |
| Command palette: Provider adapters | Provider Adapters | Package administration | None |
| Preferences → Providers: Manage profiles | Provider Profiles | Generic administration | Closes Preferences first |
| Preferences → Providers: Manage adapters | Provider Adapters | Package administration | Closes Preferences first |

The application owns two dialog booleans and two independent dialog roots.
Preferences explains that they are deliberately separate, but users still need
to know whether a missing provider is a profile, package, CLI, authentication,
environment, model, or readiness problem before choosing a destination.

### Operations and ownership

| Concept / operation | Classification | Authority and current surface |
| --- | --- | --- |
| Provider/model selection | Execution selection | Composer; keep outside administration |
| Named/default profile, binary, home, environment | Local configuration | Profiles API and restricted secret store |
| Availability, version, authentication, models | Diagnostics | Profile refresh/discovery; read-only result |
| Provider login/OAuth | Credential ownership | Provider-owned; Aldunis shows guidance only |
| Reviewed/custom manifest and digest | Trust approval | Adapter inspection and approval |
| Install/update/reinstall | Trust + local package metadata | Adapter API after explicit approval |
| Enable/disable | Local package lifecycle | Adapter API |
| Rollback/uninstall | Recovery and local package lifecycle | Adapter API; never provider binary/credentials |
| Sensitive environment values | Local secret configuration | Profiles; write-only markers in browser |
| Provider readiness | Diagnostics projection | Discovery combines binary, auth, profile, and package state |

## Proposed shell

```text
Provider management
├─ Profiles          runtime config, secrets, provider-owned login guidance
├─ Adapter packages  trust review, install/update, enable, rollback, uninstall
└─ Diagnostics       read-only readiness and recovery routing
```

- Preferences and the command palette each expose one generic **Provider
  management** action instead of two sibling actions.
- Composer setup/recovery continues to take one action and opens Profiles with
  the relevant provider selected. It never lands on package installation.
- An installed adapter profile may link to its owning package's read-only
  status and then to Adapter packages. The link names the trust transition.
- Adapter packages keeps the digest, claimed publisher/source, executable,
  fixed arguments, environment names, unrestricted-process warning, approval,
  rollback, and uninstall consequences together.
- Diagnostics explains whether recovery belongs to a missing binary, provider
  login, profile environment, disabled/missing adapter package, incompatible
  version, or failed probe. It routes to the owning destination but performs no
  mutation.
- Remote clients can inspect profiles, package readiness, and diagnostics but
  cannot enter adapter mutation flows.

Profiles and Adapter packages must not share a generic Save or Install action.
The shell may share navigation, focus management, and status presentation, but
not mutation forms or confirmation language.

## Complexity ledger

| Burden | Payer | Class | Decision |
| --- | --- | --- | --- |
| Two generic command-palette choices | Users diagnosing an unfamiliar failure | Accidental | Combine into one shell entry |
| Two Preferences handoffs and dialog roots | Users and client maintainers | Accidental | Combine composition/navigation |
| Contextual provider-specific recovery | Users | Essential | Keep as deep link |
| Provider profile concept | Operators and runtime | Essential | Keep explicit |
| Adapter package/trust concept | Operators and security reviewers | Essential | Keep explicit |
| Profile for an installed adapter | Operators | Essential but confusing | Cross-link; do not merge with package approval |
| Provider-owned login versus Aldunis env secrets | Operators/support | Essential ownership distinction | State at point of action |
| Readiness spread across profile/package/provider states | Recovery users | Accidental navigation tax | Add read-only diagnostics routing |
| One generic provider form | Security and maintainers | Transferred complexity | Reject |

## Comparison

| Measure | Current | Proposed | Dividend |
| --- | ---: | ---: | ---: |
| Top-level provider administration shells | 2 dialogs | 1 shell | -1 |
| Generic command-palette actions | 2 | 1 | -1 |
| Generic Preferences actions | 2 | 1 | -1 |
| App-level dialog-open states | 2 | 1 shell route | -1 |
| Contextual recovery actions | 1 per context | 1 per context | No regression |
| Trust/credential concepts | Explicit but split | Explicit sections in one shell | 0; boundaries preserved |
| Profile and adapter mutation APIs | Separate | Separate | 0 |
| Steps from contextual failure to profile | 1 | 1 | 0 |
| Steps from generic entry to a chosen section | 1 direct choice today | 1 shell entry plus visible destination choice | +1 unless the shell restores the last safe destination |

The generic path can avoid a recurring extra step by restoring the last
non-approval destination, defaulting to Diagnostics for first use, and keeping
all destinations visible. Contextual links always provide an explicit target.
The one-time cost is shell composition, route/focus state, and moving existing
dialogs without changing their operations. The change is reversible because
server contracts and persisted stores remain intact.

## Failure and recovery requirements

- A profile save/probe failure remains inside Profiles with the selected
  provider and unsaved input intact.
- Adapter inspection or approval failure remains inside Adapter packages with
  the reviewed digest and consequences visible.
- Remote-mode denial disables only adapter mutations and explains how to return
  to loopback; it does not hide readiness.
- Provider-owned authentication guidance never claims Aldunis can log in,
  delete, or recover provider credentials.
- Rollback and uninstall continue to describe exactly which Aldunis metadata
  changes and which provider binaries, credentials, configuration, profiles,
  and conversation history remain.
- Keyboard focus and the invoking control are restored across deep links,
  section changes, nested approval, cancellation, and close.

## Verification plan

Implementation must deterministically cover generic and contextual entry,
provider targeting, keyboard navigation, narrow layouts, unsaved profile
recovery, every adapter approval/lifecycle action, remote-mode denial,
read-only diagnostics, secret redaction, and return focus. Existing profile,
adapter, discovery, permission, and protocol tests remain required.

No further product decision is needed for the shell described here. A proposal
to merge profile and adapter mutation APIs, weaken digest approval, store
provider credentials, or administer adapters remotely would cross an existing
trust boundary and requires a separate design decision.

