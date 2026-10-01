# Apply existing PBR sets to static GLBs

`asset-tooling/operations/processing/gltf-pbr` exposes `scene.material.pbr@1`. It applies the existing `material.pbr.bundle@1` reference document and its three canonical source maps to one named native material. It reuses glTF Transform, Khronos validation, the PNG codec, channel processors and the content-addressed store. It creates no parallel material format or geometry algorithm.

```ts
import { executeGltfPbrMaterialOperation } from "asset-tooling/operations/processing/gltf-pbr";

const result = await executeGltfPbrMaterialOperation(absoluteObjectStoreRoot, {
  inputs: { source: staticMasterGlb, material: acceptedPbrBundle,
    "base-color": canonicalColor, normal: canonicalNormal, orm: canonicalLinearOrm },
  parameters: {
    materialName: "rock-surface", baseColorFactor: [1, 1, 1, 1], texCoord: 0,
    sampler: { magFilter: "linear", minFilter: "linear", wrapS: "repeat", wrapT: "repeat" },
    alpha: { mode: "OPAQUE" }, normalScale: 1, metallicFactor: 1,
    roughnessFactor: 1, occlusionStrength: 1,
  },
  runtime: { ffmpeg: "/absolute/path/to/ffmpeg", ffprobe: "/absolute/path/to/ffprobe" },
});
```

This first finishing profile requires all three maps. The existing general PBR bundle still accepts subsets; a partial bundle is diagnosed before this operation writes. Input AssetRefs must exactly match the bundle's hashes, byte lengths and container types. `parsePbrMaterialDocument` admits the existing v1 shape, requires conventions to correspond to its map references and rejects unknown channel interpretations. Source bytes, bundle and maps are verified before PNG conversion or new objects are stored.

Base color uses sRGB sampling. Tangent-space normal XYZ and ORM are data. Negative-Y normal input becomes positive-Y by composing existing channel extraction, inversion convolution and recombination: only green changes from G to 255−G. Positive-Y input passes unchanged. Original source pixels remain intact. Both data maps must be opaque. The operation assigns one ORM image to native occlusion and metallic/roughness slots: red AO, green roughness, blue metallic. It never invents those values from unrelated noise or color. Explicit native factors multiply their corresponding texture channels.

The PNG encoder's compatible `image.encode.png@1` port now also admits the existing canonical linear RGBA8 container. Its implementation version 3 encodes both container types without a transfer: raw data values are never gamma-adjusted. `sourceColorSpace` and the source hash accompany PNG refs. The unchanged standard decode operation returns its existing sRGB container; consumers retain channel sampling meaning from the material contract. Square pixel aspect and bounded FFmpeg probes/processes remain enforced.

The selected material must be unique, used by geometry, covered by UV0 and supplied with authored normals **and tangents**. This first profile requires `texCoord: 0` and authored tangents corresponding to UV0; an existing selected normal texture on another UV set is rejected. The finisher rejects missing tangents instead of silently relying on renderer generation. The existing rock authoring recipe now asks Blender's bundled exporter for tangents. Source geometry, winding, normals and UVs remain the same when compared by triangle corners; additional tangent attributes and exporter seams receive a new declared script/source identity. Existing master objects are never rewritten in place.

Only the selected material's declared base-color, normal, metallic/roughness, occlusion, factors, alpha and sampler settings change. Geometry attributes and indices, node transforms/hierarchy, other materials, emission and double-sided settings remain intact. TextureInfo sampler state remains local to its slot. Byte-identical PNG images are shared across compatible roles; the two ORM slots always use one image. Unrelated/replaced original resources are retained rather than globally pruned.

All parameters are explicit. Normal scale is finite in 0–8; factors/occlusion strength are 0–1; material name, sampler and alpha follow the existing base-color contract. Supported sources are contained, static, core-glTF GLBs; rigs, clips, morphs, unsupported extensions and external resources fail through the existing importer. Caps precede decoding: source 64 MiB, bundle 8 MiB, canonical map 128 MiB, dimensions 1–4096, and 16,777,216 total declared map pixels. The existing raw accessor budget runs before native validator scans/densification.

Build identity includes every original input, normalized control, glTF/validator version, dependency lock, exact codec probe and authored-tool identity. Results retain source/bundle/map lineage and include three actual PNG encodes, native image additions/reuses, selected unique PNG encoded/decoded RGBA8 byte estimates, source-channel bytes and geometry/resource counts. Decoded estimates describe PNG pixel storage, not measured GPU memory; retained source resources and renderer allocations remain separate. Every invocation replays encoding/writing; this is not a new computation cache. Identical stored blobs and example files reconcile without rewrites.

## Actual rock example

Run the existing rock and surface examples first, then:

```bash
ASSET_TOOLING_BLENDER=/absolute/path/to/blender bun examples/rocks/build.ts
bun examples/surface-textures/build.ts
bun examples/rock-pbr/build.ts
```

The maintained example reads explicit saved master and surface inventories, builds grainy/layered sets, uses declared neutral unoccluded AO and dielectric metallic constants, and derives eight GLBs. Material finishing runs zero geometry generators. Each output is compared with a separate cold object store and its master attributes. Both sets package through `static-glb-png-v1` and undergo non-mutating package verification. The example records source refs, builds/results, map PNGs, resource counts and package evidence under ignored `.artifacts/rock-pbr/`.

Use the existing `scripts/render-rock-family.py` for each set, then `python scripts/rock-pbr-review.py` to compare their actual fixed-view native renders with the base-color example. This is artifact inspection, not game/browser camera acceptance. The ordinary fixture independently authors GLB geometry and compares decoded map bytes, preserved attributes/hierarchy, shared image/ORM semantics, unchanged files, cold replay and invalid dependencies/controls. A roughness-only edit keeps base-color/normal PNG identities and mtimes, changes the declared ORM/bundle, and matches an independent cold result. Reapplying the same set to an already finished source reuses all three native images and reproduces the same GLB bytes. The Blender rock lane additionally checks finite, unit, orthogonal tangent frames and exact generation replay.

This materially advances #124/#131/#132. Character materials, resolution/mip/alpha variants, compressed decoder paths, consumer-camera approval and real game integration remain open. No consumer repository is changed.
