# Stability, consumer, and processor contracts

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

Internal backend, adapter, cache, hashing, receipt-construction, and environment helpers are not public API merely because their source files exist. Versioned JSON schemas are separately exported for consumers that validate persisted contracts. Additive operation APIs remain on focused `./operations/*` subpaths while Milestone A proves their shape.

## Package readiness

`bun run package:check` verifies the publishable package shape without publishing anything. `bun run stability:check` composes the local test, package, CLI fixture, accepted-consumer-manifest, and accepted-processor-manifest gates. In `.coding-tooling.json`, that repository-specific command is mapped to the shared semantic integration-test capability rather than introducing an asset-specific capability into coding-tooling.

The package remains `0.1.0` until a stable release is intentionally cut. Completing stabilization makes a stable release eligible; it does not publish, tag, or claim a new package version automatically.

## Cache and object-store boundary

Generation may reuse local content-addressed build artifacts, but cache state is disposable and never becomes reproducibility evidence. Declared inputs/models are hash-checked before lookup, the build key includes the current spec/tool/generator/environment identity, and cached output bytes are verified against their own SHA-256 before reuse.

`verify` deliberately bypasses the generation cache and replays the authoritative backend. Corrupted cache state therefore fails cached generation without contaminating verification of an otherwise valid accepted artifact. See `cache.md`.

Milestone A also provides a content-addressed intermediate object store. It resolves an `AssetRef` only after checking byte length and SHA-256 and remains reusable storage rather than provenance. Generation and processing receipts continue to explain how accepted artifacts were produced.

## Accepted consumer evidence

`stability/consumers.json` is the machine-readable consumer acceptance manifest. It pins merged Zoo and Medieval commits together with the exact committed asset spec and asset ID used to prove the public CLI/spec contract.

The hosted `Stability` workflow does not trust those consumers merely because they previously passed. For every current `asset-tooling` pull request and main commit it loads the exact accepted commits, checks out current asset-tooling plus each consumer independently, then validates, generates, and replay-verifies every accepted consumer spec.

This makes consumer compatibility a continuing regression gate instead of a one-time dogfood note. The first two integrations did not demonstrate a missing common wrapper or consumer abstraction, so stabilization intentionally added none solely because there were multiple consumers.

## Accepted processor evidence

`stability/processors.json` is separate because a processor is not a consumer. It identifies an authoritative external implementation used to prove an asset operation while leaving that algorithm in its domain repository.

The first accepted processor is the exact `moritzbrantner/3d-lab` revision containing the `three-d-lod` `mesh.simplify` adapter. Its processor probe reports the algorithm, process protocol, mesh codec, direct dependency versions, and the resolved Cargo lock used to build the adapter. Asset-tooling combines that probe with the exact source repository/revision in operation implementation identity; machine-local checkout and Cargo paths remain execution details.

For every current `asset-tooling` pull request and main commit, the hosted Stability workflow:

1. validates the processor manifest locally;
2. checks out the exact accepted processor revision;
3. builds/invokes that processor through its declared process-adapter boundary;
4. feeds it a content-addressed deterministic mesh input;
5. executes `mesh.simplify` twice and requires stable output identity and observations;
6. checks receipt-compatible triangle/error invariants and source-vertex preservation;
7. resolves the returned output through the asset object store to re-verify its content identity.

A local fixture processor remains useful for fast adapter plumbing tests, but it does not satisfy external processor acceptance. Only the exact external processor job proves the cross-repository ownership boundary.

## Stabilization gates

1. Published schemas, CLI exit semantics, and the root programmatic API are protected by deterministic compatibility tests.
2. The package shape is consumable and validated without publication.
3. Content-addressed reuse cannot allow stale or unverified artifacts to bypass declared-input, environment, receipt, or object-content checks.
4. Clean-room and fault-injection tests cover corrupted artifacts/receipts/cache entries, missing dependencies, environment drift, reserved-path escapes, and repeated/idempotent operation.
5. Merged Zoo and Medieval assets consume the public contract rather than repository internals.
6. Accepted external processors remain pinned by exact repository revision and are exercised through their real integration boundary rather than copied into asset-tooling.
7. Shared abstractions are introduced only when multiple consumers or implementations demonstrate the same missing responsibility.
8. The exact release candidate must have local `stability:check`, hosted current-head consumer and processor contracts, existing processing-contract validation, and Ubuntu/macOS/Windows Validate jobs green together.

## Ownership boundary

`asset-tooling` owns reproducible asset-build intent, operation envelopes, provenance, validation, handoff, local content-addressed reuse, and replay evidence. Domain repositories continue to own generation and processing algorithms. Consumer repositories own runtime/game semantics. Stabilization must not blur those boundaries merely to make integration easier.
