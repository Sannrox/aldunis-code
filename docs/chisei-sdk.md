# Sekai Chisei SDK integration

Aldunis Code uses the server-side TypeScript facade from
`Sannrox/sekai-chisei` only inside the Node host. The browser, renderer, and
provider processes never receive Chisei credentials or a client instance.

## Pinned compatibility surface

| Item | Pinned value |
| --- | --- |
| SDK package | `@sannrox/sekai-chisei-sdk` `0.1.0` |
| SDK contract | `sekai.sdk-core-loop/v1` |
| Upstream implementation | `Sannrox/sekai-chisei` commit `82602ccc28d225686b0ec9a1f72b9002042495ce0` (merged as PR [#521](https://github.com/Sannrox/sekai-chisei/pull/521)) |
| Vendored runtime | `vendor/sekai-chisei-sdk/dist/` |
| Vendored protobuf root | `contracts/` |
| Upstream `proto/sekai.proto` digest | `sha256:59a2fabe7400ca1cc0e620ff8f8941e3fcca12e96350873353b94e56392219be` |
| Upstream `proto/chisei.proto` digest | `sha256:def2d824963dbf3f2ddcc53b933e6f093524a492899393b423ca561905eb98cc` |

The package is private upstream, so Aldunis vendors its built JavaScript and
declaration exports instead of using a filesystem path or an unpublished
registry version. The two protobuf files are an intentionally minimal,
wire-compatible snapshot of the upstream definitions used by the projection:

- `sekai`: `GetActionInstance`, `ListActionInstances`, and `ListActionEffects`;
- `chisei`: `GetOperationReceipt` and `GetSampleObservation`.

The snapshot keeps upstream field numbers and snake-case wire names. It must be
refreshed in the same PR as an SDK version change or any upstream change to one
of these messages or methods. The source commit and full-file digests above
are the review anchors; the local snapshot is not an independent protocol.

## Host behavior

`server/chisei-client.ts` uses the SDK's raw RPC escape hatch because these are
projection reads rather than the SDK's core-loop workflow helpers. The SDK
still owns gRPC transport construction, bearer metadata, principal/namespace
metadata, deadlines, cancellation/error normalization, and the contract root.
The host adds only the allowlisted projection mapping and bounded validation.
The client target is `ALDUNIS_CHISEI_ENDPOINT`, or hosted
`ALDUNIS_MANAGED_SHIKIGAMI_GOVERNANCE_ENDPOINT` when that explicit endpoint is
unset.

The host sends the fixed server-owned principal `aldunis-code`, the persisted
project namespace, and the server-side `ALDUNIS_CHISEI_TOKEN`, or `SEKAI_TOKEN`
when that Chisei token is unset. It deliberately
does not send `x-sekai-capability` for these direct read RPCs: that metadata
would turn a read into a catalog-attributed invocation rather than preserve the
existing projection contract. Operation receipt reads carry the queried
operation ID as SDK correlation metadata and request data.

## Compatibility matrix

| Surface | Host request | Projection guarantee | Deterministic evidence |
| --- | --- | --- | --- |
| Action list | `sekai.ListActionInstances` | bounded IDs/status/timestamps; namespace equality | configured success, namespace drift, timestamp bounds, stale fallback |
| Action detail | `sekai.GetActionInstance` + `sekai.ListActionEffects` | effects are joined only to the selected Action and operation | identity, effect bounds, denied Action short-circuit |
| Operation receipt | `chisei.GetOperationReceipt` | complete/missing surfaces/event count only | operation correlation and raw receipt redaction |
| Observation readback | `chisei.GetSampleObservation` | digest/state/timestamps only | namespace/request identity and explicit absence |
| Transport boundary | SDK `GrpcTransport` | loopback HTTP, HTTPS, or operator-opted in-cluster HTTP via `SEKAI_ALLOW_PLAINTEXT=1`; credentials remain host-side | endpoint validation and vendored proto-load smoke test |

Live authenticated gRPC/provider verification is not part of the deterministic
suite; it requires a configured Chisei service and credentials. The host
surfaces unavailable, unauthorized, incompatible, not-found, and stale states
without treating any projection as Chisei authority.
