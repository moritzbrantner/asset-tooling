# glTF texture resizing

`scene.textures.resize.gltf@1`, exported by `asset-tooling/operations/processing/gltf-texture-resize`, reduces the embedded textures of one GLB to game resolutions for browser delivery. It serves [#257](https://github.com/moritzbrantner/asset-tooling/issues/257). Only the image bytes change, and with them the image dimensions. Nodes, meshes, accessors, UVs, skins, animations, materials, samplers and texture references stay as they are, so the asset keeps its logical identity.

```ts
import {
  GLTF_TEXTURE_RESIZE_OPERATION,
  createGltfTextureResizeOperationBuildIdentity,
  executeGltfTextureResizeOperation,
} from "asset-tooling/operations/processing/gltf-texture-resize";

const invocation = {
  inputs: { source: characterGlb },
  parameters: {
    maxEdgeBySlot: { baseColor: 1024, normal: 1024, metallicRoughness: 512, occlusion: 512, emissive: 1024 },
    default: 1024,
    policy: { allowedValidatorWarnings: ["NODE_SKINNED_MESH_NON_ROOT", "MESH_PRIMITIVE_GENERATED_TANGENT_SPACE"] },
  },
};
const result = await executeGltfTextureResizeOperation(objectStoreRoot, invocation);
```

## Parameters and behaviour

- `source` is one self-contained GLB, static or skinned, as `scene.import.gltf@2` produces it. The output is one GLB.
- `maxEdgeBySlot` gives the longest allowed edge, in pixels, for each core material slot: `baseColor`, `normal`, `metallicRoughness`, `occlusion` and `emissive`. `default` (required) applies to an omitted slot and to textures that no core slot uses, such as extension textures. Every limit is an integer in 1..8192, and unknown slots or parameters fail.
- `policy.allowedValidatorWarnings` allows the same two exceptions as `scene.import.gltf@2`. The source and the output are both validated under that policy.
- An image larger than its limit is scaled so its longest edge equals the limit. The other edge is rounded, and is at least 1 px. An image that already fits is kept byte for byte, so nothing is ever upscaled.
- **Shared images:** textures are grouped by the SHA-256 of their image bytes. Each group is resampled and encoded once, with the largest limit of the slots that use it, and every texture of the group gets the same new bytes. The texture and image count does not change. One image used both as colour and as data (or as a normal map) fails with `TEXTURE_RESIZE_MIXED_ENCODING`.
- **Filter:** `area-average-float32-v1` is a separable area (box) average with float accumulation.
  - `baseColor` and `emissive` are sRGB colour. Texels are averaged in linear light, premultiplied by alpha, and written back as straight-alpha sRGB.
  - `metallicRoughness` and `occlusion` are linear data. The stored values are averaged as they are.
  - `normal` texels are decoded to vectors in [-1, 1], averaged and renormalized, so the maps do not wash out toward flat. A zero average becomes +Z. The tangent-space axes and their signs are unchanged.
  - Alpha is averaged linearly in every mode.
- **Codec:** decoding uses `image.decode@1` and encoding uses `image.encode.png@1` at compression level 9 (the pinned ffmpeg codec). The output is always PNG, which needs no KTX2 or WebP extension in three.js, native wgpu or any other glTF consumer.

The build identity records the normalized parameters, the filter, the decode and encode implementations, the PNG compression level, the glTF Transform and validator versions and the dependency lock.

## Evidence

The observations report:

- `textures`: each texture's index, name, slots, limit and source image SHA-256;
- `images`: each distinct image with the textures that share it, its slots, its encoding (`srgb`, `linear` or `normal`), its limit, `resized`, and `before` and `after`, each with `sha256`, `byteLength`, `mimeType`, `width` and `height`;
- `uniqueImages`, `resizedImages`, `imageDecodes` and `pngEncodes`;
- `imageBytes.before` and `imageBytes.after`, summed over the distinct images;
- the source and output summaries and byte lengths, and the accepted validator warnings of the source and of the output.

## Tests

`bun test test/gltf-texture-resize-operations.test.ts` uses a small hand-authored GLB. It covers:

- the per-slot limits;
- never upscaling;
- one shared image resampled once and written to both textures;
- linear-light colour averaging (a black and white checker becomes sRGB 188, not 128);
- renormalized normals (alternating ±X normals tilted by 45° average to +Z at unit length);
- unchanged nodes, meshes, materials, textures, samplers and accessor bytes;
- the output importing under `scene.import.gltf@2`;
- identical output bytes from two object stores;
- parameter failures.

The Ranger bundle v3 ([humanoid-ranger.md](humanoid-ranger.md)) is the first consumer.
