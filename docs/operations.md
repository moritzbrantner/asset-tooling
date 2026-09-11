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

The descriptor does not contain an executor. The same descriptor can therefore be projected into an editor node template and paired with an execution registration without coupling either generic workflow repository to asset-tooling.

## Operation registry

`createAssetOperationRegistry(...)` validates descriptors at registration time, rejects duplicate `id@version` pairs, and returns a deterministic sorted catalog. The registry is deliberately about operation contracts, not scheduling or discovery over a network.

## Invocation validation

`normalizeAssetOperationInputs(...)` checks:

- unknown or missing ports;
- single/many/bounded value cardinality;
- asset kind compatibility;
- media-type compatibility;
- valid content-addressed `AssetRef` values.

`normalizeAssetOperationResult(...)` applies the same output-port contract and accepts deterministic JSON observations. Receipts remain separate because current generation and processing receipts have stronger domain-specific evidence rules that must not be flattened prematurely.

## Build/cache identity

`createAssetOperationBuildIdentity(...)` materializes the operation identity, implementation identity, parameters, and validated input references. `createAssetOperationCacheKey(...)` hashes its canonical JSON representation.

This follows the repository's existing rule that caching is acceleration rather than provenance. A matching operation cache key may permit reuse only after the referenced content is verified; it never proves that an operation was executed or that replay would reproduce the same bytes.

Implementation identity is deliberately extensible. An adapter can include output-affecting revision, model, dependency, runtime, algorithm, protocol, and codec identity in addition to the required implementation `id` and `version`.

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

The focused `asset-tooling/operations/generation` subpath exposes the first real generator operation: `procedural.svg.scatter@1`.

The adapter deliberately reuses the existing `builtin.procedural.svg-scatter@1` backend rather than copying its algorithm. The workflow-facing invocation makes `seed` an explicit operation parameter so it participates in build identity, then projects it back to the existing asset-spec shape as `randomness.seed`. All other generator parameters retain the backend's existing validation and semantics.

The operation produces a storage-neutral `vector-image` `AssetRef` with media type `image/svg+xml`; its bytes are written through the content-addressed object store. Operation observations are the backend's existing deterministic generation observations rather than a second evidence vocabulary.

Implementation identity includes the concrete backend identity and the current asset-tooling source fingerprint. This ensures the operation build identity does not treat changed built-in implementation code as equivalent merely because the backend's human-facing version string was not updated.

Parity tests execute the operation path and the existing `generateAsset(...)` path with the same seed and parameters and require identical output bytes, SHA-256, and generation observations. The existing generation path still owns accepted output mutation and generation receipts; the operation adapter does not alter those contracts.

## Processor adapter proof

The focused `asset-tooling/operations/processing` subpath exposes `mesh.simplify@1` as the first external processor operation.

`three-d-lod` in `moritzbrantner/3d-lab` remains authoritative for simplification semantics. `asset-tooling` does not copy meshopt, mesh validation, or geometry logic. The adapter accepts one stored mesh `AssetRef` using the narrow `application/vnd.moritzbrantner.three-d.mesh+json` integration media type, verifies the referenced bytes before execution, and passes only the object-store path into the external process protocol.

The processor returns new mesh bytes plus observations compatible with the existing processing receipt vocabulary: source/requested/result triangle counts, result index count, relative error, source vertex count, and source-vertex-buffer preservation. `asset-tooling` validates the cross-field invariants before accepting the result, then stores the derived mesh as another content-addressed `AssetRef`.

External processor identity is semantic rather than path-based. It includes:

- exact source repository and Git commit;
- processor id/version and algorithm identity;
- process-adapter protocol and mesh codec;
- output-affecting dependency evidence reported by the processor, including the resolved Cargo lock used to build the adapter;
- the current asset-tooling source fingerprint.

Machine-local checkout, manifest, Cargo home, and temporary paths are execution details and do not enter build identity. A different dependency resolution appears in the probe and therefore changes operation identity rather than being silently reused.

`stability/processors.json` pins the exact accepted `3d-lab` revision. The hosted Stability workflow checks out that revision and runs a real deterministic grid mesh through `mesh.simplify@1` twice. It requires stable output identity, valid receipt-compatible observations, preserved source vertices, and resolvable output bytes. Local fixture processors test plumbing only and are not accepted as proof of the external processor boundary.

The existing published `processing-receipt-v1/v2` schemas remain unchanged. Operation results are runtime composition values; processing receipts remain the stronger provenance/replay evidence for accepted production processing.

## Workflow bridge

The focused `asset-tooling/operations/workflow` subpath projects operation descriptors into the existing workflow contracts. This direction is intentional: `workflow-editor` and `workflow-runner` remain generic and do not import asset-tooling.

`createAssetOperationWorkflowNodeTemplate(...)` derives a workflow-editor template directly from one normalized `AssetOperationDescriptor`. The template stores only the selected operation id/version and editable parameter values in node data. The parameter schema itself remains on the descriptor and is not copied into every editable/compiled node.

Asset ports are projected into structural workflow types:

- `AssetRef.schemaVersion` becomes the literal `1`;
- concrete asset kinds and concrete media types become literal or union workflow types;
- SHA-256 and byte length become string/number properties;
- metadata remains structurally an object;
- asset `many` or bounded cardinality becomes an array-valued workflow port.

Asset value cardinality is deliberately not mapped to workflow-editor connection cardinality. Those are different concepts: one constrains the number of `AssetRef` values supplied to an operation, while the other constrains the number of graph edges attached to a port.

Some asset constraints cannot be represented exactly by the current generic workflow type vocabulary. In particular, media families such as `image/*` are broader than literal strings, and two bounded asset arrays may have different allowed lengths even though both are workflow arrays. The derived editor ports therefore also retain exact asset kind, media-family, and value-cardinality constraints in editor-only `assetOperationPort` metadata.

`createAssetOperationWorkflowConnectionValidator(...)` composes workflow-editor's normal type/cardinality validator with these exact asset constraints. It preserves family assignability such as `image/png -> image/*`, rejects incompatible families such as `audio/* -> image/*`, and rejects source value-cardinality ranges that are not a subset of the target range. If only one endpoint carries asset-port metadata, the asset-aware validator fails closed instead of assuming an unproven asset contract. The compiler remains execution-neutral; runtime operation validation independently enforces the same asset contract before execution.

`createAssetOperationWorkflowExecutor(...)` produces one workflow-runner-compatible executor for node kind `asset.operation`. Execution registrations pair a descriptor with its executor function, so operation id/version metadata is not manually duplicated in a second dispatch table. Compiled node data selects the registered operation; runner inputs become the operation inputs; the normalized operation outputs are returned to the graph.

Full operation observations do not become hidden or synthetic graph outputs. An optional `onOperationResult` hook receives a detached canonical copy of the complete normalized result as external execution evidence, so an observer cannot mutate the already-validated graph output. A host can use that evidence for an execution overlay, provenance panel, logging, or receipt workflow without mutating the editable document.

`stability/workflow-stack.json` pins exact accepted workflow-editor and workflow-runner revisions. The hosted Stability proof uses the real editor type system/compiler and the real runner to require that:

1. concrete incompatible asset types are rejected;
2. wildcard media-family compatibility remains enforced by the asset-aware authoring validator rather than being lost when the structural workflow type must be broader;
3. operation identity and parameters survive compilation into `@moritzbrantner/workflow/compiled` v1;
4. the generic runner dispatch executes `procedural.svg.scatter@1` and returns a resolvable object-store asset;
5. `mesh.simplify@1` also runs through the same generic executor shape;
6. observations are captured externally rather than appearing in workflow graph outputs.

The bridge proof uses the local mesh processor fixture only to test workflow plumbing. The separate accepted-processor Stability job remains authoritative for the actual `three-d-lod` algorithm boundary.

## Current status

The operation contract is now proven in three directions: an existing generator, a current external processor, and the generic workflow authoring/execution stack all consume the same `AssetOperationDescriptor`/`AssetRef` model without moving algorithm or workflow ownership into the operation layer.

The runtime operation contract is exposed through `asset-tooling/operations`, content-addressed intermediate storage through `asset-tooling/operations/store`, generator adapters through `asset-tooling/operations/generation`, processor adapters through `asset-tooling/operations/processing`, and the workflow projection through `asset-tooling/operations/workflow`, while the deliberately small package root remains unchanged.

The next useful expansion is no longer another orchestration abstraction. Add compatible transform/composition operations and then build the first genuinely multi-node asset workflow; model-backed generation and the remaining processing adapters can use the same operation/runner boundary. Immutable schemas should still be published only when we intentionally decide the runtime contract has enough representative consumers.
