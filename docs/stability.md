# Stability and consumer contract

`asset-tooling` is being stabilized as reusable infrastructure. New generator and processor features should not widen the public contract until the existing contract has been proven by real consumers.

## Published schemas

The following schema files are published compatibility contracts and are immutable byte-for-byte:

- `asset-spec-v1.schema.json`
- `generation-receipt-v1.schema.json`
- `generation-receipt-v2.schema.json`
- `processing-handoff-v1.schema.json`
- `processing-receipt-v1.schema.json`
- `processing-receipt-v2.schema.json`

A published schema is never strengthened or relaxed in place. Any incompatible or semantically stronger contract requires a new schema version and explicit migration evidence. `test/public-contract.test.js` pins the Git blob identity of every published schema so accidental edits fail deterministically.

## CLI contract

The stable commands are:

- `validate`
- `generate`
- `verify`
- `processing-input`
- `fingerprint`

Exit codes are part of the consumer contract:

- `0`: the requested operation completed successfully;
- `1`: execution failed, verification is broken, or reproducibility drift was detected;
- `2`: CLI usage or command selection is invalid.

Machine-readable command output remains canonical JSON for successful operations. Human-readable diagnostics are written to stderr.

## Programmatic API

The root package export intentionally contains only the high-level reusable operations:

- `validateSpec`
- `generateAsset`
- `verifyAsset`
- `prepareProcessingHandoff`

Internal backend, adapter, cache, hashing, receipt-construction, and environment helpers are not public API merely because their source files exist. Versioned JSON schemas are separately exported for consumers that validate persisted contracts.

## Package readiness

`bun run package:check` verifies the publishable package shape without publishing anything. It is a required coding-tooling capability and runs as part of `bun run check` on every supported CI operating system.

The package remains on the `0.x` line while consumer proof is incomplete. A `1.0.0` release requires all stabilization gates below to hold on an exact accepted head.

## Cache boundary

Generation may reuse local content-addressed build artifacts, but cache state is disposable and never becomes reproducibility evidence. Declared inputs/models are hash-checked before lookup, the build key includes the current spec/tool/generator/environment identity, and cached output bytes are verified against their own SHA-256 before reuse.

`verify` deliberately bypasses the generation cache and replays the authoritative backend. Corrupted cache state therefore fails cached generation without contaminating verification of an otherwise valid accepted artifact. See `cache.md`.

## Stabilization gates

1. Published schemas, CLI exit semantics, and the root programmatic API are protected by deterministic compatibility tests.
2. The package shape is consumable and validated without network access or publication.
3. Content-addressed reuse is implemented without allowing stale or unverified artifacts to bypass declared-input, environment, or receipt checks.
4. Clean-room and fault-injection tests cover corrupted artifacts/receipts/cache entries, missing dependencies, environment drift, reserved-path escapes, and repeated/idempotent operation.
5. One zoo-game asset and one medieval/RTS asset consume the tool through the public contract rather than repository internals.
6. Additional abstractions are extracted only when both consumers demonstrate the same need.
7. `bun run check`, processing-contract validation, coding-tooling standard validation, and hosted cross-platform CI all succeed on the exact release head.

## Ownership boundary

`asset-tooling` owns reproducible asset-build intent, provenance, validation, handoff, local content-addressed reuse, and replay evidence. Domain repositories continue to own generation and processing algorithms. Consumer repositories own runtime/game semantics. Stabilization must not blur those boundaries merely to make integration easier.
