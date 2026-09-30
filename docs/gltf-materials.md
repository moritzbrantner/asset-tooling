# Static GLB base-color finishing

`asset-tooling/operations/processing/gltf-material` supplies `scene.material.base-color@1`, the first applied-material slice for #132. It uses the existing static glTF importer, glTF Transform, Khronos validator and content-addressed store. It applies an existing PNG AssetRef to one uniquely named native material; it introduces no material representation or geometry generator.

```ts
import { executeGltfBaseColorOperation } from "asset-tooling/operations/processing/gltf-material";

const result = await executeGltfBaseColorOperation(objectStoreRoot, {
  inputs: { source: masterGlb, "base-color": encodedColorPng },
  parameters: {
    materialName: "rock-surface", baseColorFactor: [1, 1, 1, 1], texCoord: 0,
    sampler: { magFilter: "linear", minFilter: "linear", wrapS: "repeat", wrapT: "repeat" },
    alpha: { mode: "OPAQUE" },
  },
});
```

The root is an explicit absolute object-store path. Source is a self-contained static core-glTF GLB mesh/scene, validated through the existing importer; extensions, external dependencies, rigs, clips and morph targets remain outside this operation's profile. Both input blobs are verified by their content hash and length. The PNG must have actual header dimensions in 1–4096 and encoded bytes within 64 MiB. Khronos validates the completed self-contained GLB before any derived blob is stored.

Every parameter is required and unknown fields fail. Material names contain 1–256 JavaScript characters and must identify exactly one existing material used by at least one primitive. Every primitive using it must provide the declared UV set (integer 0–7). The operation does not invent UVs, tangents, normals or other maps. Base-color factor has four finite coordinates in 0–1. PNG base color uses native glTF sRGB sampling; the multiplier is the native linear RGBA factor.

Magnification/minification filters are nearest or linear; this slice does not generate mipmaps or claim mip-safe sampling. Each axis explicitly uses repeat, mirrored-repeat or clamp-to-edge. Alpha is `{ mode: "OPAQUE" }`, `{ mode: "BLEND" }`, or `{ mode: "MASK", cutoff: 0..1 }`. Opaque rendering ignores base-color alpha according to glTF; mask/blend use the PNG alpha and factor. Consumer transparency ordering remains the renderer's responsibility.

Only the selected material's base-color texture/factor, sampler/UV selection and declared alpha policy change. Geometry attribute values/types, index topology, hierarchy/transforms, unrelated materials and other PBR channels/settings remain intact. Shared materials apply to all their referencing primitives; name selection never silently clones a material for only one mesh. A byte-identical existing embedded PNG is reused, with sampler state local to the selected material's TextureInfo. Replaced images are not globally pruned, because unrelated source resource ownership remains intact. This is finishing, not resource optimization.

`createGltfBaseColorOperationBuildIdentity` records the descriptor, normalized parameters, original source and PNG refs, glTF Transform/validator versions, dependency-lock hash and tool source fingerprint. The derived GLB keeps source kind and carries both source hashes; observations record affected primitives, texture dimensions/bytes and geometry/resource counts. Both build validation and execution verify inputs. Invocation always replays the native writer, and identical stored blobs reconcile without rewriting. Canonical replay must be demonstrated by comparing outputs, not inferred from the build identity.

## Existing PNG codec compatibility

The actual procedural surface example exposed a zero:one PNG `pHYs` pixel aspect emitted by FFmpeg's unspecified raw-video sample aspect. Browsers displayed the pixels, but Khronos correctly rejected the image for glTF embedding. The existing `image.encode.png@1` now explicitly sets square pixels through FFmpeg. Its compatible public inputs/result schema remain unchanged; the encoder implementation is version 2 with algorithm `ffmpeg-rgba8-square-pixel-png-image2pipe-v2`, and tool provenance distinguishes earlier encoding. This changes PNG metadata/content hashes; independently decoded RGBA bytes remain identical. Existing PNGs are not silently rewritten. Re-encode desired canonical sources explicitly. Codec subprocesses and version probes have a 30-second bound.

## Actual rock family

First generate the neutral masters with `bun examples/rocks/build.ts`, then run `bun examples/rock-materials/build.ts`. The latter reads the four existing master AssetRefs; it invokes zero geometry generators. Existing surface recipes and PNG encoding create gray/warm color maps, and the existing PBR bundle operation records their canonical base-color references. Eight finished GLBs share two declared PNG identities. Each derivation is compared with an independent cold object store; decoded geometry/UV/normal/index arrays match its master exactly, and master object mtimes remain unchanged. Stable refs, builds, results and resource/byte evidence live under ignored `.artifacts/rock-materials/` and reconcile on repeat.

For artifact inspection, run the existing `scripts/render-rock-family.py` through pinned Blender on `.artifacts/rock-materials/gray` and `/warm`. Its explicit `review-inputs.json` supports derived GLBs without pretending an operation result is a generation spec. `python scripts/rock-material-review.py` composes both actual four-rock renders under one camera/light setup. The appearance evidence covers these finished artifacts; it does not claim Zoo or second-consumer camera acceptance. Consumer repositories remain read-only.

Tests use a manually packed independent GLB/PNG fixture to verify accessor values/types, winding/index order, UV/tangent coverage, transforms, unrelated PBR channels and per-material sampler isolation. Cold/warm material edits, output reconciliation, invalid controls/names/UV coverage, corrupt input refs and original source integrity are covered. The existing PNG fixture verifies positive square aspect and exact RGBA round-trip. Run the focused glTF/material/codec suites, then `bun run check`.

This advances #132/#131 and leaves them open. Applying full existing PBR bundles (including declared normal-Y/ORM semantics), runtime texture/LOD/package variants and actual Zoo/second-game integration remain separate work through #124/#125 and the consumer owners.
