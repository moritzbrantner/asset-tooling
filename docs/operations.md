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

## Current status

The runtime contract is exposed through the focused `asset-tooling/operations` package subpath while the deliberately small package root remains unchanged.

Do not publish immutable JSON schemas for these new runtime values yet. First prove the shape through:

1. one existing generation backend adapter;
2. one existing processing adapter;
3. a workflow-editor/workflow-runner reference path.

After those consumers validate the semantics, publish versioned schemas without changing already-published generation or processing schemas.
