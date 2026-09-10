# Unified asset operations

Milestone A introduces a runtime-neutral operation vocabulary for asset work without replacing the existing generation and processing contracts.

## Ownership

`asset-tooling` owns the operation envelope:

- typed asset references;
- typed input/output ports;
- operation identity and parameter description;
- implementation/build identity;
- deterministic input/result validation;
- content-addressed cache/build keys;
- content-addressed intermediate asset resolution;
- adapters that invoke authoritative generators/processors;
- provenance and replay evidence at the existing generation/processing boundaries.

The authoritative algorithm stays with its owner. A generator backend remains responsible for generation semantics. A mesh, image, audio, video, or model implementation remains responsible for its algorithm. `asset-tooling` must not duplicate those implementations simply to make them available as workflow nodes.

Workflow authoring and DAG structure belong to `workflow-editor`. Execution ordering, retries, cancellation, and executor dispatch belong to `workflow-runner`. Scheduling, persistence, queues, and distributed orchestration remain outside this repository.

## `AssetRef` v1

An asset reference describes a validated asset value without embedding storage or machine-local path details:

```js
{
  schemaVersion: 1,
  kind: "image",
  mediaType: "image/png",
  sha256: "...",
  byteLength: 1234,
  metadata: {
    width: 512,
    height: 512,
  },
}
```

The SHA-256 is the content identity. `kind`, media type, byte length, and deterministic metadata make the reference suitable for typed operation ports and validation. Storage resolution is intentionally separate so a portable workflow/build identity does not depend on an absolute path, host, or cache location.

## `AssetOperationDescriptor` v1

An operation descriptor is serializable metadata describing what an operation accepts and produces:

```js
{
  schemaVersion: 1,
  id: "image.blur.gaussian",
  version: "1",
  label: "Gaussian blur",
  category: "image.filter",
  inputs: [
    {
      id: "source",
      assetKinds: ["image"],
      mediaTypes: ["image/png"],
      cardinality: "single",
      required: true,
    },
  ],
  outputs: [
    {
      id: "output",
      assetKinds: ["image"],
      mediaTypes: ["image/png"],
    },
  ],
  parameterSchema: {
    type: "object",
    properties: {
      radius: { type: "integer", minimum: 1 },
    },
  },
}
```

The descriptor does not contain an executor. It can therefore later be converted into a workflow-editor node template without coupling the editor to an implementation runtime.

## Operation registry

`createAssetOperationRegistry(...)` validates descriptors at registration time, rejects duplicate `id@version` pairs, and returns a deterministic sorted catalog. The registry is deliberately about operation contracts, not scheduling or discovery over a network.

## Invocation validation

`normalizeAssetOperationInputs(...)` checks:

- unknown or missing ports;
- single/many/bounded cardinality;
- asset kind compatibility;
- media-type compatibility;
- valid content-addressed `AssetRef` values.

`normalizeAssetOperationResult(...)` applies the same output-port contract and accepts deterministic JSON observations. Receipts remain separate because current generation and processing receipts have stronger domain-specific evidence rules that must not be flattened prematurely.

## Build/cache identity

`createAssetOperationBuildIdentity(...)` materializes the operation identity, implementation identity, parameters, and validated input references. `createAssetOperationCacheKey(...)` hashes its canonical JSON representation.

This follows the repository's existing rule that caching is acceleration rather than provenance. A matching operation cache key may permit reuse only after the referenced content is verified; it never proves that an operation was executed or that replay would reproduce the same bytes.

Implementation identity is deliberately extensible. An adapter can include output-affecting revision, model, dependency, runtime, or algorithm identity in addition to the required implementation `id` and `version`.

## Content-addressed intermediate objects

The focused `asset-tooling/operations/store` subpath stores intermediate output bytes independently of workflow documents and receipts.

`createAssetRefFromBytes(...)` derives an `AssetRef` directly from bytes. `storeAssetObject(...)` writes those bytes to a SHA-256-addressed object path under `.asset-tooling/objects/v1`, and `resolveAssetObject(...)` resolves an `AssetRef` back to bytes only after verifying both byte length and SHA-256.

The store follows four rules:

1. `AssetRef` stays storage-neutral; machine-local object paths never enter workflow/build identity.
2. Repeated writes of the same bytes are idempotent and return `unchanged`.
3. Existing corrupt content fails closed rather than being silently overwritten and treated as trusted reuse.
4. `.asset-tooling/objects` is tool-owned and cannot be claimed by asset outputs, receipts, declared inputs, or model paths; symbolic-link escapes are rejected.

The object store is not provenance evidence. It is reusable content storage. Generation/processing receipts remain responsible for explaining how bytes were produced and for carrying replay evidence.

## Generation adapter proof

The focused `asset-tooling/operations/generation` subpath now exposes the first real generator operation: `procedural.svg.scatter@1`.

The adapter deliberately reuses the existing `builtin.procedural.svg-scatter@1` backend rather than copying its algorithm. The workflow-facing invocation makes `seed` an explicit operation parameter so it participates in build identity, then projects it back to the existing asset-spec shape as `randomness.seed`. All other generator parameters retain the backend's existing validation and semantics.

The operation produces a storage-neutral `vector-image` `AssetRef` with media type `image/svg+xml`; its bytes are written through the content-addressed object store. Operation observations are the backend's existing deterministic generation observations rather than a second evidence vocabulary.

Implementation identity includes the concrete backend identity and the current asset-tooling source fingerprint. This ensures the operation build identity does not treat changed built-in implementation code as equivalent merely because the backend's human-facing version string was not updated.

Parity tests execute the operation path and the existing `generateAsset(...)` path with the same seed and parameters and require identical output bytes, SHA-256, and generation observations. The existing generation path still owns accepted output mutation and generation receipts; the operation adapter does not alter those contracts.

## Current status

The runtime operation contract is exposed through `asset-tooling/operations`, content-addressed intermediate storage through `asset-tooling/operations/store`, and the first generator adapter through `asset-tooling/operations/generation`, while the deliberately small package root remains unchanged.

Do not publish immutable JSON schemas for these new runtime values yet. The generator side is now proven with one existing backend; next prove the same operation boundary with one existing processor, then exercise the descriptor/executor bridge through workflow-editor/workflow-runner.

After those consumers validate the semantics, publish versioned schemas without changing already-published generation or processing schemas.
