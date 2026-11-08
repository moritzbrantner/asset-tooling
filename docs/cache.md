# Content-addressed generation cache

Generation can be expensive, but cache reuse must never become a substitute for provenance or replay verification.

## Layout

The cache is local, disposable build state under `.asset-tooling/cache/v1/` and has two layers:

```text
.asset-tooling/cache/v1/
  builds/<build-key>.json
  blobs/<output-sha256>
```

A build index maps one fully declared build identity to an accepted prior output hash and its normalized generator observations. Output bytes are stored separately under their own SHA-256 identity.

This separation is deliberate. A seeded or otherwise identical-looking model invocation is not assumed to reproduce the same bytes. Multiple different outputs can exist as independent blobs without changing their content identity.

## Build identity

The v1 build key hashes canonical JSON containing:

- the complete canonical asset-spec SHA-256;
- the `asset-tooling` tool identity: the whole `src/**/*.ts` tree fingerprint, or, for a backend that names its cache sources, the fingerprint of those files only (below);
- normalized generator identity and backend kind;
- the execution-environment SHA-256: the full fingerprint, or, for a backend that names its cache sources, the hash of its platform and environment components only.

Declared inputs and model bundles are therefore part of the identity through the spec hash, and their bytes are still verified against the declared hashes before any cache lookup.

A change to the spec, the files that determine the backend's output, generator identity, or declared environment components produces a different build key instead of reusing stale evidence.

### Scoped key for `external.blender.script@1`

A Blender step's output is determined by its spec (the recipe script and every input it loads are declared spec inputs with SHA-256 pins), by the pinned Blender binary and its Python (environment components the runner probes, with the runner's own hash), and by the few package files that turn the spec into a Blender run. The backend names those files in `BLENDER_SCRIPT_CACHE_SOURCES` ([`src/blender-script-backend.ts`](../src/blender-script-backend.ts)):

- `src/blender-script-backend.ts` and what it runs: `src/process-adapter.ts`, `src/canonical.ts` and `adapters/blender/script_runner.py`;
- `src/schema.ts`, which parses and canonicalizes the spec;
- `src/backend-contract.ts`, which normalizes the generation result.

Its key hashes those files (`sha256-files-v1`) instead of every `src/**/*.ts` (`sha256-tree-v1`), and the platform and components of the environment instead of the full fingerprint, which also names the Bun or Node runtime that only launches Blender. An edit to an unrelated module or a Bun update therefore keeps every Blender entry, while an edit to a listed file, a recipe, a declared input or the Blender pin misses. `test/generation-cache-key.test.ts` keeps the list a superset of the backend's source closure (`scripts/source-closure.ts`), so a new import cannot be left out silently.

This stays safe because the cache is not evidence: a hit is still verified against its blob's SHA-256 (below), the receipt still records the whole-tree tool identity and the full environment, and `verify` replays Blender and compares bytes, never reading the cache. A wrong scoped list could make `generate` reuse a stale output; it could not make `verify` accept one. Other backends keep the whole-tree identity and the full environment.

## Shared cache directory

By default the cache lives next to each spec, under `<spec directory>/.asset-tooling/cache/v1/`. A build that writes its specs into throwaway workspaces (the Ranger, the kits) instead names one shared directory: `generateAsset(spec, { cacheDirectory })`, or `ASSET_TOOLING_GENERATION_CACHE_DIR` (an absolute path) for every `generateAsset` of the process. Entries then live under `<directory>/v1/builds/` and `<directory>/v1/blobs/` with the same contract; blobs and indexes are written through a temporary file and renamed, so concurrent steps never read a partial entry.

`bun scripts/publish-release.ts build`, `scripts/build-ranger-release.ts` and `scripts/build-ranger-character.ts` (`--cache-dir`) select the shared directory, by default the repository's `.asset-tooling/cache`, so a repeated local build reuses every unchanged Blender step. The Ranger build logs how many generation steps it reused and ran.

The Publish rolling releases workflow restores that directory for every Blender release with `actions/cache` (key: release, Blender pin, the scoped-source fingerprint from `bun scripts/generation-cache.ts key`, and a hash of the entries; restore prefix without the last part, so a partial hit reuses every unchanged step). Before saving it runs `bun scripts/generation-cache.ts prune <directory> --since <build start>`: a hit touches its build index or operation entry, so the prune keeps exactly the entries the build read or wrote and the blobs they name. The directory holds the `generateAsset` outputs (Blender step GLBs) and, for the Ranger build, its operation result entries with their output blobs ([below](#shared-operation-result-entries)); the rest of the object store under `--out` is not cached.

## Read contract

A cache hit is accepted only when all of the following hold:

1. declared input/model bytes match the current spec;
2. the build index is valid JSON with the exact v1 shape;
3. the stored build identity exactly matches the current identity;
4. the referenced blob exists;
5. hashing the blob produces exactly the SHA-256 named by the index;
6. cached observations still satisfy the normal generation-result contract.

Malformed indexes, missing blobs, hash mismatches, and symbolic-link escapes fail closed. They do not silently fall back to regeneration because that would hide corrupted local evidence.

## Write contract

On a cache miss the authoritative backend runs normally. Its normalized output is stored by output SHA-256, then the build index records the mapping from build identity to that content hash and the backend observations.

The accepted output and generation receipt are still reconciled through the normal idempotent mutation path. The cache namespace is reserved and cannot be used by asset outputs, receipts, declared inputs, or model paths.

## Verification boundary

`verify` never reads generation-cache entries. It replays the authoritative backend and compares the regenerated bytes and observations with the accepted receipt. A corrupt cache can therefore make a future cached `generate` fail while `verify` of an otherwise valid accepted artifact still succeeds.

Cache reuse is an optimization and an idempotence mechanism. It is not evidence of exact reproducibility.

## Operation result entries

`runAssetOperation(...)` from `asset-tooling/operations/store` keeps a second kind of entry in the same disposable namespace:

```text
.asset-tooling/cache/v1/
  operations/<operation-cache-key>.json
```

The key is `createAssetOperationCacheKey(...)` of the operation build identity (operation id@version, implementation/tool identity, canonical parameters and validated input `AssetRef`s). There is no second identity scheme. The entry records that build identity, the normalized `AssetOperationResult` and the SHA-256 of the result's canonical JSON. Output bytes are not copied into the cache; they stay in `.asset-tooling/objects/v1` under their own content identity.

The runner follows the same read contract as generation entries:

1. every input object is verified (SHA-256 and byte length) before the lookup, so a missing or tampered input rejects before any lookup or execution;
2. a missing entry is a miss and executes the operation;
3. an entry that is not valid JSON, has an unexpected shape, records a different key or build identity, or fails its result hash rejects;
4. on a hit every recorded output object is verified in the object store, and a missing or tampered object rejects;
5. a hit returns the recorded result unchanged, including recorded observations such as an `approximate` reproducibility label, and never calls the executor.

Rejections name the entry and do not silently re-execute, as for generation entries. Deleting `.asset-tooling/cache` is always safe: the next run is a verified miss.

The entry is acceleration state, not provenance evidence. `verify` does not read it.

### Shared operation result entries

`runAssetOperation(root, registration, invocation, { cacheDirectory })` keeps the entry in a shared cache directory (absolute) instead, `<directory>/v1/operations/<operation-cache-key>.json`, with the same key, shape and read contract. Since the object store under `root` may be a fresh one, a miss also puts every verified output object into `<directory>/v1/blobs/<sha256>`, the blob namespace the generation entries use (a hard link when both are on one file system, otherwise a copy). On a hit, each output object missing from `root` is restored from its blob, which must have the recorded SHA-256 and byte length; a missing or mismatched blob rejects the entry like a tampered output object. A hit touches the entry, and `bun scripts/generation-cache.ts prune` keeps the entries a build used and the blobs their outputs name.

The Ranger build ([`scripts/cached-operations.ts`](../scripts/cached-operations.ts), [docs/humanoid-ranger.md](humanoid-ranger.md#reproducibility)) runs its import, subset, compose, extract, embed, retarget, image codec and texture-resize operations this way with the build's shared directory. Its implementation identity is scoped like the Blender key: the operation module's source closure (`scripts/source-closure.ts`, hashed as `sha256-files-v1`), `bun.lock`, and the external tools it runs (FFmpeg and FFprobe versions; the processor repository, revision and cargo/rustc versions), instead of every `src/**/*.ts`. `test/ranger-operation-cache.test.ts` covers a hit in a fresh store, misses on other inputs and parameters, a tampered blob or entry, and the prune.
