# Selected static asset packages

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

Limits are 1–256 selections, 64 MiB per payload, 256 MiB total distinct payload bytes and 8 MiB for the manifest. PNG dimensions are 1–4096 in each axis. These caps are checked before writes; no budget implies permission for hidden dependencies or new processing. The profile validates actual static GLB resources and supported semantics before reuse.

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
