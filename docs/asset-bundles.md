# Selected asset packages

`asset-tooling/operations/bundle` packages an explicitly selected set of existing `AssetRef`s. Stable logical keys and explicit variants map to portable, content-addressed files. Source/processor/license metadata remains on the original refs; packaging creates no replacement asset identity or catalog. Consumer loading and verification use the packaged files without object-store access or acquisition.

The first profile is `static-glb-png-v1`: core static GLBs containing their resources, and standalone PNGs. It reuses the existing glTF Transform/Khronos import policy and parser. Skins, animation, unsupported extensions, external glTF resources, SVG, audio and compressed-format variants are deliberately unsupported in this profile. Their future profiles must follow the relevant owner contracts. PNG transport checks cover content pins, MIME/header and dimensions; pixel decoding remains with the existing image codec/consumer. Packaging does not claim a new full image decoder.

```ts
import {
  STATIC_ASSET_BUNDLE_PROFILE, exportAssetBundle,
  verifyAssetBundle, readAssetBundleAsset,
} from "asset-tooling/operations/bundle";

const invocation = {
  parameters: {
    profile: STATIC_ASSET_BUNDLE_PROFILE,
    assets: [{ key: "tree.broadleaf", variant: "composed" }],
  },
  inputs: { assets: [acceptedTreeRef] },
};
const result = await exportAssetBundle(absoluteAssetRoot, absoluteOutputDirectory, invocation);
const checked = await verifyAssetBundle(absoluteOutputDirectory, result.manifest);
const glb = await readAssetBundleAsset(absoluteOutputDirectory, checked.manifest, "tree.broadleaf", "composed");
```

`createAssetBundleBuildIdentity` and `executeAssetBundleOperation` expose the same existing operation boundary as `asset.bundle@1`. The latter stores the canonical manifest as an `asset-bundle` AssetRef; file export is an explicit additional mutation. Manifest metadata/build observations record the operation, normalized paired inputs/selection, source hashes, authored-tool identity, dependency lock and format-validator versions. There is no new scheduler, package service or generation cache.

## Manifest and selection

The [v1 JSON Schema](../schemas/asset-bundle-v1.schema.json) declares the transport shape. `parseAssetBundleManifest` additionally validates paired-key uniqueness, sorted ordering, compatible source kind/media type, path-to-content identity and total unique byte budget. Each entry has exactly `key`, `variant`, `source` and `path`. The source is the original full AssetRef; the path is `assets/<sha256>.glb` or `.png`.

Selections correspond one-to-one with `inputs.assets` before sorting by invariant key/variant order. Keys/variants are lowercase portable tokens of at most 128 characters. Multiple variants of one key are allowed; a repeated pair is rejected. `resolveAssetBundleEntry` requires the exact pair and diagnoses missing selections instead of falling back to a variant. Identical payloads referenced by several logical entries share one file while retaining each entry's metadata.

Limits are 1–256 selections, 64 MiB per payload, 256 MiB total distinct payload bytes and 8 MiB for the manifest. PNG dimensions are 1–4096 in each axis. These caps are checked before writes; no budget implies permission for hidden dependencies or new processing. The profile validates actual static GLB resources and supported semantics before reuse. It reuses the renderer’s header preflight before validator scans or sparse densification: at most 3 million elements per accessor, 64 MiB of conservative float32 accessor storage, and 1 million distinct POSITION vertices. Protected namespace names are reserved case-insensitively on every platform.

## Export, recovery and verification

The output directory must be a separate descendant of the asset root, outside `.git`, `.asset-tooling` and `assets/canonical`. Existing output/ancestor symlinks and non-regular resource files are rejected. The caller owns the directory and serializes writers through its existing execution machinery.

Every declared source dependency is hash/length verified before export-file lookup. Each existing payload is compared with accepted bytes; equal files are untouched and corrupt files are atomically repaired. New payloads are staged on the same filesystem. The canonical `manifest.json` is atomically replaced only after all selected payloads are complete. An invalid dependency never publishes a partial selection.

Pass the surrounding execution's standard `AbortSignal` to `{ signal }`. Cancellation is checked during dependency preparation, between files and immediately before each rename. Cancellation before the final manifest rename preserves the previous accepted manifest; cancellation after that commit point cannot undo a completed publication. `{ onArtifact }` is an awaited progress callback for the existing caller, not an execution engine. Callback failure also preserves the prior manifest. Resume verifies dependencies and reuses already accepted files.

Former/unreferenced payloads can remain as disposable export state so an in-flight reader holding the old manifest can finish. `result.files` is the complete active distribution allowlist: publish those paths, rather than scan the directory or ship orphaned files. A fresh export contains only its selected closure. No automatic broad deletion or canonical promotion occurs.

Counters distinguish selected refs checked (`assetsVerified`), distinct payload files written/reused (`blobsWritten`/`blobsReused`), actual bytes replaced including the manifest (`bytesWritten`), and `manifestStatus`. They make no claim about upstream generator execution or performance. Warm export rechecks dependencies and can write zero bytes; it does not replace cache-independent verification.

`verifyAssetBundle` requires the expected manifest AssetRef supplied by the build/distribution contract, verifies the manifest pin, then every active payload and static GLB resource policy. It is non-mutating and uses no source store. `readAssetBundleAsset` reads one selected file and checks its pin. Consumers should admit a verified manifest once, then use its exact logical selections. They must not treat an arbitrary downloaded manifest as its own trust anchor or infer private LFS/store paths.

## Actual example

After running the existing tree and effect-artwork examples:

```bash
bun examples/selected-bundle/build.ts
```

The explicit inventories select broadleaf/conifer composed GLBs and two standalone PNG ingredients. The example exports under `.artifacts/selected-bundle/`, verifies all actual packaged bytes, loads both three-mesh trees through offline NodeIO, and compares the manifest against an independent export directory. `export.ref.json` is local handoff evidence; products pin the expected ref through their deliberate distribution contract. No generator or consumer repository is changed by this example.

Focused fixtures independently author triangle GLBs and a PNG. They prove material-only/mesh changes, unchanged-file preservation, duplicate-resource reuse, cold/warm export parity, input/output corruption, missing dependencies, interrupted export/resume and path/symlink rejection. Package-only loading still succeeds after deleting the fixture's source object store. #125 remains open for rigged/clip/outfit and other profiles, broader source-derivation invalidation, and actual game integration; the static profile is its first bounded transport slice.

## Sprite atlas PNG profile

`SPRITE_ATLAS_BUNDLE_PROFILE` selects `sprite-atlas-png-v1` through the same exporter, verification and operation functions. It uses `asset.bundle@2` and the separate immutable [v2 transport schema](../schemas/asset-bundle-v2.schema.json). The original static operation/profile and v1 schema remain compatible. This profile selects existing atlases and encoded PNGs; it neither authors pixels nor evaluates animation.

```ts
import { SPRITE_ATLAS_BUNDLE_PROFILE, exportAssetBundle,
  verifyAssetBundle, readAssetBundleSpriteAtlas } from "asset-tooling/operations/bundle";

const exported = await exportAssetBundle(root, directory, {
  parameters: { profile: SPRITE_ATLAS_BUNDLE_PROFILE,
    assets: [{ key: "reward.ring", variant: "subtle" }] },
  inputs: { assets: [acceptedAtlasManifestRef], images: [acceptedAtlasPngRef] },
});
const checked = await verifyAssetBundle(directory, exported.manifest,
  { profile: SPRITE_ATLAS_BUNDLE_PROFILE });
if (checked.manifest.schemaVersion !== 2) throw new Error("expected atlas package");
const { atlas, image, png } = await readAssetBundleSpriteAtlas(
  directory, checked.manifest, "reward.ring", "subtle");
```

The default two-argument `verifyAssetBundle` and `parseAssetBundleManifest` retain their original static-profile return types and reject atlas transports. Atlas verification explicitly selects the new profile as above; `parseSpriteAtlasBundleManifest` admits its v2 transport separately. Existing typed static callers need no migration.

The paired PNG must record the original canonical atlas image hash, dimensions, PNG codec and sRGB source convention supplied by the existing encoder. Actual PNG header dimensions must match the decoded canonical image. Transport verification checks these declared associations and payload pins; it does not decode PNG pixels or certify an arbitrary producer's assertion. Independent encoder replay/pixel comparison is the producer acceptance proof, as exercised below. No FFmpeg, Blender, generation, source store or acquisition is required for package loading/verification.

Each selected entry retains `key`, `variant`, the **original** atlas `source` and content-addressed `.atlas.json` path, plus `image: { source, path }` naming its separate PNG derivative. Root `resources` contains the original canonical atlas image and every original sprite source as full AssetRefs with `.rgba.json` paths. Original manifests/refs remain byte-for-byte intact, including producer frame indices/times/durations/loop policy, pivots and source/processor/license metadata. Sparse producer frame selection is valid; timing is never inferred from paths. Distinct refs with the same payload retain their metadata while sharing one file. This is the typed atlas resource closure, not an attempt to retrieve every incidental provenance hash from producer metadata.

`parseSpriteAtlasManifest` owns structural admission of the existing original atlas format: exact fields/semantics, sorted unique IDs, source/trim/pivot bounds, non-overlapping footprints including padding/extrusion, unsupported rotation rejection and original frame timing rules. Packaging verifies every referenced canonical image against its source size and content pin before looking up export files. Verification also rejects missing or extra resources in the published closure. Original atlas bytes pin nested refs in the build's declared input; the existing tool/dependency identities record the packing implementation.

The shared publication/recovery/path rules above apply unchanged. Additional bounds are 8 MiB per original atlas manifest, 4096 declared canonical resource references (including repeated references), 4096 pixels per image axis, 4 megapixels per decoded canonical image and 16 megapixels of sprite sources per atlas. The existing distinct payload/manifest limits still apply. Full refs sort deterministically by content path and canonical metadata; dependency bytes deduplicate by path. Counters count actual distinct files, not upstream artwork evaluation. Retained older files support previous accepted manifests; only `result.files` is the active distribution allowlist.

Consumers admit the expected pinned manifest with `verifyAssetBundle`, then `readAssetBundleSpriteAtlas` reads only the selected original atlas and PNG, checking their pins. Complete canonical resources remain available for offline provenance/reconstruction evidence; normal playback does not load every source frame. `readAssetBundleAsset` also returns the selected original atlas bytes. Runtime owners retain playback, lifecycle, reduced motion and gameplay timing.

Run `bun examples/atlas-bundle/build.ts`, then `python examples/atlas-bundle/review.py`. The self-contained example builds the existing six authored puff/ring sequences and six PNG derivatives, cold-replays them, exports their selected closure and compares an independent package. It deletes the independent source store before verifying/loading all six pairs. Original recipe/build/PNG-encoder evidence remains in ignored `.artifacts/atlas-bundle/`. The independent Pillow inspection reads **only** the pinned package: PNG pixels match canonical atlas images, and all 36 frames reconstruct original alpha/visible RGB with source sizes/pivots and explicit timing intact. The source-versus-packed board is disposable visual evidence; invalid inspection removes it. Paths anchor to the script and unchanged files reconcile.

`bun test test/atlas-bundle.test.ts test/asset-bundle.test.ts test/sprite-atlas-operations.test.ts test/public-contract.test.ts` covers independent white-pixel and non-square trimmed/empty sparse-frame fixtures, stable paired ordering, source-store-free loading, retiming, cold/warm parity, invalid bounds/relationships/closure, missing/corrupt sources and outputs, bounded decoding and interrupted export/resume. Run the ordinary gate afterward. #125/#135 remain open for other profiles and actual product integration.
The [canonical adoption example](../examples/selected-bundle/README.md) adds a fresh installed-package consumer of a real ring-artwork recipe, with pixel acceptance, no producer-store dependency, repeat execution, and negative corruption/export/tool checks. Its generator uses the existing coding-tooling machinery.
