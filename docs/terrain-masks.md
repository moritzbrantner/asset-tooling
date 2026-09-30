# Saved masks for heightfield edits

`asset-tooling/operations/image/terrain` exposes `image.height.mask-flatten@1` alongside the existing terrace and radial-height operations. It consumes two verified image AssetRefs: an opaque grayscale RGBA8 height source and an independently saved same-grid mask. It stores the edited height field through the existing content-addressed object store. The source, mask and existing terrain descriptors remain unchanged.

```ts
import {
  createHeightMaskFlattenOperationBuildIdentity,
  executeHeightMaskFlattenOperation,
} from "asset-tooling/operations/image/terrain";

const invocation = {
  parameters: { targetHeight: 128, channel: "scalar" },
  inputs: { source: heightRef, mask: savedMaskRef },
};
const build = await createHeightMaskFlattenOperationBuildIdentity(absoluteRoot, invocation);
const result = await executeHeightMaskFlattenOperation(absoluteRoot, invocation);
```

Both inputs use `RGBA8_IMAGE_MEDIA_TYPE` from `asset-tooling/image/rgba8` (`application/vnd.moritzbrantner.rgba8+json`). Each must fit 512 KiB encoded bytes, have dimensions in 1–256, and share exactly the same width and height. `targetHeight` is an integer in 0–255. `channel: "scalar"` requires opaque grayscale mask pixels; `channel: "alpha"` reads straight alpha and ignores mask RGB. There are no default controls, implicit resizing or hidden coordinate transforms. Apply an explicit image transform before using a differently sized guide.

Each mask sample corresponds to the height sample at the same row and column. Heights and weights are scalar Q8 bytes; the image transport's color-space field does not apply gamma correction. The integer blend is `floor(((255 - weight) * source + weight * targetHeight + 127) / 255)`. Weight zero preserves the original sample exactly, weight 255 sets the target exactly, and intermediate values round to the nearest integer. Output RGB repeats the height and alpha is 255. No seed or ambient random state participates.

Both public calls verify actual source/mask hashes and byte lengths, dimensions and sample format before producing an output. The canonical build identity includes both full input refs, normalized controls, algorithm and tool identity. Output lineage retains both content hashes. Observations count zero/full/partial weights and samples whose height changed. Repeating an edit reconciles an identical object without rewriting it; a fresh store containing only the declared inputs reproduces the same bytes. Generation-cache state is unnecessary.

## Executable footprint example

Run `ASSET_TOOLING_BLENDER=/absolute/path/to/blender bun examples/terrain-mask/build.ts` with the repository's pinned Blender release and FFmpeg available. Source paths are anchored to the example directory, independent of the caller's working directory. All generated outputs and receipts stay under ignored `.artifacts/terrain-mask/`.

The versioned `recipe.json` declares the existing seeded noise-height controls, mask path/hash, flatten controls, mesh scale and sample-to-world mapping. `footprint.rgba8.json` is an independently authored 32×24 guide: five full-weight columns form a level strip, with one half-weight column on each side. Its remaining samples are zero. The example uses the existing tileable height generator and heightfield OBJ operation; it adds no terrain noise or mesh kernel.

The first sample is declared at `[-16, 0, -12]` meters in right-handed Y-up coordinates; columns advance +X and rows advance +Z. With one-meter cells, 32×24 vertex samples span 31×23 meters. The existing centered OBJ receives world translation `[-0.5, 0, -0.5]` to implement that placement. `targetHeight: 128` with `heightScale: 8` produces a four-meter local/world height under the existing heightfield quantization. The example records this translation instead of changing the published mesh convention.

The runner compares edited height bytes with a separate store replay, checks every zero/full-weight sample, verifies unchanged OBJ topology and unmasked vertices, and measures the fully flattened vertex height. It writes height/mask PNGs through the existing codec. An example-only native Blender OBJ import/GLB export creates neutral review derivatives from the pinned OBJ bytes; the packaged static-GLB renderer generates before/after thumbnails. Both stages use ordinary generation receipts and independent backend verification. Their declared reproducibility is approximate; matching replay bytes describe the observed local environment. They do not establish a portable exact render contract. The canonical geometry remains the original content-addressed OBJ.

Run `python scripts/review-terrain-mask.py .artifacts/terrain-mask` to assemble the actual height/mask images and rendered meshes into a review board using Pillow. The board is evidence for this local footprint edit, not consumer terrain, physics, aesthetic or camera acceptance.

Tests cover independent arithmetic fixtures, scalar/alpha equivalence, non-square marked-pixel correspondence, zero/full endpoints, the maximum supported grid, source non-mutation, cold replay, idempotence, and rejection of bad controls, sample formats, dimensions, oversized payloads and corrupt pins before output writes. Run `bun test test/terrain-mask-operations.test.ts test/terrain-operations.test.ts test/procedural-mesh.test.ts`, then `bun run check`.

This bounded slice advances #134/#140. World-coordinate noise with adjacent-patch seam evidence, stable terrain/cosmetic scatter families, polyline-to-mask authoring, preserved workbench guides and actual consumer-camera acceptance remain separate follow-ups. It does not close either issue.
