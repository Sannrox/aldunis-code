# Managed image compatibility report

- Status: integrated managed-image build and publication workflow
- Scope: image portion of [Platform #141](https://github.com/Sannrox/aldunis-platform/issues/141)
- Shikigami build input: `ghcr.io/sannrox/shikigami@sha256:91c9ea4f3ef0c59b91cf57a1cc7b3a849c80ea02d984c6a8db71c9736e966a95`
- Shikigami revision: `8de00f0d715b1e73573a58f84ccdc157d1f98ca2`
- Managed Code contract revision assessed: `e0fea82f1baf9c907d7c5308459aa69787f64cd4`
- Assessment date: 2026-08-01

This report records the smallest safe boundary selected by [Platform #142](https://github.com/Sannrox/aldunis-platform/issues/142): the independently published Shikigami OCI image is a digest-pinned build input to the final managed Code image. The final runtime copies the reviewed `shikigami` executable and continues to invoke it through Code's accepted local-subprocess provider. It does not start a Shikigami service, add a sidecar, or define a network protocol.

The build and restricted smoke check are implemented in the managed-image
workflow. Every push to the protected `main` branch builds and publishes a
digest-addressable image after the smoke gate; `code-v*` tags and manual
dispatch from `main` remain available for explicit releases. Platform must
consume the recorded immutable digest, not a mutable tag.

## Contract evidence

The managed Code contract revision is the merged implementation of [Code #438](https://github.com/Sannrox/aldunis-code/issues/438). The managed Code contract is recorded in [`docs/decisions/managed-hosted-workbench.md`](decisions/managed-hosted-workbench.md) and [`docs/providers.md`](providers.md):

- `ALDUNIS_HOST_MODE=managed` is required for the managed profile.
- `server/main.ts` starts `npm run host` on the configured private bind and requires `--tls-cert` and `--tls-key` for a non-loopback bind.
- `server/managed-host.ts` requires the gateway assertion configuration, the fixed repository catalogue, and the complete operator-owned Shikigami configuration before startup.
- `server/shikigami-provider.ts` requires Shikigami `1.0.5+`, starts `shikigami version`, then launches `run --keep-workspace --task-file` with generated config and state paths. The integrated image supplies that executable from the pinned build input while preserving this local-subprocess contract.
- `server/host.ts` serves the built web application from `dist` relative to the host source, so the image must contain both the built web output and the server runtime source used by `npm run host`, including the runtime-imported `src/lib/assistant-text.ts` and `src/lib/delegated-conversation-graph.ts`.
- Repository and worktree operations invoke `git`; a compatible image must provide a `git` executable in the runtime PATH.

The external Compose contract is in the reviewed [Platform managed-code composition](https://github.com/Sannrox/aldunis-platform/blob/main/deploy/hetzner-staging/compose.yaml) and [managed Code runbook](https://github.com/Sannrox/aldunis-platform/blob/main/docs/operations/managed-code.md). It overrides the image command with:

```text
npm run host -- --host 172.30.0.10 --port 4174 \
  --tls-cert /run/secrets/code-tls-cert \
  --tls-key /run/secrets/code-tls-key
```

The service therefore needs these runtime properties:

| Surface | Required image/runtime behavior | Evidence |
| --- | --- | --- |
| Architecture | Linux `amd64` / `x86_64` Code image; the Shikigami build input is independently pinned to its reviewed architecture and digest | Platform #141; Shikigami #156 |
| Host | `npm run host` must remain the entry command; the platform supplies bind, port, and TLS arguments | `server/main.ts`; Platform Compose |
| Application | Node 22, `npm`/`tsx`, `dist`, `server`, the runtime-imported `src` modules, package metadata, locked dependencies, and `git` | Platform managed-code runbook; `package.json`; `server/host.ts`; `server/state.ts`; `server/repository.ts` |
| Provider boundary | The final Code image copies Shikigami from the pinned build input; Code invokes it as a local subprocess and does not connect to a Shikigami runtime service | Platform #142; `Dockerfile.managed`; `server/shikigami-provider.ts` |
| Provider compatibility | The embedded executable must report `1.0.5+` and support the managed Build/plane/Chisei settings | `server/shikigami-provider.ts`; Code decision; Shikigami #152 |
| Writes | No application writes to the image root; state under `/var/lib/aldunis-code`, `/tmp`, and mounted repositories | Platform Compose; `server/state.ts`; `server/shikigami-provider.ts` |
| Mounts | Must function with public-key/TLS secret mounts, one writable repository-parent mount, and one writable state volume | Platform Compose |
| Containment | Must not require host root, host home, Docker socket, or platform database credentials; Compose applies read-only root, dropped capabilities, `no-new-privileges`, CPU/memory/PID limits | Platform Compose and runbook |
| Provenance | The final image carries `org.opencontainers.image.revision` for its Code source and custom labels for the exact Shikigami image and source revision | `Dockerfile.managed`; `managed-image-smoke.sh` |

## Remaining handoff

### 1. Publish and pin the integrated Code image

Shikigami publication is complete. Release `v1.0.5` provides the reviewed OCI metadata asset with the exact image reference above, BuildKit provenance, and an SBOM. The release work is tracked by [Shikigami #156](https://github.com/Sannrox/shikigami/issues/156), and the security-compatible minimum is recorded by [Shikigami #152](https://github.com/Sannrox/shikigami/issues/152).

The earlier Code-only publication from [Code #451](https://github.com/Sannrox/aldunis-code/pull/451) produced:

```text
ghcr.io/sannrox/aldunis-code@sha256:c430acc6b0a25ed351c06a65d58b96a55856257e7267b6c96a81a87a7321b4c2
```

That digest is a predecessor and intentionally lacks the Shikigami executable. The integrated workflow in this branch first builds and smoke-tests the final image, then publishes it for `linux/amd64` with provenance and SBOM attestations. After publication, Platform must record the resulting immutable Code digest and the matching Code source revision in its compatibility manifest and deployment environment. The Shikigami labels must remain aligned with the exact values above.

### 2. Run the operator-owned managed smoke deployment

The static Code contract cannot prove the Platform acceptance checks without the operator-provisioned repository catalogue, gateway public key, TLS key pair, Chisei endpoint/token/namespace, registry pull access, and a real tenant assertion. No credentials were accessed, and no Platform checkout or Hetzner VM was modified.

The Chisei managed-plane follow-up was merged as [Chisei #488](https://github.com/Sannrox/sekai-chisei/pull/488), but end-to-end image and deployment acceptance belongs to Platform. It should run only after Platform has pinned the newly published integrated image.

## Image build definition

[`Dockerfile.managed`](../Dockerfile.managed) and [`.github/workflows/managed-image.yml`](../.github/workflows/managed-image.yml) implement the selected boundary:

1. Resolve Shikigami from the exact digest-pinned OCI reference as a named build stage.
2. Build the Code web application from a digest-pinned Node 22 Linux base, then copy the runtime packages, `dist`, server source, runtime-imported source modules, package metadata, contracts, vendored SDK package, provider adapters, and `git` into the final image.
3. Copy `/usr/local/bin/shikigami` from the pinned build stage and label the final image with the exact Shikigami image reference and source revision.
4. Build a `linux/amd64` smoke image and run the embedded CLI with network disabled, a read-only root, dropped capabilities, `no-new-privileges`, and resource limits. Only a passing smoke job can publish the managed image.
5. Push the final image only to GHCR and record its immutable manifest digest for Platform to validate with its Compose configuration and managed health/smoke checks.

This composition preserves the accepted Code local-subprocess provider and keeps Shikigami's governance, workspace, permission, and token delivery inside that existing provider boundary. A separate runtime service remains out of scope.
