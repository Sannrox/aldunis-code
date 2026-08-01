# Managed image compatibility report

- Status: Code-only image published; final managed composition remains blocked
- Scope: image portion of [Platform #141](https://github.com/Sannrox/aldunis-platform/issues/141)
- Published image source revision: `f2ebc0eaf906443dff4e37c825099eebc59c40b9`
- Managed Code contract revision assessed: `e0fea82f1baf9c907d7c5308459aa69787f64cd4`
- Assessment date: 2026-08-01

This report records the smallest safe Code-image outcome without claiming a
live managed deployment. A digest-pinned, linux/amd64 Code-only image was
published to `ghcr.io/sannrox/aldunis-code`. Shikigami is intentionally not
bundled: its independent OCI image is tracked by
[Shikigami #156](https://github.com/Sannrox/shikigami/issues/156), and
[Platform #142](https://github.com/Sannrox/aldunis-platform/issues/142) must
select how that image is consumed. This report preserves the accepted
local-subprocess provider boundary and does not invent a network service.

## Contract evidence

The managed Code contract revision is the merged implementation of [Code #438](https://github.com/Sannrox/aldunis-code/issues/438).
The managed Code contract is recorded in
[`docs/decisions/managed-hosted-workbench.md`](decisions/managed-hosted-workbench.md)
and [`docs/providers.md`](providers.md):

- `ALDUNIS_HOST_MODE=managed` is required for the managed profile.
- `server/main.ts` starts `npm run host` on the configured private bind and
  requires `--tls-cert` and `--tls-key` for a non-loopback bind.
- `server/managed-host.ts` requires the gateway assertion configuration, the
  fixed repository catalogue, and the complete operator-owned Shikigami
  configuration before startup.
- `server/shikigami-provider.ts` requires Shikigami `1.0.5+`, starts
  `shikigami version`, then launches `run --keep-workspace --task-file` with
  generated config and state paths. The Code image deliberately does not
  provide that executable; the selected independent-image boundary must make
  it available while preserving this local-subprocess contract.
- `server/host.ts` serves the built web application from `dist` relative to
  the host source, so the image must contain both the built web output and the
  server runtime source used by `npm run host`, including the runtime-imported
  `src/lib/assistant-text.ts` and `src/lib/delegated-conversation-graph.ts`.
- Repository and worktree operations invoke `git`; a compatible image must
  provide a `git` executable in the runtime PATH.

The external Compose contract is in the reviewed
[Platform managed-code composition](https://github.com/Sannrox/aldunis-platform/blob/main/deploy/hetzner-staging/compose.yaml)
and [managed Code runbook](https://github.com/Sannrox/aldunis-platform/blob/main/docs/operations/managed-code.md).
It overrides the image command with:

```text
npm run host -- --host 172.30.0.10 --port 4174 \
  --tls-cert /run/secrets/code-tls-cert \
  --tls-key /run/secrets/code-tls-key
```

The service therefore needs these runtime properties:

| Surface | Required image/runtime behavior | Evidence |
| --- | --- | --- |
| Architecture | Linux `amd64` / `x86_64` Code image; the Shikigami image has its own architecture and digest contract | Platform #141; Shikigami #156 |
| Host | `npm run host` must remain the entry command; the platform supplies bind, port, and TLS arguments | `server/main.ts`; Platform Compose |
| Application | Node 22, `npm`/`tsx`, `dist`, `server`, the runtime-imported `src` modules, `package.json`, locked dependencies, and `git` | Platform managed-code runbook; `package.json`; `server/host.ts`; `server/state.ts`; `server/repository.ts` |
| Provider boundary | The Code image does not bundle Shikigami; Platform #142 must select the independently published image boundary without introducing an unapproved network service | Platform #142; Shikigami #156; `server/shikigami-provider.ts` |
| Provider compatibility | The selected boundary must still make a `1.0.5+` Shikigami executable available to the accepted local subprocess and support managed Build/plane/Chisei settings | `server/shikigami-provider.ts`; Code decision; Shikigami #152 |
| Writes | No application writes to the image root; state under `/var/lib/aldunis-code`, `/tmp`, and mounted repositories | Platform Compose; `server/state.ts`; `server/shikigami-provider.ts` |
| Mounts | Must function with public-key/TLS secret mounts, one writable repository-parent mount, and one writable state volume | Platform Compose |
| Containment | Must not require host root, host home, Docker socket, or platform database credentials; Compose applies read-only root, dropped capabilities, `no-new-privileges`, CPU/memory/PID limits | Platform Compose and runbook |
| Provenance | Published image label `org.opencontainers.image.revision` is `f2ebc0eaf906443dff4e37c825099eebc59c40b9`; Platform must update its older expected revision | Publisher run; Platform `deploy.sh` and `deployment.env.example` |

## Blockers

### 1. The independent Shikigami image boundary is not ready for managed deployment

[Shikigami #152](https://github.com/Sannrox/shikigami/issues/152) records the
managed compatibility finding. It requires the first release containing
security fix [Shikigami #154](https://github.com/Sannrox/shikigami/pull/154),
merge commit `eab167d3e0b55e603bd1e5a0d4214a637ba63a32`, with the intended
minimum of `v1.0.5+`. The latest published release observed during this
assessment is `v1.0.4`; the finding explicitly says that `v1.0.4` and earlier
must not be accepted for hosted Build.

The public `v1.0.4` release does provide an `x86_64-unknown-linux-gnu` asset,
but its presence does not satisfy the managed credential boundary. No
released `v1.0.5+` Linux `x86_64` asset and no approved SHA-256 for that asset
are available to pin into an image build. Shikigami #156 is the repository
work to publish the independent OCI image; Platform #142 is the boundary
decision needed before the Code image can be assembled into the final managed
composition.

This does not block publishing the Code-only image. It does block declaring
the current single-service Compose contract ready, because it points
`ALDUNIS_MANAGED_SHIKIGAMI_EXECUTABLE` at `/usr/local/bin/shikigami` inside the
Code container while this image intentionally has no such binary. The final
composition must be updated only after Platform #142 selects and verifies the
independent-image boundary; the accepted provider remains a local subprocess.

**Dependencies remaining:** complete Shikigami #156 with a supported,
digest-pinned OCI image, and accept the consumption boundary in Platform #142.
If #142 selects a pinned build-input boundary, the Code image can then copy
the reviewed executable while retaining local subprocess execution. A
separate runtime service would require an explicit protocol and trust-boundary
decision; this report does not assume one.

### 2. Platform must consume the published Code digest and matching revision

The publisher run [30700466482](https://github.com/Sannrox/aldunis-code/actions/runs/30700466482)
successfully pushed and attested the Code-only image:

```text
ghcr.io/sannrox/aldunis-code@sha256:c430acc6b0a25ed351c06a65d58b96a55856257e7267b6c96a81a87a7321b4c2
```

It is also tagged `managed-latest` and `sha-f2ebc0e`. The workflow does not
put credentials in the repository. The deployment placeholder
`ghcr.io/example/aldunis-code@sha256:...` remains intentionally unusable until
Platform records the real digest.

**Dependency remaining:** Platform must authorize GHCR pull access on the
Hetzner host, replace the placeholder with the exact immutable digest above,
and update `ALDUNIS_CODE_REVISION` to
`f2ebc0eaf906443dff4e37c825099eebc59c40b9`. The current Platform value
`e0fea82f1baf9c907d7c5308459aa69787f64cd4` predates this image packaging
change.

### 3. A live managed smoke deployment is outside this repository

The static Code contract can establish the expected command, files, mounts,
and environment. It cannot prove the Platform acceptance checks without the
operator-provisioned repository catalogue, gateway public key, TLS key pair,
Chisei endpoint/token/namespace, registry pull access, and a real tenant
assertion. No credentials were accessed, and no Platform checkout or Hetzner
VM was modified.

The Chisei managed-plane follow-up was merged as
[Chisei #488](https://github.com/Sannrox/sekai-chisei/pull/488), but the
end-to-end image and deployment acceptance still belongs to Platform and was
not run here.

## Image build definition

[`Dockerfile.managed`](../Dockerfile.managed) and
[`.github/workflows/managed-image.yml`](../.github/workflows/managed-image.yml)
implement the Code-only image with:

1. A digest-pinned Node 22 Linux base and only the runtime
   packages needed by the host (`git`, CA certificates, Node/npm, and the
   locked npm dependencies).
2. `npm run build:web`, followed by copying the resulting `dist`, the server runtime
   source plus its runtime-imported `src` modules, and package metadata. It
   deliberately does not copy or download Shikigami; that input is governed by
   Shikigami #156 and Platform #142.
3. Labels the image with the workflow source revision and emits provenance
   for the source, base image, and build command.
4. Builds for `linux/amd64`, pushes only to GHCR, and records the immutable
   image manifest digest for Platform to validate with its Compose config and
   managed health/smoke checks using operator-supplied mounts and secrets.

The workflow does not bundle or download Shikigami. The published digest and
source revision above are the provenance handoff to Platform. The publisher’s
attestation is recorded at
[GitHub attestation 38327428](https://github.com/Sannrox/aldunis-code/attestations/38327428).
A published Code-only image is not, by itself, evidence that the managed
provider path or Hetzner deployment is ready.
