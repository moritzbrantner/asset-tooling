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

## Approved PNG profile

`APPROVED_IMAGE_BUNDLE_PROFILE` selects `approved-png-v1` ([#223](https://github.com/moritzbrantner/asset-tooling/issues/223), Atlas Decision 4.1.3). It uses `asset.bundle@3` (`APPROVED_IMAGE_BUNDLE_OPERATION`) through the same `createAssetBundleBuildIdentity`, `executeAssetBundleOperation`, `exportAssetBundle`, `verifyAssetBundle` and `readAssetBundleAsset` functions. Its manifest has the separate immutable [v3 transport schema](../schemas/asset-bundle-v3.schema.json). `asset.bundle@1`/`@2`, their profiles and the v1/v2 schemas are unchanged.

Generated images (for example `image.comfyui.generate@1` outputs) are **candidates**: plain stored `image/png` AssetRefs that claim nothing about approval. A human approves a candidate by naming its exact sha256 in the export selection. Exporting is the approval act; there is no approval manifest, review store or database. A regenerated image has new bytes, so an earlier approval never applies to it. Candidates that are not selected stay candidates and are not exported. Approval exists only inside an export: a preview cannot show "approved but not exported".

```ts
import { APPROVED_IMAGE_BUNDLE_PROFILE, exportAssetBundle,
  verifyAssetBundle, readAssetBundleAsset } from "asset-tooling/operations/bundle";

const exported = await exportAssetBundle(root, directory, {
  parameters: { profile: APPROVED_IMAGE_BUNDLE_PROFILE,
    assets: [{ key: "warden.ability.1", variant: "master", approved: { sha256: chosen.sha256 } }] },
  inputs: { assets: [chosen] },
});
const checked = await verifyAssetBundle(directory, exported.manifest,
  { profile: APPROVED_IMAGE_BUNDLE_PROFILE });
const png = await readAssetBundleAsset(directory, checked.manifest, "warden.ability.1", "master");
```

Each selection has exactly `key`, `variant` and `approved: { sha256 }`; the sha is 64 lowercase hex characters. `inputs.assets` pairs one `image`/`image/png` AssetRef with each selection, in selection order. A missing, malformed or extended approval is rejected. Before anything is read or written, every ref's sha256 must equal its selection's approved sha256; otherwise the call fails with an "approved" error. Every candidate's stored bytes must then exist and re-hash to the approved sha (and pass the PNG header/dimension checks); a missing or altered object is rejected. These checks precede any export-directory change: a fresh directory is not created and an existing export keeps every file, because `manifest.json` stays the sole commit point. Immediately before that commit, every payload is re-read without following symbolic links (a non-regular file or link is rejected) and re-hashed against its approval, so bytes replaced during export (for example by an `onArtifact` callback) fail the export. Any failure before the commit, including callback errors and cancellation, removes the payloads this call added, restores those it repaired and removes directories it created. A rejected approved export therefore leaves the directory as it was. Manifest source refs must be complete serialized AssetRefs; a missing `schemaVersion` or `metadata` is rejected.

The manifest is canonical JSON with `schemaVersion: 3`, `profile: "approved-png-v1"` and entries sorted by key, then variant. Each entry is `{ key, variant, approved: { sha256 }, source, path }`, where `source` is the full original AssetRef and `path` is `assets/<sha256>.png`. `parseApprovedImageBundleManifest` admits this shape and rejects an entry whose `approved.sha256` differs from `source.sha256`, so a forged approval fails parsing and verification. Verification must select the approved profile explicitly; the default static verification rejects an approved bundle, and the approved profile rejects static and atlas bundles. The shared limits, recovery, counters and `result.files` allowlist rules above apply unchanged. Build identity records the approved selection (including each sha) and inputs, so `executeAssetBundleOperation` and the export agree on the manifest.

`test/comfyui-approval-export.test.ts` runs candidate, approval, export and independent verification against the fake ComfyUI server, including mismatched, regenerated, missing and tampered candidates and a forged manifest. `test/comfyui-approval-local-server.test.ts` repeats the journey on a real local ComfyUI; it is skipped unless `ASSET_TOOLING_COMFYUI_URL` and `ASSET_TOOLING_COMFYUI_CHECKPOINT` are set.

### Approved Warden ability icons

The first committed `approved-png-v1` bundle is the Warden ability-icon set of [#211](https://github.com/moritzbrantner/asset-tooling/issues/211). On 2026-10-17 the owner picked four candidates of the current `warden.v3.flux2-klein-tight` set ("I pick warden.ability.1.candidate.flux2-klein-tight-01, warden.ability.2.candidate.flux2-klein-tight-01, warden.ability.3.candidate.flux2-klein-tight-01, warden.ability.4.candidate.flux2-klein-tight-02"). `review/warden-icons/export-selection.json` records that selection, the licence/attribution text and the derivation chains, and names the exact sha256 of every exported file. An earlier local export of three Stable Diffusion 1.5 candidates was never committed. This selection supersedes it, and none of those bytes are in the bundle.

| Path | Content |
|---|---|
| `review/warden-icons/approved/manifest.json` | plain-JSON `approved-png-v1` manifest (20 entries) |
| `review/warden-icons/approved/export.ref.json` | the manifest AssetRef that consumers pin |
| `review/warden-icons/approved/assets/<sha256>.png` | Git LFS payloads |

Keys are `warden.ability.1` (Heroic Strike), `.2` (Shield Bash), `.3` (Rallying Cry) and `.4` (Cleave), matching the MMORPG stable ability IDs. Each key has the variants `master` (the exact 1024 px FLUX.2 [klein] 4B candidate), `512`, `64`, `48` and `32`. The derivatives come from the master through `image.decode@1`, `image.resize@1` (bilinear 2× halving steps, plus one ¾ step for 48 px) and `image.encode.png@1` (compression level 9). Every entry's `source` AssetRef carries its provenance: the master has its ComfyUI generation record (model files and their Apache-2.0 licences, workflow, seed and prompt), and each derivative has its operation chain with input and output hashes. The images are original project-owned artwork. Attribution: "Generated with FLUX.2 [klein] 4B (Black Forest Labs, Apache-2.0) through ComfyUI."

`bun run warden:export` re-verifies the review folder, re-derives every variant and exports the bundle idempotently. A derivative whose bytes differ from the named sha256 (for example, from another FFmpeg build) fails before the bundle directory changes. `bun scripts/export-warden-icons.ts --check` exports to a disposable directory and compares the result with the committed manifest. `test/warden-icon-export.test.ts` verifies the committed bundle offline. The Warden review page shows the exported set above the candidates.

**Consuming the bundle (MMORPG #170/#171).** A consumer pins one asset-tooling commit and the manifest sha256 (`a59d54c4191a07de613769726ad1c41513f5256f0289281fb0b000e7fcdeddc5`, 53,124 bytes, recorded in `export.ref.json`). It then:

1. Checks out that commit beside itself and hydrates only the bundle with `git lfs pull --include="review/warden-icons/approved/**"`.
2. Admits the manifest with `verifyAssetBundle(dir, expectedRef, { profile: APPROVED_IMAGE_BUNDLE_PROFILE })` from `asset-tooling/operations/bundle`. `expectedRef` is the consumer's own pinned copy of `export.ref.json`; never trust the downloaded manifest by itself.
3. Reads the files it ships with `readAssetBundleAsset(dir, manifest, "warden.ability.<id>", "<variant>")`. Each read re-checks the file's pin.

The consumer then copies the selected PNGs and the manifest sha256 into its own packaged assets. The consumer does not need ComfyUI, MCP, a GPU, model weights or network access at game runtime.

## glTF resources profile

`GLTF_RESOURCES_BUNDLE_PROFILE` selects `gltf-resources-v1`, the versioned profile the owner chose on [#118](https://github.com/moritzbrantner/asset-tooling/issues/118) (decision Q4, 2026-10-14: "glTF with external images stored once by hash, plus the doorway/collision descriptor and collision assets"). The rigged humanoid with clips of [#110](https://github.com/moritzbrantner/asset-tooling/issues/110) uses the same profile. It is `asset.bundle@4` (`GLTF_RESOURCES_BUNDLE_OPERATION`) through the same `createAssetBundleBuildIdentity`, `executeAssetBundleOperation`, `exportAssetBundle` and `verifyAssetBundle` functions. Its manifest has the separate immutable [v4 transport schema](../schemas/asset-bundle-v4.schema.json). `asset.bundle@1`–`@3`, their profiles and the v1–v3 schemas are unchanged.

```ts
import { GLTF_RESOURCES_BUNDLE_PROFILE, exportAssetBundle, verifyAssetBundle,
  readAssetBundleGltf, readAssetBundleAttachment } from "asset-tooling/operations/bundle";

const exported = await exportAssetBundle(root, directory, {
  parameters: { profile: GLTF_RESOURCES_BUNDLE_PROFILE, assets: [
    { key: "building.house", variant: "default", attachments: [{ name: "doorways" }, { name: "collision" }] },
    { key: "character.ranger", variant: "composed" },
  ] },
  inputs: { assets: [houseGlb, rangerGlb], attachments: [doorwayDescriptorJson, collisionGlb] },
});
const checked = await verifyAssetBundle(directory, exported.manifest,
  { profile: GLTF_RESOURCES_BUNDLE_PROFILE });
const { gltf, resources } = await readAssetBundleGltf(directory, checked.manifest, "character.ranger", "composed");
// e.g. new NodeIO().readJSON({ json: JSON.parse(gltf.toString("utf8")), resources: Object.fromEntries(resources) })
```

**Selection.** There are 1–256 selections, each `{ key, variant, attachments?: [{ name }] }`. `inputs.assets` pairs one `scene`/`model/gltf-binary` AssetRef with each selection, in selection order. `inputs.attachments` lists one AssetRef per selected attachment, in selection order and then attachment order. Like the other profiles, AssetRefs travel as declared operation inputs rather than inside parameters, so build identity pins them. Attachment names are unique portable tokens per entry, with at most 16 per entry. Attachment media types are `application/json` (for example the doorway/collision descriptor) and `model/gltf-binary` (for example a collision mesh), and any asset kind is accepted. Build identity sorts selections by key/variant and attachments by name.

**Source admission.** Source GLBs may contain skins and animations. They are admitted with the `scene.import.gltf@2` loader (`parseCheckedGltfBytes` in rigged mode). That loader applies the Khronos validator, the one-buffer/no-extension/triangle policy, the accessor budget and the `gltf-weight-sum-tolerance-v1` check. Resources must be embedded. The allowed validator warnings are fixed for the whole profile: `NODE_SKINNED_MESH_NON_ROOT` and `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` (`GLTF_RESOURCES_BUNDLE_ALLOWED_VALIDATOR_WARNINGS`). They are recorded in the build identity's implementation policy and in the manifest's `policy`. JSON attachments must parse, and GLB attachments must pass the validator without errors.

**Export layout.** Each GLB becomes `scenes/<key>/<variant>.gltf`: canonical glTF JSON whose buffers and images are external URIs `../../resources/<sha256>.<bin|png|jpg|webp|ktx2>`, chosen by media type. Images are split out of their bufferViews. The remaining bufferViews are copied byte-for-byte into one `.bin` per scene, so geometry, skin and animation bytes are unchanged. Each view keeps its offset's 4-byte phase, so accessor alignment holds. Every distinct resource payload is stored once under `resources/`: two characters that share a texture reference the same file. Attachments are stored as `attachments/<sha256>.<json|glb>`. Before anything is written, each exported `.gltf` is validated with exactly its external resources (no errors, only the profile's warnings) and loaded with glTF Transform.

**Manifest.** It is canonical JSON with `schemaVersion: 4`, `profile: "gltf-resources-v1"`, `policy: { allowedValidatorWarnings }` and `assets` sorted by key, then variant. Each entry has these fields:

- `key` and `variant`.
- `source`: the full original GLB AssetRef.
- `path`: the `.gltf` path.
- `sha256`: the hash of the `.gltf` bytes.
- `resources`: `{ uri, path, sha256, byteLength, mediaType }`, sorted by path.
- `attachments`: `{ name, source, path, sha256, byteLength, mediaType }`, sorted by name. `source` keeps the attachment's provenance.
- `observations`: `{ skins, animations: [names], triangles }`.

`parseGltfResourcesBundleManifest` admits this shape. It checks path and URI against content identity, the policy, the sort orders and the budgets.

**Recovery.** The shared export rules above apply, with one addition. Scene paths are logical rather than content-addressed, so the exporter writes all resources and attachments first and the scene files last, immediately before `manifest.json`, which is still the sole commit point. If a cancellation, callback error or other failure happens before that commit, the exporter restores every scene file the call replaced and removes every scene file it added. The previously accepted manifest therefore keeps verifying. Resume reuses completed files. `result.files` is the active distribution allowlist; `listAssetBundleFiles(manifest)` derives the same set from a manifest.

**Verification and reading.** `verifyAssetBundle(dir, expectedRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE })` performs these checks:

- It verifies the manifest pin.
- It re-hashes every `.gltf`, resource and attachment, without following symbolic links.
- It enforces closure: every buffer/image URI in each `.gltf` is a listed resource, and every listed resource is referenced.
- It validates each `.gltf` with its resources, loads it, re-checks weight sums and compares the recomputed observations with the manifest.

No source object store is needed. The default and other profiles reject a v4 bundle. `readAssetBundleGltf(dir, manifest, key, variant)` returns `{ gltf, resources }`, with resources keyed by the exact URI the glTF uses, after re-checking every pin and the entry's closure. `readAssetBundleAttachment(dir, manifest, key, variant, name)` reads one attachment. `readAssetBundleAsset` returns the `.gltf` bytes.

Limits are 1–256 selections, 64 MiB per source GLB, resource or attachment, 1,024 resources per scene, 16 attachments per entry, 8 MiB per `.gltf`, JSON attachment and manifest, and 256 MiB of distinct payload bytes.

### Release distribution and consumer pinning

Owner decision Q5 on #118 distributes the bundle as a versioned GitHub Release. `bun scripts/pack-asset-bundle.ts <exportDir> <outFile.tar>` first verifies the export, then writes a deterministic ustar archive and `<outFile.tar>.sha256` in `sha256sum` format. The archive holds exactly `manifest.json`, its closure and `export.ref.json`, the content-only manifest AssetRef. Entries are sorted, regular files only, with mode 0644, uid/gid 0, empty owner names and mtime 0. Retained former export files are never shipped. Two independent exports of the same selection pack to identical bytes. `bun scripts/pack-asset-bundle.ts --verify <file.tar> [--ref <pinned export.ref.json>]` performs these checks:

- It checks the `.sha256` pin.
- It parses the tar strictly: header checksums, zero padding and sorted unique paths.
- It requires exactly the closure plus `export.ref.json`.
- It runs `verifyAssetBundle` on an extracted copy.

The packing helpers are `packAssetBundle`, `verifyAssetBundleTar` and `readAssetBundleTar` in `src/asset-bundle-pack.ts`. Nothing touches the network. Publishing (`gh release create <tag> bundle.tar bundle.tar.sha256`) is a separate, explicit orchestrator step.

A consumer pins three things: the release **tag**, the **tar sha256** and its own copy of **`export.ref.json`** (the manifest sha256 and byte length). It then:

1. Downloads the tar from that tag and checks the tar sha256 before extracting.
2. Extracts the tar and admits the manifest with `verifyAssetBundle(dir, pinnedRef, { profile: GLTF_RESOURCES_BUNDLE_PROFILE })`, or runs `--verify --ref` with its pinned copy. The consumer never trusts the downloaded `export.ref.json` by itself.
3. Loads scenes with `readAssetBundleGltf` and attachments with `readAssetBundleAttachment`.

No source store, Blender, GPU or network is needed after the download.

`bun test test/gltf-resources-bundle.test.ts` covers the following with hand-authored skinned and animated fixtures:

- Two entries that share one PNG stored once.
- Byte-identical accessors.
- Attachments.
- Closure tampering, observation/policy/path forgery, corruption and missing files.
- Incompatible selections rejected before any write.
- Interrupted and failed export with resume.
- Loading with the source store deleted.
- The deterministic tar and its CLI.

Its real-source test runs in the hosted `canonical-storage` job. It skips on Git LFS pointers unless `ASSET_TOOLING_REQUIRE_HYDRATED_STORAGE=1`. The test imports the Superhero body and the Male_Ranger outfit through `scene.import.gltf@2`, subsets the body with the [documented recipe](gltf-subset.md) and composes the two with `scene.compose.skinned.gltf@1`. It then bundles and verifies the composed Ranger with its source store deleted, and packs and verifies the tar.

## Audio WAV profile

`AUDIO_BUNDLE_PROFILE` selects `audio-wav-v1`, `asset.bundle@5` (`AUDIO_BUNDLE_OPERATION`), added for the [combat sounds](combat-sounds.md) of #297. It uses the same `exportAssetBundle`, `verifyAssetBundle(dir, ref, { profile: AUDIO_BUNDLE_PROFILE })`, `readAssetBundleAsset` and tar helpers as the other profiles. Its manifest follows the [v5 schema](../schemas/asset-bundle-v5.schema.json) and has the static profile's shape: `schemaVersion: 5`, the profile, and `assets` of `{ key, variant, source, path }`, sorted by key and then variant.

- **Selection.** Each selection is `{ key, variant }`, paired in order with one `inputs.assets` AssetRef. A source is either a canonical audio AssetRef (`audio`/`audio/wav`, see [audio.md](audio.md#canonical-audio-v1)) or any-kind `application/json` of at most 8 MiB, such as a descriptor or a runtime sound manifest.
- **Layout.** Each payload is stored once at `assets/<sha256>.wav` or `assets/<sha256>.json`.
- **Verification.** Every file is re-hashed. Every WAV is re-checked against its AssetRef's canonical audio metadata: PCM-16, rate, channels, frame count and the canonical 44-byte layout. JSON must parse. The other profiles reject a v5 manifest.

The limits are the static profile's.
