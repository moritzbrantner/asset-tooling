# Consuming canonical Git LFS assets

Canonical third-party payloads are stored durably in the `asset-tooling` repository under `assets/canonical/`, while `catalog/providers.json`, `catalog/sources.json`, and `catalog/storage.json` remain the reviewable authority for provider policy, provenance, exact content identity, and canonical paths.

Consumers use the focused `asset-tooling/catalog/storage` subpath. They do not infer an `assets/canonical/...` path themselves and they do not treat a Git LFS pointer as content.

## Boundary

The normal consumer flow is:

```text
asset-tooling checkout with Git LFS hydrated
  -> resolve catalog source through catalog/storage.json
  -> reject missing, pointer-only, symlinked, or drifted payloads
  -> verify hydrated SHA-256 + byte length
  -> import exact bytes into the consumer's disposable .asset-tooling/objects store
  -> receive the existing provenance-bearing AssetRef
  -> run typed asset operations
```

`readAssetCatalogStorageSource(...)` is useful when a consumer needs the verified source bytes directly. `importAssetCatalogStorageSource(...)` is preferred before asset operations because it reuses the existing content-addressed object-store boundary and preserves catalog provenance in `AssetRef.metadata.catalog`.

The durable asset checkout and disposable consumer store may use different roots. This allows CI or local tooling to check out `asset-tooling` once with LFS hydration while each consumer keeps its own `.asset-tooling/objects` state.

Repeated imports are idempotent. If the same verified content is already in the consumer object store, import returns `status: "unchanged"` with the same `AssetRef` rather than rewriting it.

## Failure behavior

Consumption fails closed when:

- the source is not present in `catalog/storage.json`;
- the source is no longer shared/license-accepted/content-pinned;
- the canonical file is missing;
- checkout contains only the Git LFS pointer rather than hydrated bytes;
- the hydrated bytes do not match the source SHA-256 or byte length;
- a path below the durable storage root is a symbolic link.

Consumption never performs network acquisition. Missing LFS content is a checkout/deployment problem, not permission for the consumer to fetch the upstream provider directly.

## Ownership

Git LFS owns durable binary transport. The catalog owns identity, licensing, provenance, and the accepted byte pin. `.asset-tooling/objects` remains disposable local materialization. Domain repositories continue to own mesh, animation, image, audio, video, and other transformation semantics.
