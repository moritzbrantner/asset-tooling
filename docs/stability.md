# Stability and consumer contract

`asset-tooling` is reusable infrastructure. Its first stabilization milestone proves the existing contract before further generator or processor surface is added.

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

`bun run package:check` verifies the publishable package shape without publishing anything. `bun run stability:check` composes the local test, package, CLI fixture, and accepted-consumer-manifest gates and is exposed as the repository's standard coding-tooling capability.

The package remains `0.1.0` until a stable release is intentionally cut. Completing stabilization makes a stable release eligible; it does not publish, tag, or claim a new package version automatically.

## Cache boundary

Generation may reuse local content-addressed build artifacts, but cache state is disposable and never becomes reproducibility evidence. Declared inputs/models are hash-checked before lookup, the build key includes the current spec/tool/generator/environment identity, and cached output bytes are verified against their own SHA-256 before reuse.

`verify` deliberately bypasses the generation cache and replays the authoritative backend. Corrupted cache state therefore fails cached generation without contaminating verification of an otherwise valid accepted artifact. See `cache.md`.

## Accepted consumer evidence

`stability/consumers.json` is the machine-readable acceptance manifest. It pins one merged Zoo commit and one merged Medieval commit together with the exact committed asset spec and asset ID used to prove the contract.

The hosted `Stability` workflow does not trust those consumers merely because they previously passed. For every current `asset-tooling` pull request and main commit it:

1. validates the local stability contract;
2. loads the exact accepted consumer commits from the manifest;
3. checks out the current `asset-tooling` head and each accepted consumer independently;
4. validates, generates, and replay-verifies each consumer spec with the current tool head.

This makes consumer compatibility a continuing regression gate instead of a one-time dogfood note.

The two integrations did not demonstrate a missing common wrapper or consumer abstraction. Both successfully use the same asset spec plus public CLI boundary, so stabilization intentionally adds no new abstraction solely because there are now two consumers.

## Stabilization gates

1. Published schemas, CLI exit semantics, and the root programmatic API are protected by deterministic compatibility tests.
2. The package shape is consumable and validated without publication.
3. Content-addressed reuse cannot allow stale or unverified artifacts to bypass declared-input, environment, or receipt checks.
4. Clean-room and fault-injection tests cover corrupted artifacts/receipts/cache entries, missing dependencies, environment drift, reserved-path escapes, and repeated/idempotent operation.
5. A merged Zoo asset and a merged Medieval asset consume the public contract rather than repository internals.
6. Shared abstractions are introduced only when multiple consumers demonstrate the same missing responsibility; the first two consumers required none.
7. The exact release candidate must have the local `stability:check`, hosted current-head consumer matrix, existing processing-contract validation, and Ubuntu/macOS/Windows Validate jobs green together.

## Ownership boundary

`asset-tooling` owns reproducible asset-build intent, provenance, validation, handoff, local content-addressed reuse, and replay evidence. Domain repositories continue to own generation and processing algorithms. Consumer repositories own runtime/game semantics. Stabilization must not blur those boundaries merely to make integration easier.
